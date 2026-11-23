// @vitest-environment happy-dom
import { createRoot } from "react-dom/client";
import { act, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { ApiError, createCloudApi, type Me, type Project, type StudioRelease } from "../src/console/api";
import { AuthCard } from "../src/console/AuthCard";
import { BalanceCard } from "../src/console/BalanceCard";
import { ConsoleApp, NotEnabled } from "../src/console/ConsoleApp";
import { KeyReveal } from "../src/console/KeyReveal";
import { ProjectsSection, startFromTemplate } from "../src/console/ProjectsSection";
import { writeInstructions } from "../src/console/studio/AgentTab";
import { appendKnowledge } from "../src/console/studio/KnowledgeTab";
import { ReleasePanel } from "../src/console/studio/ReleasePanel";
import { patchFromDraft, Studio } from "../src/console/studio/Studio";
import { draftChanged, draftFromProject } from "../src/console/studio/types";
import { AGENT_TEMPLATES } from "../src/lib/agent-templates";
import { DEFAULT_STUDIO } from "../shared/cloud-studio";
import { ActivitySection, UsageSection } from "../src/console/UsageSection";
import { PricingPage } from "../src/landing/PricingPage";
import { INVITE_REQUEST_URL, PLANS, PRICING_FAQ } from "../src/lib/pricing";

const wrap = (node: React.ReactNode) => renderToStaticMarkup(<LanguageProvider>{node}</LanguageProvider>);

const project: Project = {
  id: "p1",
  name: "Demo",
  keyPrefix: "mpk_abcd",
  backend: "gemini",
  hasModelKey: true,
  assistantName: "Max",
  instructions: "Be brief",
  greeting: "Hi",
  studio: DEFAULT_STUDIO,
  publicId: "pub_0123456789abcdef01234567",
  hasWebhookSecret: false,
  createdAt: 1
};

const release = (live: Project): StudioRelease => ({
  project: live,
  liveRevision: "live-1",
  previousRevision: null,
  draft: null
});
const api = createCloudApi(async (path) => Response.json(path.endsWith("/release") ? release(project) : {}));

it("opens an editable test from a failed tool turn and saves only the reviewed case", async () => {
  const conversation = {
    id: "conv",
    projectId: project.id,
    startedAt: 1,
    endedAt: 20,
    seconds: 19,
    source: "embed",
    preview: "Private conversation",
    turns: [
      { at: 2, speaker: "user", text: "Earlier private turn" },
      { at: 3, speaker: "agent", text: "Earlier reply" },
      { at: 4, speaker: "user", text: "Order for alice@example.test" },
      { at: 5, speaker: "tool", text: "check_order: upstream private error", ok: false },
      { at: 6, speaker: "agent", text: "Previous wrong answer" },
      { at: 7, speaker: "user", text: "Unrelated turn" },
      { at: 8, speaker: "tool", text: "another_tool", ok: true }
    ] as const
  };
  const createReplayCase = vi.fn(
    async (_token: string, _projectId: string, input: import("../shared/studio-replay").ReplayCaseInput) => ({
      testCase: { ...input, id: "case1", version: 1 }
    })
  );
  const session = {
    api: {
      ...api,
      conversations: async () => ({ conversations: [conversation] }),
      conversation: async () => ({ conversation: { ...conversation, turns: [...conversation.turns] } }),
      replayCases: async () => ({ cases: [] }),
      createReplayCase
    },
    token: "t",
    fail: String
  };
  let renderer: ReactTestRenderer | undefined;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => {
      renderer = create(
        <Studio
          project={project}
          initialTab="history"
          session={session}
          origin="https://relay.example"
          onChanged={() => {}}
          onKeyRotated={() => {}}
          onDeleted={() => {}}
        />
      );
    });
    const page = renderer!.root;
    await act(async () => page.findByProps({ className: "cxsHistoryRow" }).props.onClick());
    const failed = page.findByProps({ className: "cxsHistoryTool bad" });
    await act(async () => failed.findByType("button").props.onClick());
    expect(page.findByProps({ id: "cxs-p1-tab-test" }).props["aria-selected"]).toBe(true);
    const form = page.findByProps({ className: "cxsReplayEditor" });
    const prompt = form.findByProps({ value: "Order for alice@example.test" });
    expect(form.findAllByType("textarea").some((node) => String(node.props.value).includes("check_order"))).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("upstream private error");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Earlier private turn");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("another_tool");
    expect(createReplayCase).not.toHaveBeenCalled();
    await act(async () => prompt.props.onChange({ target: { value: "When will the sample order arrive?" } }));
    const expected = form.findByProps({ maxLength: 500 });
    await act(async () => expected.props.onChange({ target: { value: "Friday" } }));
    const fixtures = form.findAllByType("textarea").find((node) => String(node.props.value).includes("check_order"))!;
    await act(async () => fixtures.props.onChange({ target: { value: '{"check_order":{"eta":"Friday"}}' } }));
    await act(async () => form.props.onSubmit({ preventDefault() {} }));
    expect(createReplayCase).toHaveBeenCalledExactlyOnceWith("t", "p1", {
      prompt: "When will the sample order arrive?",
      expected: "Friday",
      fixtures: { check_order: { eta: "Friday" } }
    });
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});

