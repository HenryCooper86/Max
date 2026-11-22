import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_STUDIO } from "../shared/cloud-studio";
import { LanguageProvider } from "../src/components/LanguageToggle";
import type { Project, ProjectFlow } from "../src/console/api";
import { FlowTab, projectFlowApi } from "../src/console/studio/FlowTab";
import { draftFromProject, type StudioTabProps } from "../src/console/studio/types";
import type { FlowStep } from "../src/lib/flow";

const STEPS: FlowStep[] = [
  { id: "main", handoffs: [{ to: "refunds", when: "Money back." }] },
  { id: "refunds", description: "Refunds.", instructions: "Refund politely.", tools: ["check_order"] }
];
const FLOW: ProjectFlow = { ok: true, steps: STEPS, tools: ["check_order"], problems: [] };

function projectWith(studio: Partial<Project["studio"]> = {}): Project {
  return { id: "p1", name: "Shop", studio: { ...structuredClone(DEFAULT_STUDIO), ...studio } } as unknown as Project;
}

describe("the flow builder's calls for a project", () => {
  it("loads the project's flow with the login as it is at the time", async () => {
    const projectFlow = vi.fn(async () => FLOW);
    let token = "first";
    const api = projectFlowApi("p1", () => ({
      session: { api: { projectFlow } as never, token, fail: () => "" },
      updateStudio: () => undefined,
      onProjectChanged: () => undefined
    }));
    expect(await api.fetchStudioFlow()).toEqual({ ok: true, data: FLOW });
    token = "second";
    await api.fetchStudioFlow();
    expect(projectFlow.mock.calls).toEqual([
      ["first", "p1"],
      ["second", "p1"]
    ]);
  });

  it("saves the flow, and gives the Studio the project as it now is", async () => {
    const saved = projectWith({ flow: STEPS as never });
    const saveProjectFlow = vi.fn(async () => ({ ...FLOW, project: saved }));
    const updateStudio = vi.fn();
    const onProjectChanged = vi.fn();
    const api = projectFlowApi("p1", () => ({
      session: { api: { saveProjectFlow } as never, token: "t", fail: () => "" },
      updateStudio,
      onProjectChanged
    }));
    expect(await api.saveStudioFlow(STEPS)).toEqual({ ok: true, data: FLOW });
    expect(saveProjectFlow).toHaveBeenCalledWith("t", "p1", STEPS);
    expect(onProjectChanged).toHaveBeenCalledWith(saved);
    // The Studio's unsaved draft takes the flow too: its own Save sends every setting.
    expect(updateStudio).toHaveBeenCalledWith({ flow: STEPS });
  });

  it("says why a flow was not saved, and leaves the Studio as it was", async () => {
    const refused = new Error("refunds: when the conversation is handed to it it calls find_order");
    const updateStudio = vi.fn();
    const onProjectChanged = vi.fn();
    const api = projectFlowApi("p1", () => ({
      session: {
        api: {
          saveProjectFlow: vi.fn(async () => Promise.reject(refused)),
          projectFlow: vi.fn(async () => Promise.reject(refused))
        } as never,
        token: "t",
        fail: (error) => (error as Error).message
      },
      updateStudio,
      onProjectChanged
    }));
    expect(await api.saveStudioFlow(STEPS)).toEqual({
      ok: false,
      error: { kind: "invalid", message: refused.message }
    });
    expect(await api.fetchStudioFlow()).toMatchObject({ ok: false, error: { message: refused.message } });
    expect(updateStudio).not.toHaveBeenCalled();
    expect(onProjectChanged).not.toHaveBeenCalled();
  });
});

describe("FlowTab", () => {
  function render(project: Project, draftStudio: Partial<Project["studio"]> = {}) {
    const draft = draftFromProject(project);
    const props = {
      session: { api: {}, token: "t", fail: () => "" },
      project,
      draft: { ...draft, studio: { ...draft.studio, ...draftStudio } },
      update: () => undefined,
      updateStudio: () => undefined,
      dirty: false,
      save: async () => true,
      origin: "https://relay.example.com",
      goTo: () => undefined,
      onProjectChanged: () => undefined
    } as unknown as StudioTabProps;
    return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(FlowTab, props)));
  }

  it("says what a flow is for, and that it is saved on its own", () => {
    const html = render(projectWith());
    expect(html).toMatch(/保存流程|Save flow/);
    expect(html).not.toMatch(/已保存的工具|tools that are saved/);
  });

  it("says so when the tools a step could use are not saved yet", () => {
    const tool = {
      name: "check_order",
      description: "Look an order up.",
      url: "https://api.example.com/o",
      parameters: []
    };
    const html = render(projectWith(), { tools: [tool] });
    expect(html).toMatch(/已保存的工具|tools that are saved/);
  });
});
