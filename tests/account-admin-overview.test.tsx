import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { TesterSessionSummary, TestingStats } from "../shared/agent";
import type { TestingOperationsSnapshot, TestingPolicy, TestingRun } from "../shared/testing";
import { AdminOverview } from "../src/components/admin/AdminOverview";
import { useAdminTestingData, type AdminTestingData } from "../src/components/admin/useAdminTestingData";
import type { ApiResult } from "../src/lib/api-client";
import {
  adminAccountApi,
  type AdminOverview as AccountOverviewData,
  type AuthUser,
  type InviteInfo
} from "../src/lib/auth";
import { testingApi } from "../src/lib/testing-api";

// Named cast: react-test-renderer requires the act flag on globalThis; the
// typed const keeps the assignment checkable instead of inline-fabricated.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

function success<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function failure(kind: "unauthorized" | "forbidden" | "server" | "unavailable", message: string): ApiResult<never> {
  return { ok: false, error: { kind, message } };
}

function accountUser(username: string, role: AuthUser["role"] = "admin", lastLoginAt = 1): AuthUser {
  return {
    id: username,
    username,
    displayName: `用户 ${username}`,
    role,
    createdAt: 1,
    lastLoginAt
  };
}

function accountInvite(code: string, expiresAt: number, createdAt = Date.now() - 60_000): InviteInfo {
  return { code, createdAt, expiresAt, createdBy: "admin" };
}

function accountOverview(
  users: AuthUser[] = [accountUser("admin"), accountUser("alice", "tester")],
  invites: InviteInfo[] = [accountInvite("invite_123456789", Date.now() + 86_400_000)]
): AccountOverviewData {
  return { users, invites };
}

function session(sessionId: string, endedAt: number): TesterSessionSummary {
  return { sessionId, endedAt } as TesterSessionSummary;
}

function stats(label: string): TestingStats {
  return { windowMinutes: 30, label } as unknown as TestingStats;
}

function policy(label: string): TestingPolicy {
  return { version: label } as TestingPolicy;
}

function run(label: string): TestingRun {
  return { id: label, name: label } as TestingRun;
}

function operations(label: string): TestingOperationsSnapshot {
  return {
    activePolicy: policy(`policy-${label}`),
    runs: [run(label)],
    reviews: [],
    audit: []
  };
}

function page(items: TesterSessionSummary[], nextCursor?: string, total?: number) {
  return { items, nextCursor, total: total ?? items.length };
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}

/** The renderer root is the AdminOverview composite; the load-status flag
 * lives on the rendered section, not on the component's own props. */
