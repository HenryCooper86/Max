import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
