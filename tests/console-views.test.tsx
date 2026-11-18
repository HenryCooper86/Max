import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { createCloudApi, type Me, type Project } from "../src/console/api";
import { AuthCard } from "../src/console/AuthCard";
import { BalanceCard } from "../src/console/BalanceCard";
import { NotEnabled } from "../src/console/ConsoleApp";
import { KeyReveal } from "../src/console/KeyReveal";
import { ProjectEditor } from "../src/console/ProjectEditor";
import { Snippets } from "../src/console/Snippets";
import { ActivitySection, UsageSection } from "../src/console/UsageSection";
import { PricingPage } from "../src/landing/PricingPage";
import { PLANS, PRICING_FAQ } from "../src/lib/pricing";

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

  it("warns when a project has no model key and masks a saved one", () => {
    const editor = wrap(
      <ProjectEditor
        session={{ api, token: "t", fail: () => "" }}
        project={project}
        onChanged={() => undefined}
        onKeyRotated={() => undefined}
        onDeleted={() => undefined}
      />
    );
    expect(editor).toContain("•••• saved");
    expect(editor).toContain('type="password"');
    expect(editor).toContain("移除密钥");
    expect(editor).not.toContain("confirm(");
  });

  it("shows a new key once with a clear warning", () => {
    const html = wrap(<KeyReveal projectName="Demo" apiKey="mpk_secret" onDismiss={() => undefined} />);
    expect(html).toContain("mpk_secret");
    expect(html).toContain("不会再显示");
  });

  it("gives copyable snippets", () => {
    const html = wrap(<Snippets origin="https://max.example" />);
    expect(html).toContain("https://max.example/v1/session-tokens");
    expect(html).toContain("/api/voice-token");
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
  it("prices Max Cloud in yuan and links to the console", () => {
    const cloud = PLANS.find((plan) => plan.id === "cloud")!;
    expect(cloud.cta.href).toBe("/console");
    expect(html).toContain("¥0.15");
    expect(html).toContain('href="/console"');
    expect(html).toContain("抢先体验");
  });

  it("explains how to pay", () => {
    expect(PRICING_FAQ.some((item) => item.question.en === "How do I pay?")).toBe(true);
    expect(html).toContain("联系我们即可增加余额");
  });
});