describe("logged-out view", () => {
  const html = wrap(<AuthCard api={api} onSignedIn={() => undefined} />);
  it("shows both tabs and the reassurance", () => {
    expect(html).toContain("创建账户");
    expect(html).toContain("登录");
    expect(html).toContain('role="tab"');
    expect(html).toContain("每月 1,000 分钟免费");
    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
  });
});

it("ignores availability and authorization failures from an earlier console session", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const check = Promise.withResolvers<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/packs")) return check.promise;
      const body = url.endsWith("/projects")
        ? { projects: [] }
        : url.endsWith("/usage")
          ? { minutes: 0, projects: [], chargedFen: 0, freeSecondsUsed: 0 }
          : url.endsWith("/me")
            ? { customer: { email: "user@example.com" }, balance: { fen: 0, freeSecondsLeft: 0 } }
            : { entries: [] };
      return Response.json(body);
    })
  );
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(<ConsoleApp />);
    });
    const page = renderer!.root;
    await act(async () => page.findByType(AuthCard).props.onSignedIn("first"));
    const first = page.findByType(ProjectsSection).props.session;
    const logout = page.findByProps({ children: "退出登录" });
    await act(async () => logout.props.onClick());
    await act(async () => page.findByType(AuthCard).props.onSignedIn("second"));
    await act(async () => first.fail(new ApiError("unauthorized", "expired", 401)));
    expect(page.findAllByType(ProjectsSection)).toHaveLength(1);
    await act(async () => check.resolve(Response.json({}, { status: 503 })));
    expect(page.findByType(ProjectsSection).props.session.token).toBe("second");
  } finally {
    await act(async () => renderer?.unmount());
    localStorage.clear();
    vi.unstubAllGlobals();
  }
});