function loadStatus(): string | undefined {
  const section = renderer!.root.find(
    (node) => node.type === "section" && node.props["data-load-status"] !== undefined
  );
  return section ? String(section.props["data-load-status"]) : undefined;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let renderer: ReactTestRenderer | null = null;

type OverviewProps = {
  user: AuthUser;
  onAuthenticationExpired: Mock;
  onOpenAccounts: Mock;
  onOpenAudit: Mock;
};

async function mountOverview(overrides: Partial<OverviewProps> = {}): Promise<OverviewProps> {
  const props: OverviewProps = {
    user: overrides.user ?? accountUser("admin"),
    onAuthenticationExpired: overrides.onAuthenticationExpired ?? vi.fn(),
    onOpenAccounts: overrides.onOpenAccounts ?? vi.fn(),
    onOpenAudit: overrides.onOpenAudit ?? vi.fn()
  };
  await act(async () => {
    renderer = create(<AdminOverview {...props} />);
  });
  await flush();
  return props;
}

async function rerenderOverview(props: OverviewProps) {
  await act(async () => {
    renderer?.update(<AdminOverview {...props} />);
  });
  await flush();
}

type HookRecord = { scope: string; data: AdminTestingData };

function HookProbe({
  user: currentUser,
  onAuthenticationExpired,
  enabled,
  onRender
}: {
  user: AuthUser;
  onAuthenticationExpired: () => void;
  enabled: boolean;
  onRender: (record: HookRecord) => void;
}) {
  const data = useAdminTestingData({ user: currentUser, onAuthenticationExpired, enabled });
  onRender({ scope: `${currentUser.id}:${currentUser.role}`, data });
  return null;
}

async function mountHookHarness(currentUser: AuthUser, enabled: boolean) {
  const records: HookRecord[] = [];
  let harnessRenderer!: ReactTestRenderer;
  const onAuthenticationExpired = vi.fn();
  await act(async () => {
    harnessRenderer = create(
      <HookProbe
        user={currentUser}
        onAuthenticationExpired={onAuthenticationExpired}
        enabled={enabled}
        onRender={(record) => records.push(record)}
      />
    );
  });
  await flush();

  return {
    get current() {
      return records.at(-1)!.data;
    },
    async rerender(nextUser: AuthUser, nextEnabled: boolean) {
      await act(async () => {
        harnessRenderer.update(
          <HookProbe
            user={nextUser}
            onAuthenticationExpired={onAuthenticationExpired}
            enabled={nextEnabled}
            onRender={(record) => records.push(record)}
          />
        );
      });
      await flush();
    }
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  const originalConsoleError = console.error;
  vi.spyOn(console, "error").mockImplementation((message: unknown, ...optionalParams: unknown[]) => {
    if (message === "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer") return;
    originalConsoleError(message, ...optionalParams);
  });
  vi.spyOn(adminAccountApi, "fetchOverview").mockResolvedValue(success(accountOverview()));
  vi.spyOn(testingApi, "fetchSummary").mockResolvedValue(success(stats("initial")));
  vi.spyOn(testingApi, "fetchSessions").mockResolvedValue(success(page([session("initial", 10)], "next-page")));
  vi.spyOn(testingApi, "fetchOperations").mockResolvedValue(
    success({ operations: operations("initial"), policies: [policy("initial")] })
  );
  vi.spyOn(testingApi, "fetchRuns").mockResolvedValue(success([run("initial")]));
  vi.spyOn(testingApi, "createRun").mockResolvedValue(success(run("created")));
});

afterEach(async () => {
  if (renderer) {
    await act(async () => renderer?.unmount());
    renderer = null;
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AdminOverview (administration home)", () => {
  it("summarizes accounts, usable vs expired invites and recent account activity", async () => {
    const now = Date.now();
    vi.mocked(adminAccountApi.fetchOverview).mockResolvedValueOnce(
      success(
        accountOverview(
          [
            accountUser("admin", "admin", now - 60_000),
            accountUser("alice", "reviewer", now - 120_000),
            accountUser("bob", "tester", now - 180_000)
          ],
          [accountInvite("1234567890123456", now + 86_400_000), accountInvite("9999888877776666", now - 1_000)]
        )
      )
    );
    const onOpenAccounts = vi.fn();
    const onOpenAudit = vi.fn();
    await mountOverview({ onOpenAccounts, onOpenAudit });

    expect(loadStatus()).toBe("ready");
    const rendered = text(renderer!.root);

    // Recent accounts are human rows: username, role label and dates, newest login first.
    expect(rendered).toContain("@alice");
    expect(rendered).toContain("审核员");
    expect(rendered).toContain("加入于");
    expect(rendered).toContain("最近登录");
    expect(rendered).toContain("当前账号");
    expect(rendered.indexOf("@admin")).toBeLessThan(rendered.indexOf("@alice"));
    expect(rendered.indexOf("@alice")).toBeLessThan(rendered.indexOf("@bob"));

    // Invitations split into usable rows and an expired summary, never both.
    expect(rendered).toContain("1 / 2");
    expect(rendered).toContain("56789012");
    expect(rendered).toContain("另有 1 个已过期邀请");
    expect(rendered).not.toContain("88887776");
    expect(rendered).toContain("3 个账号");

    // The only actions are navigation into the owned sections.
    act(() => {
      renderer!.root.find((node) => node.type === "button" && text(node) === "管理账号与邀请").props.onClick();
    });
    expect(onOpenAccounts).toHaveBeenCalledTimes(1);
    act(() => {
      renderer!.root.find((node) => node.type === "button" && text(node) === "查看系统审计").props.onClick();
    });
    expect(onOpenAudit).toHaveBeenCalledTimes(1);
  });

  it("routes an explicit 401 to authentication expiry instead of a healthy zero", async () => {
    const onAuthenticationExpired = vi.fn();
    vi.mocked(adminAccountApi.fetchOverview).mockResolvedValueOnce(failure("unauthorized", "会话已过期。"));
    await mountOverview({ onAuthenticationExpired });

    expect(onAuthenticationExpired).toHaveBeenCalledTimes(1);
    const rendered = text(renderer!.root);
    expect(rendered).toContain("暂时无法加载账号数据。");
    expect(rendered).not.toContain("账号概览");
  });

  it("reports a typed fetch failure without presenting empty counts as healthy", async () => {
    vi.mocked(adminAccountApi.fetchOverview).mockResolvedValueOnce(failure("forbidden", "只有管理员可以查看账号。"));
    await mountOverview();

    const rendered = text(renderer!.root);
    expect(rendered).toContain("只有管理员可以查看账号。");
    expect(rendered).toContain("暂时无法加载账号数据。");
    expect(rendered).not.toContain("账号概览");
    expect(rendered).not.toContain("可用邀请");
    expect(loadStatus()).toBe("stale");
  });

  it("keeps loaded account data visible and marks it stale after a refresh failure", async () => {
    await mountOverview();
    vi.mocked(adminAccountApi.fetchOverview).mockResolvedValueOnce(failure("server", "账号服务暂时不可用。"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await flush();

    const rendered = text(renderer!.root);
    expect(rendered).toContain("@alice");
    expect(rendered).toContain("数据可能已过期");
    expect(rendered).toContain("账号服务暂时不可用。");
    expect(loadStatus()).toBe("stale");
  });

  it("discards a previous admin's late result after the account identity changes", async () => {
    const onAuthenticationExpired = vi.fn();
    const staleFetch = deferred<ApiResult<AccountOverviewData>>();
    vi.mocked(adminAccountApi.fetchOverview).mockImplementationOnce(() => staleFetch.promise);
    vi.mocked(adminAccountApi.fetchOverview).mockResolvedValueOnce(success(accountOverview([accountUser("brad")], [])));

    const props = await mountOverview({ user: accountUser("ada"), onAuthenticationExpired });
    expect(text(renderer!.root)).toContain("正在加载账号数据…");

    await rerenderOverview({ ...props, user: accountUser("brad") });
    expect(text(renderer!.root)).toContain("@brad");

    staleFetch.resolve(success(accountOverview([accountUser("zoe")])));
    await flush();

    const rendered = text(renderer!.root);
    expect(rendered).toContain("@brad");
    expect(rendered).not.toContain("@zoe");
    expect(onAuthenticationExpired).not.toHaveBeenCalled();
  });
});

describe("useAdminTestingData pause/resume (enabled option)", () => {
  it("issues no QA requests while disabled, including across poll intervals", async () => {
    const hook = await mountHookHarness(accountUser("admin"), false);

    expect(testingApi.fetchSummary).not.toHaveBeenCalled();
    expect(testingApi.fetchSessions).not.toHaveBeenCalled();
    expect(testingApi.fetchOperations).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });

    expect(testingApi.fetchSummary).not.toHaveBeenCalled();
    expect(hook.current.testing).toBeNull();
    expect(hook.current.status).toBe("loading");
  });

  it("loads on first enable and then polls normally", async () => {
    const hook = await mountHookHarness(accountUser("admin"), false);
    await hook.rerender(accountUser("admin"), true);

    expect(testingApi.fetchSummary).toHaveBeenCalledTimes(1);
    expect(hook.current.testing).toEqual(stats("initial"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(testingApi.fetchSummary).toHaveBeenCalledTimes(2);
  });

  it("pausing stops background polls but keeps caches, manual refresh and mutations alive", async () => {
    const hook = await mountHookHarness(accountUser("admin"), true);
    expect(hook.current.testing).toEqual(stats("initial"));
    expect(hook.current.sessions.map((item) => item.sessionId)).toEqual(["initial"]);

    await hook.rerender(accountUser("admin"), false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });

    // No background polls, but the loaded QA data survives the pause.
    expect(testingApi.fetchSummary).toHaveBeenCalledTimes(1);
    expect(hook.current.testing).toEqual(stats("initial"));
    expect(hook.current.sessions.map((item) => item.sessionId)).toEqual(["initial"]);

    // Manual refresh still works while paused.
    vi.mocked(testingApi.fetchSummary).mockResolvedValue(success(stats("manual")));
    await act(async () => {
      await hook.current.refresh();
    });
    expect(testingApi.fetchSummary).toHaveBeenCalledTimes(2);
    expect(hook.current.testing).toEqual(stats("manual"));

    // Mutations still run and complete their follow-up role refresh.
    vi.mocked(testingApi.fetchOperations).mockResolvedValue(
      success({ operations: operations("paused-mutation"), policies: [policy("paused-mutation")] })
    );
    await act(async () => {
      await hook.current.createRun({ name: "paused-run", build: "build", owner: "admin" });
    });
    expect(testingApi.createRun).toHaveBeenCalledWith({ name: "paused-run", build: "build", owner: "admin" });
    expect(hook.current.operations?.runs[0]?.id).toBe("paused-mutation");

    // The pause still suppresses interval polling after all that.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    expect(testingApi.fetchSummary).toHaveBeenCalledTimes(2);
  });

  it("re-enabling refreshes current data and resumes polling without wiping sessions", async () => {
    const hook = await mountHookHarness(accountUser("admin"), true);
    await hook.rerender(accountUser("admin"), false);

    vi.mocked(testingApi.fetchSummary).mockResolvedValue(success(stats("resumed")));
    vi.mocked(testingApi.fetchSessions).mockResolvedValue(
      success(page([session("initial", 10), session("resumed", 20)], "next-page", 2))
    );
    await hook.rerender(accountUser("admin"), true);

    expect(testingApi.fetchSummary).toHaveBeenCalledTimes(2);
    expect(hook.current.testing).toEqual(stats("resumed"));
    expect(hook.current.sessions.map((item) => item.sessionId)).toEqual(["resumed", "initial"]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(testingApi.fetchSummary).toHaveBeenCalledTimes(3);
  });

  it("still masks and clears the old scope on identity change while disabled", async () => {
    const hook = await mountHookHarness(accountUser("admin"), true);
    expect(hook.current.testing).toEqual(stats("initial"));

    await hook.rerender(accountUser("other"), false);
    expect(hook.current.testing).toBeNull();
    expect(hook.current.sessions).toEqual([]);
    expect(hook.current.operations).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    expect(testingApi.fetchSummary).toHaveBeenCalledTimes(1);

    await hook.rerender(accountUser("other"), true);
    expect(testingApi.fetchSummary).toHaveBeenCalledTimes(2);
  });

  it("commits an in-flight QA load that completes after pausing", async () => {
    const pendingSummary = deferred<ApiResult<TestingStats>>();
    vi.mocked(testingApi.fetchSummary).mockImplementationOnce(() => pendingSummary.promise);
    const hook = await mountHookHarness(accountUser("admin"), true);
    expect(hook.current.testing).toBeNull();

    await hook.rerender(accountUser("admin"), false);
    pendingSummary.resolve(success(stats("late-commit")));
    await flush();

    expect(hook.current.testing).toEqual(stats("late-commit"));
    expect(hook.current.status).toBe("ready");
  });
});
