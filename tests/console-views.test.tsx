// @vitest-environment happy-dom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { ApiError, createCloudApi, type Me, type Project } from "../src/console/api";
import { AuthCard } from "../src/console/AuthCard";
import { BalanceCard } from "../src/console/BalanceCard";
import { ConsoleApp, NotEnabled } from "../src/console/ConsoleApp";
import { KeyReveal } from "../src/console/KeyReveal";
import { ProjectsSection, startFromTemplate } from "../src/console/ProjectsSection";
import { writeInstructions } from "../src/console/studio/AgentTab";
import { appendKnowledge } from "../src/console/studio/KnowledgeTab";
import { patchFromDraft, Studio } from "../src/console/studio/Studio";
import { draftChanged, draftFromProject } from "../src/console/studio/types";
import { AGENT_TEMPLATES } from "../src/lib/agent-templates";
import { DEFAULT_STUDIO } from "../shared/cloud-studio";
import { ActivitySection, UsageSection } from "../src/console/UsageSection";
import { PricingPage } from "../src/landing/PricingPage";
import { INVITE_REQUEST_URL, PLANS, PRICING_FAQ } from "../src/lib/pricing";

const wrap = (node: React.ReactNode) => renderToStaticMarkup(<LanguageProvider>{node}</LanguageProvider>);
const api = createCloudApi(async () => new Response("{}"));

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

  it("saves only what changed, and the model key only when typed", () => {
    const draft = draftFromProject(project);
    expect(draftChanged(draft, project)).toBe(false);
    expect(draftChanged({ ...draft, studio: { ...draft.studio, voice: "Puck" } }, project)).toBe(true);
    expect(draftChanged({ ...draft, modelKey: "sk-new" }, project)).toBe(true);
    expect(patchFromDraft(draft)).not.toHaveProperty("modelKey");
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
