import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceAgent, type VoiceAgentEvents } from "../sdk/src/index";
import { DEFAULT_STUDIO } from "../shared/cloud-studio";
import { LanguageProvider } from "../src/components/LanguageToggle";
import type { Project } from "../src/console/api";
import { applyAgentEvent, EMPTY_TEST_STATE, formatElapsed } from "../src/console/studio/test-helpers";
import { TestTab } from "../src/console/studio/TestTab";
import { draftFromProject } from "../src/console/studio/types";
import type { StudioTabProps } from "../src/console/studio/types";

const item = (id: string, role: "user" | "agent", text: string, final: boolean) => ({ id, role, text, final, at: 1 });

describe("applyAgentEvent", () => {
  it("updates a partial line in place and settles it", () => {
    let s = applyAgentEvent(EMPTY_TEST_STATE, { type: "transcript", transcript: [item("a", "user", "hel", false)] });
    s = applyAgentEvent(s, {
      type: "transcript",
      transcript: [item("a", "user", "hello", true), item("b", "agent", "hi", false)]
    });
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0]).toMatchObject({ kind: "say", text: "hello", final: true });
    expect(s.entries[1]).toMatchObject({ role: "agent", final: false });
  });

  it("tracks a tool call from started to succeeded or failed", () => {
    let s = applyAgentEvent(EMPTY_TEST_STATE, {
      type: "toolactivity",
      event: { callId: "1", name: "check_order", state: "started" },
      at: 5
    });
    s = applyAgentEvent(s, {
      type: "toolactivity",
      event: { callId: "1", name: "check_order", state: "succeeded", durationMs: 412 },
      at: 6
    });
    s = applyAgentEvent(s, {
      type: "toolactivity",
      event: { callId: "2", name: "refund", state: "failed", error: "no access" },
      at: 7
    });
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0]).toMatchObject({ kind: "tool", state: "succeeded", durationMs: 412 });
    expect(s.entries[1]).toMatchObject({ state: "failed", error: "no access" });
  });

  it("clears", () => {
    const s = applyAgentEvent(EMPTY_TEST_STATE, { type: "transcript", transcript: [item("a", "user", "x", true)] });
    expect(applyAgentEvent(s, { type: "clear" }).entries).toEqual([]);
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(83_000)).toBe("01:23");
    expect(formatElapsed(-5)).toBe("00:00");
  });
});

function props(patch: Partial<Project>, dirty = false): StudioTabProps {
  const project: Project = {
    id: "p1",
    name: "Demo",
    keyPrefix: "mk_",
    backend: "openai",
    hasModelKey: true,
    assistantName: "Max",
    instructions: "",
    greeting: "",
    studio: structuredClone(DEFAULT_STUDIO),
    publicId: "pub",
    hasWebhookSecret: false,
    createdAt: 0,
    ...patch
  } as Project;
  return {
    session: {} as StudioTabProps["session"],
    project,
    draft: draftFromProject(project),
    update: () => undefined,
    updateStudio: () => undefined,
    dirty,
    save: async () => true,
    origin: "https://max.example.com",
    goTo: () => undefined,
    onProjectChanged: () => undefined
  };
}

const render = (p: StudioTabProps) =>
  renderToStaticMarkup(createElement(LanguageProvider, null, createElement(TestTab, p)));

describe("TestTab", () => {
  it("renders the mic button and notes", () => {
    const html = render(props({}));
    expect(html).toContain("aria-pressed");
    expect(html).toContain("cxsTestMic");
    expect(html).toContain("免费分钟");
  });
  it("asks for a model key when there is none", () => {
    const html = render(props({ hasModelKey: false }));
    expect(html).toContain("模型密钥");
    expect(html).not.toContain("cxsTestMic");
  });
  it("offers Save and start when dirty", () => {
    expect(render(props({}, true))).toContain("保存并开始");
  });
});

describe("a running Studio test", () => {
  let renderer: ReactTestRenderer | undefined;

  async function mount(p: StudioTabProps) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(<TestTab {...p} />);
    });
    return renderer!.root;
  }

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not reopen the microphone after leaving during Save and start", async () => {
    const pending = Promise.withResolvers<boolean>();
    const start = vi.spyOn(VoiceAgent.prototype, "start").mockResolvedValue();
    const page = await mount({ ...props({}, true), save: () => pending.promise });
    await act(async () => page.findByProps({ children: "保存并开始" }).props.onClick());
    await act(async () => renderer?.unmount());
    renderer = undefined;
    await act(async () => pending.resolve(true));
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps cleared transcript lines out of the next SDK update", async () => {
    let deliver!: (event: VoiceAgentEvents["transcript"]) => void;
    vi.spyOn(VoiceAgent.prototype, "start").mockResolvedValue();
    vi.spyOn(VoiceAgent.prototype, "on").mockImplementation((type, callback) => {
      if (type === "transcript") deliver = callback as typeof deliver;
      return () => undefined;
    });
    const page = await mount(props({}));
    await act(async () => page.findByProps({ className: "cxsTestMic" }).props.onClick());
    const first = item("a", "user", "first line", false);
    const next = item("b", "agent", "next line", true);
    await act(async () => deliver({ transcript: [first], item: first }));
    await act(async () => page.findByProps({ children: "清空" }).props.onClick());
    const settled = { ...first, final: true };
    await act(async () => deliver({ transcript: [settled], item: settled }));
    await act(async () => deliver({ transcript: [settled, next], item: next }));
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("next line");
    expect(output).not.toContain("first line");
  });
});
