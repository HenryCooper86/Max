// @vitest-environment happy-dom
// The analysis settings form of the Max Cloud console, as a person uses it.
import { createElement, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ANALYSIS, DEFAULT_STUDIO, type StudioAnalysis } from "../shared/cloud-studio";
import { LanguageProvider } from "../src/components/LanguageToggle";
import type { Project, ProjectStudio } from "../src/console/api";
import { AnalysisSetting, parseOptions } from "../src/console/studio/AnalysisSetting";
import { draftFromProject, type StudioTabProps } from "../src/console/studio/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

/** The form over a draft that it changes itself, as the Studio holds it. */
async function form(analysis: Partial<StudioAnalysis>) {
  const project = {
    id: "p1",
    name: "Demo",
    backend: "openai",
    studio: { ...structuredClone(DEFAULT_STUDIO), analysis: { ...DEFAULT_ANALYSIS, ...analysis } }
  } as unknown as Project;
  let latest: StudioAnalysis = project.studio.analysis;
  function Harness() {
    const [draft, setDraft] = useState(() => draftFromProject(project));
    latest = draft.studio.analysis;
    const props = {
      session: { api: {}, token: "t", fail: () => "" },
      project,
      draft,
      update: () => undefined,
      updateStudio: (patch: Partial<ProjectStudio>) =>
        setDraft((current) => ({ ...current, studio: { ...current.studio, ...patch } })),
      dirty: false,
      save: async () => true,
      origin: "https://example.test",
      goTo: () => undefined,
      onProjectChanged: () => undefined
    } as unknown as StudioTabProps;
    return createElement(AnalysisSetting, props);
  }
  await act(async () => {
    renderer = create(createElement(LanguageProvider, null, createElement(Harness)));
  });
  const root = renderer!.root;
  const byId = (id: string) => root.findAll((node) => node.props.id === id)[0];
  return {
    analysis: () => latest,
    value: (id: string) => byId(id)?.props.value as string | undefined,
    change: (id: string, value: string) => act(async () => byId(id)!.props.onChange({ target: { value } })),
    press: (label: string) =>
      act(async () =>
        root
          .findAll(
            (node) => node.type === "button" && (node.props["aria-label"] === label || node.props.children === label)
          )[0]!
          .props.onClick()
      ),
    text: () => JSON.stringify(renderer!.toJSON())
  };
}

const CHOICE = (name: string, options: string[]) => ({ name, type: "enum" as const, description: "x", options });

describe("the choices of a field", () => {
  it("are read as typed, with either comma", () => {
    expect(parseOptions(" orders, returns ,, other ")).toEqual(["orders", "returns", "other"]);
    expect(parseOptions("订单，退货")).toEqual(["订单", "退货"]);
    expect(parseOptions(" ")).toEqual([]);
  });

  it("stay as typed while they are being typed", async () => {
    const page = await form({ enabled: true, fields: [CHOICE("topic", ["orders", "returns"])] });
    expect(page.value("cxsAnalysisField0-options")).toBe("orders, returns");
    // A comma just typed is not taken away from under the cursor.
    await page.change("cxsAnalysisField0-options", "orders, returns, ");
    expect(page.value("cxsAnalysisField0-options")).toBe("orders, returns, ");
    await page.change("cxsAnalysisField0-options", "orders, returns, other");
    expect(page.analysis().fields[0]!.options).toEqual(["orders", "returns", "other"]);
  });

  it("are the field's own when the field above it is removed", async () => {
    const page = await form({ enabled: true, fields: [CHOICE("a", ["x", "y"]), CHOICE("b", ["p", "q"])] });
    await page.change("cxsAnalysisField0-options", "x, y, z");
    await page.press("删除字段 1");
    expect(page.analysis().fields).toEqual([CHOICE("b", ["p", "q"])]);
    // What is shown is what will be saved.
    expect(page.value("cxsAnalysisField0-name")).toBe("b");
    expect(page.value("cxsAnalysisField0-options")).toBe("p, q");
  });

  it("are gone, on the page too, when the field was made something else and back", async () => {
    const page = await form({ enabled: true, fields: [CHOICE("topic", ["orders", "returns"])] });
    await page.change("cxsAnalysisField0-type", "string");
    expect(page.analysis().fields[0]).toEqual({ name: "topic", type: "string", description: "x" });
    expect(page.value("cxsAnalysisField0-options")).toBeUndefined();
    await page.change("cxsAnalysisField0-type", "enum");
    expect(page.analysis().fields[0]!.options).toEqual([]);
    expect(page.value("cxsAnalysisField0-options")).toBe("");
    expect(page.text()).toContain("现在还不能保存");
  });
});

describe("a field left unfinished behind the switch", () => {
  it("is still shown, with what is wrong with it, when analysis is turned off", async () => {
    const page = await form({ enabled: true });
    await page.press("添加字段");
    expect(page.analysis().fields).toEqual([{ name: "field_1", type: "string", description: "" }]);
    // Off: the server would still refuse the field, and with it every other setting saved at the same time.
    const box = () => renderer!.root.findAll((node) => node.props.type === "checkbox")[0]!;
    await act(async () => box().props.onChange({ target: { checked: false } }));
    expect(page.analysis().enabled).toBe(false);
    expect(page.text()).toContain("现在还不能保存");
    expect(page.value("cxsAnalysisField0-desc")).toBe("");
    // Finished, there is nothing to say and nothing to show.
    await page.change("cxsAnalysisField0-desc", "The order number.");
    expect(page.text()).not.toContain("现在还不能保存");
    expect(page.value("cxsAnalysisField0-desc")).toBeUndefined();
  });
});
