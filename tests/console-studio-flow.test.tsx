import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_STUDIO } from "../shared/cloud-studio";
import { LanguageProvider } from "../src/components/LanguageToggle";
import type { Project } from "../src/console/api";
import { FlowTab, projectFlowApi } from "../src/console/studio/FlowTab";
import { draftFromProject, type StudioTabProps } from "../src/console/studio/types";
import type { FlowStep } from "../src/lib/flow";

const STEPS: FlowStep[] = [
  { id: "main", handoffs: [{ to: "refunds", when: "Money back." }] },
  { id: "refunds", description: "Refunds.", instructions: "Refund politely.", tools: ["check_order"] }
];

function projectWith(studio: Partial<Project["studio"]> = {}): Project {
  return { id: "p1", name: "Shop", studio: { ...structuredClone(DEFAULT_STUDIO), ...studio } } as unknown as Project;
}

describe("the draft flow builder", () => {
  it("loads the draft steps and offers tools from the draft", async () => {
    const tool = { name: "check_order", description: "Look up", url: "https://example.com", parameters: [] };
    const draft = draftFromProject(projectWith({ flow: STEPS, tools: [tool] }));
    const api = projectFlowApi(() => ({ draft, updateStudio: vi.fn() }));
    expect(await api.fetchStudioFlow()).toMatchObject({ ok: true, data: { steps: STEPS, tools: ["check_order"] } });
  });

  it("applies a flow to the editor without writing to the server", async () => {
    const draft = draftFromProject(projectWith());
    const updateStudio = vi.fn();
    const api = projectFlowApi(() => ({ draft, updateStudio }));
    expect(await api.fetchStudioFlow()).toMatchObject({ data: { steps: [{ id: "main" }] } });
    expect(await api.saveStudioFlow(STEPS)).toMatchObject({ ok: true, data: { steps: STEPS } });
    expect(updateStudio).toHaveBeenCalledWith({ flow: STEPS });
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

  it("explains applying a flow to the draft", () => {
    expect(render(projectWith())).toMatch(/应用到草稿|Apply your flow to the draft/);
  });
});
