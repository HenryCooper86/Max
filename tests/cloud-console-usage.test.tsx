// @vitest-environment happy-dom
// The console's Usage tab: a project's minutes per user for a month, the
// current one or an earlier one.
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_STUDIO } from "../shared/cloud-studio";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { createCloudApi, type Project, type ProjectUsage } from "../src/console/api";
import { monthLabel, usageMonths, UsageTab } from "../src/console/studio/UsageTab";

const NOW = Date.UTC(2026, 10, 27, 9, 0, 0);
const project: Project = {
  id: "p1",
  name: "Demo",
  keyPrefix: "mpk_abcd",
  backend: "openai",
  hasModelKey: true,
  assistantName: "Max",
  instructions: "",
  greeting: "",
  studio: DEFAULT_STUDIO,
  publicId: "pub_0123456789abcdef01234567",
  hasWebhookSecret: false,
  createdAt: Date.UTC(2026, 2, 5)
};

const usage: ProjectUsage = {
  month: "2026-11",
  limitMinutes: 200,
  totals: { sessions: 9, minutes: 216.5, seconds: 12990 },
  users: [
    { userId: "cus_heavy", sessions: 5, minutes: 150, seconds: 9000 },
    { userId: "cus_light", sessions: 3, minutes: 60, seconds: 3600 },
    { userId: "anonymous", sessions: 1, minutes: 6.5, seconds: 390 }
  ],
  userCount: 2
};

type ProjectUsageCall = (token: string, projectId: string, month: string) => Promise<ProjectUsage>;

/** Everything the rendered tab says, as one string. */
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "children" in node) return textOf(node.children);
  return "";
}

/** The tab with `projectUsageCall` in place of the API call. */
async function mount(projectUsageCall: ProjectUsageCall) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const projectUsage = vi.fn(projectUsageCall);
  const session = {
    api: { ...createCloudApi(async () => new Response("{}")), projectUsage },
    token: "t",
    fail: String
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <LanguageProvider>
        <UsageTab session={session} project={project} />
      </LanguageProvider>
    );
  });
  return {
    projectUsage,
    shown: () => textOf(renderer.toJSON()),
    select: () => renderer.root.findByProps({ id: "cxs-p1-usage-month" }),
    press: (label: string) => act(async () => renderer.root.findByProps({ children: label }).props.onClick()),
    close: async () => {
      await act(async () => renderer.unmount());
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  };
}

describe("the Usage tab", () => {
  it("offers the current month back to the month the project was created in, at most 24", () => {
    expect(usageMonths(Date.UTC(2026, 2, 5), NOW)).toEqual([
      "2026-11",
      "2026-10",
      "2026-09",
      "2026-08",
      "2026-07",
      "2026-06",
      "2026-05",
      "2026-04",
      "2026-03"
    ]);
    expect(usageMonths(Date.UTC(2026, 10, 27), NOW)).toEqual(["2026-11"]);
    const twoYears = usageMonths(Date.UTC(2020, 0, 1), NOW);
    expect(twoYears).toHaveLength(24);
    expect(twoYears.at(0)).toBe("2026-11");
    expect(twoYears.at(-1)).toBe("2024-12");
    // A creation time ahead of the clock still offers the current month first.
    expect(usageMonths(Date.UTC(2027, 0, 1), NOW)[0]).toBe("2026-11");
    // From a 31st: stepping back into a shorter month must not land in the same month again.
    expect(usageMonths(Date.UTC(2026, 0, 10), Date.UTC(2026, 4, 31))).toEqual([
      "2026-05",
      "2026-04",
      "2026-03",
      "2026-02",
      "2026-01"
    ]);
    expect(usageMonths(Date.UTC(2025, 10, 1), Date.UTC(2026, 2, 31))).toEqual([
      "2026-03",
      "2026-02",
      "2026-01",
      "2025-12",
      "2025-11"
    ]);
    expect(monthLabel("2026-11", "zh-CN")).toBe("2026年11月");
    expect(monthLabel("2026-11", "en-US")).toBe("November 2026");
  });

  it("shows a month's minutes per user, the heaviest first, with each one's share of the per-user limit", async () => {
    const view = await mount(async () => usage);
    try {
      expect(view.projectUsage).toHaveBeenCalledWith("t", "p1", "2026-11");
      const shown = view.shown();
      for (const part of [
        "2026年11月",
        "cus_heavy",
        "cus_light",
        "没有用户 ID",
        "75%",
        "30%",
        "3%",
        "216.5",
        "每月上限为每个用户 200 分钟"
      ]) {
        expect(shown).toContain(part);
      }
      expect(shown.indexOf("cus_heavy")).toBeLessThan(shown.indexOf("cus_light"));
      expect(shown).not.toContain("只列出用量最多的");
    } finally {
      await view.close();
    }
  });

  it("says when a month has more users than it lists, and when it has none", async () => {
    const many = await mount(async () => ({ ...usage, userCount: 60 }));
    try {
      // The sessions without a user ID are a bucket, not a user.
      expect(many.shown()).toContain("只列出用量最多的 2 位用户，这个月共有 60 位。");
    } finally {
      await many.close();
    }
    const empty = await mount(async () => ({
      ...usage,
      limitMinutes: 0,
      totals: { sessions: 0, minutes: 0, seconds: 0 },
      users: [],
      userCount: 0
    }));
    try {
      const shown = empty.shown();
      expect(shown).toContain("这个月还没有通话。");
      // Without a per-user limit there is no share of one to show.
      expect(shown).not.toContain("占每月上限");
      expect(shown).not.toContain("每月上限为每个用户");
    } finally {
      await empty.close();
    }
  });

  it("loads the month chosen", async () => {
    const october: ProjectUsage = {
      ...usage,
      month: "2026-10",
      totals: { sessions: 1, minutes: 0.5, seconds: 30 },
      users: [{ userId: "october-user", sessions: 1, minutes: 0.5, seconds: 30 }],
      userCount: 1
    };
    const view = await mount(async (_token, _projectId, month) => (month === "2026-10" ? october : usage));
    try {
      expect(
        view
          .select()
          .findAllByType("option")
          .map((option) => option.props.value)
      ).toEqual(usageMonths(project.createdAt, NOW));
      await act(async () => view.select().props.onChange({ target: { value: "2026-10" } }));
      expect(view.projectUsage).toHaveBeenLastCalledWith("t", "p1", "2026-10");
      const shown = view.shown();
      expect(shown).toContain("october-user");
      expect(shown).not.toContain("cus_heavy");
    } finally {
      await view.close();
    }
  });

  it("shows why a month could not be loaded, and loads it again when asked", async () => {
    let attempts = 0;
    const view = await mount(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Something went wrong. Try again.");
      return usage;
    });
    try {
      expect(view.shown()).toContain("Something went wrong. Try again.");
      expect(view.shown()).not.toContain("cus_heavy");
      await view.press("重试");
      expect(view.projectUsage).toHaveBeenCalledTimes(2);
      expect(view.shown()).toContain("cus_heavy");
    } finally {
      await view.close();
    }
  });
});