describe("overview pieces", () => {
  it("shows the balance and free minutes", () => {
    const me: Me = {
      customer: { id: "c", email: "a@b.c", createdAt: 1 },
      balance: { fen: 5000, freeSecondsLeft: 60_000, month: "2026-11" }
    };
    const html = wrap(<BalanceCard me={me} onTopUp={() => undefined} />);
    expect(html).toContain("¥50.00");
    expect(html).toContain("1,000");
  });

  it("opens the studio on the agent tab, masking a saved model key", () => {
    const studio = wrap(
      <Studio
        session={{ api, token: "t", fail: () => "" }}
        project={project}
        origin="https://max.example"
        onChanged={() => undefined}
        onKeyRotated={() => undefined}
        onDeleted={() => undefined}
      />
    );
    expect(studio).toContain("•••• 已保存");
    expect(studio).toContain('type="password"');
    expect(studio).toContain('role="tablist"');
    for (const tab of ["助手", "知识", "工具", "测试", "安装", "对话", "设置"]) expect(studio).toContain(tab);
    // Getting started: the key is in, testing and installing are next.
    expect(studio).toContain("和它说说话");
    expect(studio).not.toContain("confirm(");
  });

  it("uses the relay's installation milestone and supports keyboard tab selection and cancellation", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const enabled = { ...project, studio: { ...project.studio, publicEmbed: { enabled: true, origins: [] } } };
    const studioApi = { ...api, studioRelease: async () => release(enabled) };
    const render = (item: Project) =>
      act(async () =>
        root.render(
          <Studio
            session={{ api: studioApi, token: "t", fail: String }}
            project={item}
            origin="https://max.example"
            onChanged={() => {}}
            onKeyRotated={() => {}}
            onDeleted={() => {}}
          />
        )
      );
    const installation = () => host.querySelector("ol li:last-child")!;
    const selected = () => host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
    const key = (key: string) =>
      act(async () => {
        selected().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    const cancel = (event: Event) => event.preventDefault();
    try {
      localStorage.setItem("max-cloud:installed:p1", "1");
      await render(enabled);
      expect(installation().classList.contains("done")).toBe(false);
      localStorage.removeItem("max-cloud:installed:p1");
      await act(async () => host.querySelector<HTMLButtonElement>("#cxs-p1-tab-install")!.click());
      const snippet = host.querySelector<HTMLButtonElement>(".cxsInstallCodeHead button")!;
      await act(async () => snippet.click());
      expect(await navigator.clipboard.readText()).toContain("voice-agent.iife.js");
      expect(localStorage.getItem("max-cloud:installed:p1")).toBeNull();
      expect(installation().classList.contains("done")).toBe(false);
      await act(async () => host.querySelector<HTMLButtonElement>("#cxs-p1-tab-agent")!.click());
      await render({ ...enabled, firstWebsiteConversationAt: 123 });
      expect(installation().classList.contains("done")).toBe(true);
      selected().focus();
      expect(host.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
      await key("ArrowLeft");
      expect(selected().id).toBe("cxs-p1-tab-settings");
      expect(document.activeElement).toBe(selected());
      await key("ArrowRight");
      expect(selected().id).toBe("cxs-p1-tab-agent");
      await key("ArrowRight");
      expect(selected().id).toBe("cxs-p1-tab-knowledge");
      await key("End");
      expect(selected().id).toBe("cxs-p1-tab-settings");
      window.addEventListener("admin:beforesection", cancel);
      await key("Home");
      expect(selected().id).toBe("cxs-p1-tab-settings");
      expect(document.activeElement).toBe(selected());
      window.removeEventListener("admin:beforesection", cancel);
      await key("Home");
      expect(selected().id).toBe("cxs-p1-tab-agent");
    } finally {
      window.removeEventListener("admin:beforesection", cancel);
      await act(async () => root.unmount());
      host.remove();
      localStorage.clear();
      vi.unstubAllGlobals();
    }
  });

  it("refreshes the open project's milestone without overwriting settings or an edit in progress", async () => {
    const pending = { ...project, firstWebsiteConversationAt: null };
    const listProjects = vi
      .fn()
      .mockResolvedValueOnce({ projects: [pending] })
      .mockResolvedValueOnce({
        projects: [{ ...project, name: "Stale project name", firstWebsiteConversationAt: 42 }]
      });
    const session = {
      api: { ...api, listProjects, studioRelease: async () => release(pending) },
      token: "t",
      fail: String
    };
    function Dashboard() {
      const [projects, setProjects] = useState<Project[] | null>([pending]);
      return (
        <ProjectsSection
          session={session}
          projects={projects}
          setProjects={setProjects}
          error=""
          onRetry={() => {}}
          origin="https://max.example"
          onMoney={() => {}}
        />
      );
    }
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<Dashboard />);
      });
      const page = renderer!.root;
      await act(async () => page.findByProps({ "aria-expanded": false }).props.onClick());
      await act(async () => page.findByProps({ id: "cxs-p1-tab-settings" }).props.onClick());
      const field = () => page.findByProps({ id: "cxs-p1-name" }).props;
      await act(async () => field().onChange({ target: { value: "Unsaved draft" } }));
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(page.findByType(Studio).props.project).toMatchObject({ name: "Demo", firstWebsiteConversationAt: 42 });
      expect(field().value).toBe("Unsaved draft");
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(listProjects).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("keeps drafts across tabs and asks before closing an edited project", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <ProjectsSection
            session={{ api, token: "t", fail: String }}
            projects={[project]}
            error=""
            onRetry={() => undefined}
            setProjects={() => undefined}
            origin="https://max.example"
            onMoney={() => undefined}
          />
        );
      });
      const page = renderer!.root;
      const click = (props: Record<string, unknown>) => act(async () => page.findByProps(props).props.onClick());
      await click({ "aria-expanded": false });
      await click({ id: "cxs-p1-tab-settings" });
      await act(async () => page.findByProps({ id: "cxs-p1-name" }).props.onChange({ target: { value: "New name" } }));
      await click({ id: "cxs-p1-tab-knowledge" });
      expect(confirm).not.toHaveBeenCalled();
      await click({ "aria-expanded": true });
      expect(confirm).toHaveBeenCalledOnce();
      await click({ id: "cxs-p1-tab-settings" });
      expect(page.findByProps({ id: "cxs-p1-name" }).props.value).toBe("New name");
      confirm.mockReturnValue(true);
      await click({ "aria-expanded": true });
      expect(page.findAllByProps({ role: "tabpanel" })).toHaveLength(0);
    } finally {
      await act(async () => renderer?.unmount());
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("shows flow and same-host endpoint changes without exposing private values", () => {
    const live = {
      ...project,
      studio: {
        ...project.studio,
        conversationWebhook: "https://sample.test/live-path?token=secret-1",
        flow: [
          {
            id: "main",
            description: "Old description",
            onStart: { call: { tool: "welcome", arguments: { key: "secret-2" } } }
          }
        ]
      }
    };
    const saved = {
      ...live,
      studio: {
        ...live.studio,
        conversationWebhook: "https://sample.test/draft-path?token=secret-3",
        flow: [
          {
            id: "main",
            description: "New description",
            onStart: { call: { tool: "welcome", arguments: { key: "secret-4" } } }
          }
        ]
      }
    };
    const html = wrap(
      <ReleasePanel
        release={{
          ...release(live),
          draft: {
            id: "draft-2",
            project: saved,
            tested: false,
            changedFields: ["studio.flow", "studio.conversationWebhook"]
          }
        }}
        dirty={false}
        busy={false}
        conflict={false}
        refresh={async () => {}}
        publish={() => {}}
        restore={() => {}}
        goToTest={() => {}}
      />
    );
    expect(html).toContain("Old description");
    expect(html).toContain("New description");
    expect(html).toContain("启动时的工具参数已更改");
    expect(html).toContain("端点地址已更改，主机相同");
    expect(html).toContain("sample.test");
    expect(html).not.toMatch(/secret-|live-path|draft-path/);
  });

  it("reviews saved changes, publishes the tested revision, and confirms restoring", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    const saved = { ...project, instructions: "New agent instructions" };
    const initial: StudioRelease = {
      ...release(project),
      draft: { id: "draft-2", project: saved, tested: false, changedFields: ["instructions", "modelKey"] }
    };
    const published: StudioRelease = {
      project: saved,
      liveRevision: "draft-2",
      previousRevision: "live-1",
      draft: null
    };
    const studioRelease = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue({
        ...initial,
        draft: { ...initial.draft, tested: true }
      });
    const publishStudioRevision = vi.fn().mockResolvedValue(published);
    const restoreStudioRevision = vi.fn().mockResolvedValue(release(project));
    const onChanged = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <LanguageProvider>
            <Studio
              session={{
                api: { ...api, studioRelease, publishStudioRevision, restoreStudioRevision },
                token: "t",
                fail: String
              }}
              project={project}
              origin="https://max.example"
              onChanged={onChanged}
              onKeyRotated={() => {}}
              onDeleted={() => {}}
            />
          </LanguageProvider>
        );
      });
      const button = (label: string) => renderer!.root.findByProps({ children: label });
      const output = JSON.stringify(renderer!.toJSON());
      expect(output).toContain("Be brief");
      expect(output).toContain("New agent instructions");
      expect(output).toContain("密钥配置已更改");
      expect(button("发布已测试草稿").props.disabled).toBe(true);
      await act(async () => button("刷新版本").props.onClick());
      expect(button("发布已测试草稿").props.disabled).toBe(false);
      await act(async () => button("发布已测试草稿").props.onClick());
      expect(publishStudioRevision).toHaveBeenCalledWith("t", "p1", { baseRevision: "live-1", revision: "draft-2" });
      expect(onChanged).toHaveBeenLastCalledWith(saved);
      await act(async () => button("恢复上一版本").props.onClick());
      expect(restoreStudioRevision).not.toHaveBeenCalled();
      await act(async () => button("恢复上一版本").props.onClick());
      expect(restoreStudioRevision).toHaveBeenCalledWith("t", "p1", {
        baseRevision: "draft-2",
        revision: "live-1",
        draftRevision: null
      });
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("submits the reviewed draft ID on restore and preserves edits when it is stale", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirm);
    const restoreStudioRevision = vi.fn().mockRejectedValue(new ApiError("request", "stale", 409));
    const studioRelease = vi.fn().mockResolvedValue({
      ...release(project),
      previousRevision: "previous",
      draft: {
        id: "draft-1",
        project: { ...project, assistantName: "Saved name" },
        tested: false,
        changedFields: ["assistantName"]
      }
    });
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <LanguageProvider>
            <Studio
              session={{ api: { ...api, studioRelease, restoreStudioRevision }, token: "t", fail: String }}
              project={project}
              origin="https://max.example"
              onChanged={() => {}}
              onKeyRotated={() => {}}
              onDeleted={() => {}}
            />
          </LanguageProvider>
        );
      });
      const name = () => renderer!.root.findByProps({ id: "cxs-p1-assistant" });
      const button = () => renderer!.root.findByProps({ children: "恢复上一版本" });
      await act(async () => name().props.onChange({ target: { value: "Unsaved name" } }));
      await act(async () => button().props.onClick());
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("丢弃当前草稿及未保存的编辑"));
      expect(restoreStudioRevision).toHaveBeenCalledWith("t", "p1", {
        baseRevision: "live-1",
        draftRevision: "draft-1",
        revision: "previous"
      });
      expect(name().props.value).toBe("Unsaved name");
      expect(button().props.disabled).toBe(true);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("keeps local edits and adopts unrelated server changes when refreshing a conflict", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const existing = { ...project, assistantName: "Saved draft name" };
    const newer = { ...existing, greeting: "Changed in another tab" };
    const studioRelease = vi
      .fn()
      .mockResolvedValueOnce({
        ...release(project),
        draft: { project: existing, id: "draft-1", changedFields: ["assistantName"], tested: false }
      })
      .mockResolvedValue({
        ...release(project),
        draft: { project: newer, id: "draft-2", changedFields: ["assistantName", "greeting"], tested: false }
      });
    const saveStudioDraft = vi.fn().mockRejectedValue(new ApiError("request", "stale", 409));
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <LanguageProvider>
            <Studio
              session={{ api: { ...api, studioRelease, saveStudioDraft }, token: "t", fail: String }}
              project={project}
              origin="https://max.example"
              onChanged={() => {}}
              onKeyRotated={() => {}}
              onDeleted={() => {}}
            />
          </LanguageProvider>
        );
      });
      const button = (label: string) => renderer!.root.findByProps({ children: label });
      const name = () => renderer!.root.findByProps({ id: "cxs-p1-assistant" });
      expect(name().props.value).toBe("Saved draft name");
      await act(async () => name().props.onChange({ target: { value: "Local name" } }));
      await act(async () => button("保存草稿").props.onClick());
      expect(button("保存草稿").props.disabled).toBe(true);
      await act(async () => button("刷新版本").props.onClick());
      expect(button("保存草稿").props.disabled).toBe(false);
      expect(name().props.value).toBe("Local name");
      await act(async () => button("保存草稿").props.onClick());
      expect(saveStudioDraft).toHaveBeenLastCalledWith("t", "p1", {
        baseRevision: "live-1",
        draftRevision: "draft-2",
        patch: expect.objectContaining({ assistantName: "Local name", greeting: "Changed in another tab" })
      });
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("saves only what changed, and the model key only when typed", () => {
    const draft = draftFromProject(project);
    expect(draftChanged(draft, project)).toBe(false);
    expect(draftChanged({ ...draft, studio: { ...draft.studio, voice: "Puck" } }, project)).toBe(true);
    expect(draftChanged({ ...draft, modelKey: "sk-new" }, project)).toBe(true);
    expect(patchFromDraft(draft)).not.toHaveProperty("modelKey");
    expect(patchFromDraft({ ...draft, studio: { ...draft.studio, flow: [{ id: "main" }] } }).studio?.flow).toEqual([
      { id: "main" }
    ]);
    expect(patchFromDraft({ ...draft, modelKey: " sk-new " }).modelKey).toBe("sk-new");
  });

  it("writes instructions from a few plain answers", () => {
    const brief = {
      business: "Corner Bakery",
      job: "take cake orders",
      tone: "calm" as const,
      never: "promise discounts"
    };
    const english = writeInstructions(brief, "en-US");
    expect(english).toContain("You are the voice assistant for Corner Bakery.");
    expect(english).toContain("Your job: take cake orders");
    expect(english).toContain("calm and reassuring");
    expect(english).toContain("Never: promise discounts");
    expect(writeInstructions({ ...brief, never: "" }, "en-US")).not.toContain("Never:");
    expect(writeInstructions(brief, "zh-CN")).toContain("你是Corner Bakery的语音助手。");
  });

  it("adds imported knowledge after what is there, within 20,000 characters", () => {
    expect(appendKnowledge("", "  Hours: 9-5 ")).toEqual({ text: "Hours: 9-5", cut: false });
    expect(appendKnowledge("A", "B")).toEqual({ text: "A\n\nB", cut: false });
    const long = appendKnowledge("x".repeat(19_999), "yyyy");
    expect(long.text).toHaveLength(20_000);
    expect(long.cut).toBe(true);
  });

  it("starts a project from a template in the visitor's language", () => {
    const support = AGENT_TEMPLATES.find((template) => template.id === "support")!;
    const english = startFromTemplate(support, "Help desk", "en-US");
    expect(english).toMatchObject({ name: "Help desk", assistantName: "Sam", studio: { template: "support" } });
    expect(english.instructions).toContain("check_order");
    expect(startFromTemplate(support, "客服", "zh-CN").greeting).toContain("客服");
    const list = wrap(
      <ProjectsSection
        session={{ api, token: "t", fail: () => "" }}
        projects={[project]}
        error=""
        onRetry={() => undefined}
        setProjects={() => undefined}
        origin="https://max.example"
        onMoney={() => undefined}
      />
    );
    expect(list).toContain("打开工作室");
    expect(list).toContain("新建助手");
  });

  it("shows a new key once with a clear warning", () => {
    const html = wrap(<KeyReveal projectName="Demo" apiKey="mpk_secret" onDismiss={() => undefined} />);
    expect(html).toContain("mpk_secret");
    expect(html).toContain("不会再显示");
  });

  it("lists usage and newest activity first", () => {
    const usage = wrap(
      <UsageSection
        usage={{
          month: "2026-11",
          seconds: 90,
          minutes: 1.5,
          freeSecondsUsed: 90,
          chargedFen: 0,
          projects: [{ projectId: "p1", name: "Demo", seconds: 90, chargedFen: 0 }]
        }}
      />
    );
    expect(usage).toContain("Demo");
    expect(usage).toContain("1.5");
    const activity = wrap(
      <ActivitySection
        entries={[
          { id: 1, kind: "topup", amountFen: 5000, seconds: 0, createdAt: 1000 },
          { id: 2, kind: "usage", amountFen: -30, seconds: 120, createdAt: 2000 }
        ]}
      />
    );
    expect(activity.indexOf("-¥0.30")).toBeLessThan(activity.indexOf("+¥50.00"));
  });

  it("explains when Max Cloud is off", () => {
    expect(wrap(<NotEnabled />)).toContain("没有启用 Max Cloud");
  });
});

describe("pricing page", () => {
  const html = wrap(<PricingPage />);
  it("prices Max Cloud in yuan and offers an invitation", () => {
    const cloud = PLANS.find((plan) => plan.id === "cloud")!;
    expect(cloud.cta.href).toBe(INVITE_REQUEST_URL);
    expect(html).toContain("¥0.15");
    expect(html).toContain("申请邀请");
    expect(html).toContain("凭邀请");
  });

  it("explains how to pay", () => {
    expect(PRICING_FAQ.some((item) => item.question.en === "How do I pay?")).toBe(true);
    expect(html).toContain("联系我们即可增加余额");
  });
});
