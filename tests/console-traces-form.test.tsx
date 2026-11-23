// @vitest-environment happy-dom
// The traces settings form of the Max Cloud console, as a person uses it.
import { createElement, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STUDIO, type StudioTraces } from "../shared/cloud-studio";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { persistLanguage, type Language } from "../src/lib/i18n";
import type { Project, ProjectStudio } from "../src/console/api";
import { patchFromDraft } from "../src/console/studio/Studio";
import { TracesSetting } from "../src/console/studio/TracesSetting";
import { draftChanged, draftFromProject, type StudioDraft, type StudioTabProps } from "../src/console/studio/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  window.localStorage.clear();
});

const COLLECTOR = "https://cloud.langfuse.com/api/public/otel/v1/traces";

/** The form over a draft that it changes itself, as the Studio holds it. */
async function form(
  options: { traces?: Partial<StudioTraces>; hasTracesHeaders?: boolean; api?: object; language?: Language } = {}
) {
  persistLanguage(options.language ?? "en-US");
  const project = {
    id: "p1",
    name: "Demo",
    backend: "openai",
    hasTracesHeaders: options.hasTracesHeaders ?? false,
    studio: { ...structuredClone(DEFAULT_STUDIO), traces: { endpoint: "", content: false, ...options.traces } }
  } as unknown as Project;
  let latest: StudioDraft = draftFromProject(project);
  const changed: Project[] = [];
  function Harness() {
    const [draft, setDraft] = useState(() => draftFromProject(project));
    latest = draft;
    const props = {
      session: { api: options.api ?? {}, token: "t", fail: (error: unknown) => `failed: ${String(error)}` },
      project,
      draft,
      update: (patch: Partial<StudioDraft>) => setDraft((current) => ({ ...current, ...patch })),
      updateStudio: (patch: Partial<ProjectStudio>) =>
        setDraft((current) => ({ ...current, studio: { ...current.studio, ...patch } })),
      dirty: false,
      save: async () => true,
      origin: "https://example.test",
      goTo: () => undefined,
      onProjectChanged: (next: Project) => changed.push(next)
    } as unknown as StudioTabProps;
    return createElement(TracesSetting, props);
  }
  await act(async () => {
    renderer = create(createElement(LanguageProvider, null, createElement(Harness)));
  });
  const root = renderer!.root;
  const byId = (id: string) => root.findAll((node) => node.props.id === id)[0];
  const button = (label: string) => root.findAll((node) => node.type === "button" && node.props.children === label)[0];
  return {
    draft: () => latest,
    changed,
    input: (id: string) => byId(id),
    value: (id: string) => byId(id)?.props.value as string | undefined,
    change: (id: string, value: string) => act(async () => byId(id)!.props.onChange({ target: { value } })),
    check: (checked: boolean) =>
      act(async () =>
        root
          .findAll((node) => node.type === "input" && node.props.type === "checkbox")[0]!
          .props.onChange({
            target: { checked }
          })
      ),
    button,
    press: (label: string) => act(async () => button(label)!.props.onClick()),
    text: () => JSON.stringify(renderer!.toJSON())
  };
}

describe("the traces setting", () => {
  it("takes the address typed, and says why one cannot be used", async () => {
    const page = await form();
    expect(page.value("cxsTraces-p1-endpoint")).toBe("");
    await page.change("cxsTraces-p1-endpoint", "http://collector.example.com/v1/traces");
    expect(page.draft().studio.traces.endpoint).toBe("http://collector.example.com/v1/traces");
    expect(page.input("cxsTraces-p1-endpoint")!.props["aria-invalid"]).toBe(true);
    expect(page.text()).toContain("must start with https://");
    await page.change("cxsTraces-p1-endpoint", COLLECTOR);
    expect(page.input("cxsTraces-p1-endpoint")!.props["aria-invalid"]).toBeUndefined();
    expect(page.text()).toContain("Publish to apply");
    // No test for an address that is not saved.
    expect(page.button("Send test trace")).toBeUndefined();
  });

  it("turns on what was said, and says that transcripts go to the collector", async () => {
    const page = await form();
    expect(page.text()).toContain("transcripts");
    await page.check(true);
    expect(page.draft().studio.traces).toEqual({ endpoint: "", content: true });
  });

  it("takes headers it never shows, and offers to replace or remove those that are saved", async () => {
    const fresh = await form();
    const field = fresh.input("cxsTraces-p1-headers")!;
    expect(field.props.type).toBe("password");
    expect(field.props.placeholder).not.toContain("saved");
    expect(fresh.button("Remove")).toBeUndefined();
    await fresh.change("cxsTraces-p1-headers", "x-api-key=abc");
    expect(fresh.draft().tracesHeaders).toBe("x-api-key=abc");
    // What goes to the relay is the typed value, only when typed.
    expect(patchFromDraft(fresh.draft()).tracesHeaders).toBe("x-api-key=abc");
    expect(patchFromDraft({ ...fresh.draft(), tracesHeaders: "" })).not.toHaveProperty("tracesHeaders");
    await act(async () => renderer?.unmount());

    const api = { updateProject: vi.fn(async () => ({ project: { id: "p1", hasTracesHeaders: false } })) };
    const kept = await form({ traces: { endpoint: COLLECTOR }, hasTracesHeaders: true, api });
    const saved = kept.input("cxsTraces-p1-headers")!;
    expect(saved.props.type).toBe("password");
    expect(saved.props.value).toBe("");
    expect(saved.props.placeholder).toContain("saved");
    expect(kept.text()).toContain("Headers are saved");
    expect(kept.text()).not.toContain("x-api-key");
    // Typing replaces them: the draft is a change, but the saved value is not in the form.
    await kept.change("cxsTraces-p1-headers", "x-api-key=new");
    expect(draftChanged(kept.draft(), { hasTracesHeaders: true, studio: DEFAULT_STUDIO } as never)).toBe(true);
    await kept.change("cxsTraces-p1-headers", "");
    await kept.press("Remove");
    expect(api.updateProject).not.toHaveBeenCalled();
    expect(patchFromDraft(kept.draft()).tracesHeaders).toBe("");
    expect(kept.changed).toEqual([]);
    expect(kept.text()).toContain("Publishing will remove the headers.");
  });

  it("shows the result of the test in words", async () => {
    const testTraces = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "HTTP 401 from the collector: it did not accept the headers" })
      .mockRejectedValueOnce(new Error("offline"));
    const page = await form({ traces: { endpoint: COLLECTOR }, api: { testTraces } });
    await page.press("Send test trace");
    expect(testTraces).toHaveBeenCalledWith("t", "p1");
    expect(page.text()).toContain("Your collector took the test trace.");
    await page.press("Send test trace");
    expect(page.text()).toContain("The test did not arrive: HTTP 401 from the collector");
    await page.press("Send test trace");
    expect(page.text()).toContain("failed: Error: offline");
    // An address changed since it was saved is not what the test would reach.
    await page.change("cxsTraces-p1-endpoint", "https://other.example.com/v1/traces");
    expect(page.button("Send test trace")!.props.disabled).toBe(true);
  });

  it("is in Chinese for a Chinese reader", async () => {
    const page = await form({ traces: { endpoint: COLLECTOR }, language: "zh-CN" });
    expect(page.button("发送测试追踪")).toBeDefined();
    expect(page.text()).toContain("包含对话内容");
    expect(page.text()).toContain("收集器的请求头");
    expect(page.text()).not.toContain("Send test trace");
  });
});
