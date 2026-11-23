import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceAgent, type VoiceAgentEvents } from "../sdk/src/index";
import { DEFAULT_STUDIO } from "../shared/cloud-studio";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { ApiError, type Project } from "../src/console/api";
import { applyAgentEvent, EMPTY_TEST_STATE, formatElapsed } from "../src/console/studio/test-helpers";
import { AGENT_TEMPLATES } from "../src/lib/agent-templates";
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
    savedProject: project,
    release: null,
    releaseBusy: false,
    prepareTest: async () => ({ expectedLiveRevision: "r1", language: "" }),
    refreshRelease: async () => undefined,
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
    expect(html).toContain("项目的每月上限");
  });
  it("asks for a model key when there is none", () => {
    const html = render(props({ hasModelKey: false }));
    expect(html).toContain("模型密钥");
    expect(html).not.toContain("cxsTestMic");
  });
  it("shows the support sample in the selected English UI before provider setup", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => "en-US" } });
    try {
      const base = props({ hasModelKey: false });
      base.draft.studio.template = "support";
      const html = render(base);
      const sample = html.indexOf("Sample conversation");
      expect(sample).toBeGreaterThan(-1);
      expect(html.indexOf("Add a model key")).toBeGreaterThan(sample);
      expect(html).toContain("Where is my order A-1042?");
      expect(html).toContain("Shipped · Estimated delivery Friday");
      expect(html).toContain("Your package has shipped and should arrive on Friday.");
    } finally {
      vi.unstubAllGlobals();
    }
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

  it.each(AGENT_TEMPLATES)("offers the $id template's sample before key setup", async (template) => {
    const base = props({ hasModelKey: false });
    base.draft.studio.template = template.id;
    const page = await mount(base);
    expect(JSON.stringify(renderer!.toJSON())).toContain("示例对话");
    const prompt = page.findByProps({ "aria-expanded": false });
    const reply = page.findByProps({ id: prompt.props["aria-controls"] });
    expect(reply.props.hidden).toBe(true);
    expect(prompt.props.children).toBe(template.sample.question.zh);
    await act(async () => prompt.props.onClick());
    expect(prompt.props["aria-expanded"]).toBe(true);
    expect(reply.props.hidden).toBe(false);
    expect(JSON.stringify(renderer!.toJSON())).toContain(template.sample.reply.zh);
  });

  it("shows a simulated support lookup and its result before the answer without starting a real test", async () => {
    const base = props({ hasModelKey: false }, true);
    base.draft.studio.template = "support";
    const start = vi.spyOn(VoiceAgent.prototype, "start").mockResolvedValue();
    const prepareTest = vi.fn(),
      testSession = vi.fn(),
      refreshRelease = vi.fn(),
      goTo = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { setItem } });
    const page = await mount({
      ...base,
      prepareTest,
      refreshRelease,
      goTo,
      session: { ...base.session, api: { ...base.session.api, testSession } }
    });
    const prompt = page.findAllByProps({ "aria-expanded": false });
    expect(prompt).toHaveLength(1);
    await act(async () => prompt[0]!.props.onClick());
    const transcript = JSON.stringify(renderer!.toJSON());
    const call = transcript.indexOf("check_order");
    const result = transcript.indexOf("模拟结果");
    const answer = transcript.indexOf("您的包裹已发出");
    expect(call).toBeGreaterThan(-1);
    expect(result).toBeGreaterThan(call);
    expect(answer).toBeGreaterThan(result);
    expect(start).not.toHaveBeenCalled();
    expect(testSession).not.toHaveBeenCalled();
    expect(prepareTest).not.toHaveBeenCalled();
    expect(refreshRelease).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    await act(async () => page.findByProps({ children: "去添加模型密钥" }).props.onClick());
    expect(goTo).toHaveBeenCalledExactlyOnceWith("agent");
  });

  it.each(["", "retired-template"])("uses a generic example for a legacy template (%s)", async (template) => {
    const base = props({ hasModelKey: false });
    base.draft.studio.template = template;
    const page = await mount(base);
    expect(page.findAllByProps({ "aria-expanded": false })).toHaveLength(1);
    expect(page.findByProps({ "aria-expanded": false }).props.children).toBe(
      AGENT_TEMPLATES.find((t) => t.id === "blank")!.sample.question.zh
    );
  });

  it("does not reopen the microphone after leaving during Save and start", async () => {
    const pending = Promise.withResolvers<{ expectedLiveRevision: string; language: string }>();
    const start = vi.spyOn(VoiceAgent.prototype, "start").mockResolvedValue();
    const page = await mount({ ...props({}, true), prepareTest: () => pending.promise });
    await act(async () => page.findByProps({ children: "保存并开始" }).props.onClick());
    await act(async () => renderer?.unmount());
    renderer = undefined;
    await act(async () => pending.resolve({ expectedLiveRevision: "r1", language: "" }));
    expect(start).not.toHaveBeenCalled();
  });

  it("uses the freshly saved revision both at startup and when requesting a reconnect token", async () => {
    const testSession = vi.fn().mockResolvedValue({ token: "test-token", expiresAt: 1 });
    const base = props({}, true);
    const prepareTest = vi.fn().mockResolvedValue({ draftRevision: "draft-new", language: "zh" });
    let getToken: (() => Promise<string>) | undefined;
    vi.spyOn(VoiceAgent.prototype, "start").mockImplementation(async function (this: VoiceAgent) {
      // Use the SDK token path shared by initial connection and reconnects.
      const agent = this as unknown as { resolveToken(): Promise<string> };
      getToken = () => agent.resolveToken();
      await getToken();
    });
    const page = await mount({
      ...base,
      session: { ...base.session, token: "owner", api: { ...base.session.api, testSession } },
      release: {
        project: base.project,
        liveRevision: "live",
        previousRevision: null,
        draft: { project: base.project, id: "draft-old", changedFields: [], tested: true }
      },
      prepareTest
    });
    await act(async () => page.findByProps({ children: "保存并开始" }).props.onClick());
    expect(prepareTest).toHaveBeenCalledTimes(1);
    expect(await getToken?.()).toBe("test-token");
    expect(testSession.mock.calls).toEqual([
      ["owner", "p1", "draft-new", undefined],
      ["owner", "p1", "draft-new", undefined]
    ]);
  });

  it("keeps live tests pinned and refreshes after the relay rejects a stale revision", async () => {
    const testSession = vi.fn().mockRejectedValue(new ApiError("request", "Studio draft changed", 409));
    const refreshRelease = vi.fn().mockResolvedValue(undefined);
    const base = props({});
    vi.spyOn(VoiceAgent.prototype, "start").mockImplementation(async function (this: VoiceAgent) {
      const agent = this as unknown as { resolveToken(): Promise<string> };
      await agent.resolveToken();
    });
    const page = await mount({
      ...base,
      session: { ...base.session, token: "owner", api: { ...base.session.api, testSession } },
      refreshRelease
    });
    await act(async () => page.findByProps({ className: "cxsTestMic" }).props.onClick());
    expect(testSession).toHaveBeenCalledExactlyOnceWith("owner", "p1", undefined, "r1");
    expect(refreshRelease).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Studio draft changed");
  });

  it("refreshes server proof after readiness and after stopping a test", async () => {
    vi.stubGlobal("window", { setInterval, clearInterval });
    const refreshRelease = vi.fn().mockResolvedValue(undefined);
    let deliver!: (status: VoiceAgentEvents["status"]) => void;
    vi.spyOn(VoiceAgent.prototype, "start").mockResolvedValue();
    vi.spyOn(VoiceAgent.prototype, "on").mockImplementation((type, callback) => {
      if (type === "status") deliver = callback as typeof deliver;
      return () => undefined;
    });
    const page = await mount({ ...props({}), refreshRelease });
    const microphone = () => page.findByProps({ className: "cxsTestMic" });
    await act(async () => microphone().props.onClick());
    expect(refreshRelease).not.toHaveBeenCalled();
    await act(async () => deliver("ready"));
    expect(refreshRelease).toHaveBeenCalledTimes(1);
    await act(async () => microphone().props.onClick());
    expect(refreshRelease).toHaveBeenCalledTimes(2);
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
