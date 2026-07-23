import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TesterSessionSummary, TestingStats } from "../shared/agent";
import type { TestingOperationsSnapshot, TestingPolicy, TestingRun } from "../shared/testing";
import { useAdminTestingData, type AdminTestingData } from "../src/components/admin/useAdminTestingData";
import type { ApiResult } from "../src/lib/api-client";
import type { AuthUser } from "../src/lib/auth";
import { testingApi } from "../src/lib/testing-api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("window", globalThis);

function success<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function failure(
  kind: "unauthorized" | "forbidden" | "conflict" | "unavailable",
  message = "请求失败"
): ApiResult<never> {
  return { ok: false, error: { kind, message } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function user(id: string, role: AuthUser["role"] = "admin"): AuthUser {
  return {
    id,
    username: id,
    displayName: id,
    role,
    createdAt: 1,
    lastLoginAt: 1
  };
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

function page(items: TesterSessionSummary[], nextCursor?: string) {
  return { items, nextCursor, total: items.length };
}

type RenderRecord = {
  scope: string;
  data: AdminTestingData;
};

function Probe({
  user: currentUser,
  onAuthenticationExpired,
  onRender
}: {
  user: AuthUser;
  onAuthenticationExpired: () => void;
  onRender: (record: RenderRecord) => void;
}) {
  const data = useAdminTestingData({ user: currentUser, onAuthenticationExpired });
  onRender({ scope: `${currentUser.id}:${currentUser.role}`, data });
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountHook(currentUser: AuthUser, onAuthenticationExpired = vi.fn()) {
  const records: RenderRecord[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <Probe
        user={currentUser}
        onAuthenticationExpired={onAuthenticationExpired}
        onRender={(record) => records.push(record)}
      />
    );
  });
  await flush();

  return {
    records,
    renderer,
    get current() {
      return records.at(-1)!.data;
    },
    async rerender(nextUser: AuthUser) {
      await act(async () => {
        renderer.update(
          <Probe
            user={nextUser}
            onAuthenticationExpired={onAuthenticationExpired}
            onRender={(record) => records.push(record)}
          />
        );
      });
    }
  };
}

const mountedRenderers: ReactTestRenderer[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  const originalConsoleError = console.error;
  vi.spyOn(console, "error").mockImplementation((message: unknown, ...optionalParams: unknown[]) => {
    if (message === "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer") {
      return;
    }
    originalConsoleError(message, ...optionalParams);
  });
  vi.spyOn(testingApi, "fetchSummary").mockResolvedValue(success(stats("initial")));
  vi.spyOn(testingApi, "fetchSessions").mockResolvedValue(success(page([session("initial", 10)], "next-page")));
  vi.spyOn(testingApi, "fetchOperations").mockResolvedValue(
    success({ operations: operations("initial"), policies: [policy("initial")] })
  );
  vi.spyOn(testingApi, "fetchRuns").mockResolvedValue(success([run("initial")]));
  vi.spyOn(testingApi, "fetchSession").mockResolvedValue(success(session("detail", 20)));
  vi.spyOn(testingApi, "updateSessionNotes").mockResolvedValue(success(session("notes", 20)));
  vi.spyOn(testingApi, "clear").mockResolvedValue(success({ removedTesters: 0, removedSessions: 1 }));
  vi.spyOn(testingApi, "createRun").mockResolvedValue(success(run("created")));
  vi.spyOn(testingApi, "updateRun").mockResolvedValue(success(run("updated")));
  vi.spyOn(testingApi, "createAssignment").mockResolvedValue(success(run("assigned")));
  vi.spyOn(testingApi, "saveReview");
  vi.spyOn(testingApi, "createPolicy");
});

afterEach(async () => {
  await act(async () => {
    for (const renderer of mountedRenderers.splice(0)) renderer.unmount();
  });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function trackedHook(currentUser: AuthUser, onAuthenticationExpired = vi.fn()) {
  const mounted = await mountHook(currentUser, onAuthenticationExpired);
  mountedRenderers.push(mounted.renderer);
  return mounted;
}

describe("useAdminTestingData concurrency", () => {
  it("does not expose or return a cached detail during a scope transition render", async () => {
    const hook = await trackedHook(user("admin"));
    let cached!: TesterSessionSummary | null;
    await act(async () => {
      cached = await hook.current.loadSession("detail");
    });
    expect(cached?.sessionId).toBe("detail");
    vi.mocked(testingApi.fetchSession).mockClear();
    const nextSummary = deferred<ApiResult<TestingStats>>();
    const nextSessions = deferred<Awaited<ReturnType<typeof testingApi.fetchSessions>>>();
    const nextRuns = deferred<Awaited<ReturnType<typeof testingApi.fetchRuns>>>();
    vi.mocked(testingApi.fetchSummary).mockReturnValue(nextSummary.promise);
    vi.mocked(testingApi.fetchSessions).mockReturnValue(nextSessions.promise);
    vi.mocked(testingApi.fetchRuns).mockReturnValue(nextRuns.promise);

    let transitionLoad!: Promise<TesterSessionSummary | null>;
    act(() => {
      hook.renderer.update(
        <Probe
          user={user("tester", "tester")}
          onAuthenticationExpired={vi.fn()}
          onRender={(record) => {
            hook.records.push(record);
            if (!transitionLoad) transitionLoad = record.data.loadSession("detail");
          }}
        />
      );
    });

    await expect(transitionLoad).resolves.toBeNull();
    expect(testingApi.fetchSession).not.toHaveBeenCalled();
    expect(hook.current.sessionDetails).toEqual({});
    expect(hook.current.sessions).toEqual([]);
  });

  it("gives an explicit replacement refresh ownership over a competing ordinary refresh", async () => {
    const hook = await trackedHook(user("admin"));
    const replacementSummary = deferred<ApiResult<TestingStats>>();
    const replacementPage = deferred<Awaited<ReturnType<typeof testingApi.fetchSessions>>>();
    const replacementOperations = deferred<Awaited<ReturnType<typeof testingApi.fetchOperations>>>();
    vi.mocked(testingApi.fetchSummary).mockReset().mockReturnValue(replacementSummary.promise);
    vi.mocked(testingApi.fetchSessions).mockReset().mockReturnValue(replacementPage.promise);
    vi.mocked(testingApi.fetchOperations).mockReset().mockReturnValue(replacementOperations.promise);

    let replacementPromise!: Promise<void>;
    let ordinaryPromise!: Promise<void>;
    act(() => {
      replacementPromise = hook.current.refresh(true);
      ordinaryPromise = hook.current.refresh();
    });

    replacementSummary.resolve(success(stats("replacement")));
    replacementPage.resolve(success(page([session("replacement-only", 100)], "replacement-next")));
    replacementOperations.resolve(
      success({ operations: operations("replacement"), policies: [policy("replacement")] })
    );
    await act(async () => {
      await Promise.all([replacementPromise, ordinaryPromise]);
    });

    expect(testingApi.fetchSummary).toHaveBeenCalledTimes(1);
    expect(testingApi.fetchSessions).toHaveBeenCalledTimes(1);
    expect(testingApi.fetchOperations).toHaveBeenCalledTimes(1);
    expect(hook.current.sessions.map((item) => item.sessionId)).toEqual(["replacement-only"]);
    expect(hook.current.nextCursor).toBe("replacement-next");
  });

  it("makes clear invalidate older refresh and pagination writes and coalesces replacement refreshes", async () => {
    const hook = await trackedHook(user("admin"));
    const olderSummary = deferred<ApiResult<TestingStats>>();
    const olderPage = deferred<Awaited<ReturnType<typeof testingApi.fetchSessions>>>();
    const olderOperations = deferred<Awaited<ReturnType<typeof testingApi.fetchOperations>>>();
    const olderLoadMore = deferred<Awaited<ReturnType<typeof testingApi.fetchSessions>>>();
    const replacementSummary = deferred<ApiResult<TestingStats>>();
    const replacementPage = deferred<Awaited<ReturnType<typeof testingApi.fetchSessions>>>();
    const replacementOperations = deferred<Awaited<ReturnType<typeof testingApi.fetchOperations>>>();

    vi.mocked(testingApi.fetchSummary)
      .mockReset()
      .mockReturnValue(replacementSummary.promise)
      .mockReturnValueOnce(olderSummary.promise)
      .mockReturnValueOnce(replacementSummary.promise);
    vi.mocked(testingApi.fetchSessions)
      .mockReset()
      .mockImplementation((query) => {
        if (query?.cursor) return olderLoadMore.promise;
        return vi.mocked(testingApi.fetchSessions).mock.calls.filter(([input]) => !input?.cursor).length === 1
          ? olderPage.promise
          : replacementPage.promise;
      });
    vi.mocked(testingApi.fetchOperations)
      .mockReset()
      .mockReturnValue(replacementOperations.promise)
      .mockReturnValueOnce(olderOperations.promise)
      .mockReturnValueOnce(replacementOperations.promise);

    let loadMorePromise!: Promise<void>;
    let olderRefreshPromise!: Promise<void>;
    let clearPromise!: Promise<boolean>;
    act(() => {
      loadMorePromise = hook.current.loadMore();
      olderRefreshPromise = hook.current.refresh();
      clearPromise = hook.current.clearEvidence({ scope: "all" });
    });
    await flush();

    let concurrentRefreshPromise!: Promise<void>;
    act(() => {
      concurrentRefreshPromise = hook.current.refresh();
    });
    expect(testingApi.fetchSummary).toHaveBeenCalledTimes(2);

    replacementSummary.resolve(success(stats("replacement")));
    replacementPage.resolve(success(page([session("replacement", 100)], "replacement-next")));
    replacementOperations.resolve(
      success({ operations: operations("replacement"), policies: [policy("replacement")] })
    );
    let cleared!: boolean;
    await act(async () => {
      cleared = await clearPromise;
      await concurrentRefreshPromise;
    });
    expect(cleared).toBe(true);
    expect(hook.current.sessions.map((item) => item.sessionId)).toEqual(["replacement"]);

    olderSummary.resolve(success(stats("older")));
    olderPage.resolve(success(page([session("older-refresh", 50)], "older-refresh-next")));
    olderOperations.resolve(success({ operations: operations("older"), policies: [policy("older")] }));
    olderLoadMore.resolve(success(page([session("older-page", 40)], "older-page-next")));
    await act(async () => {
      await Promise.all([olderRefreshPromise, loadMorePromise]);
    });

    expect(hook.current.sessions.map((item) => item.sessionId)).toEqual(["replacement"]);
    expect(hook.current.nextCursor).toBe("replacement-next");
    expect(hook.current.operations?.runs[0]?.id).toBe("replacement");
  });

  it("keeps replacement mode after a failed post-clear reload and reports that failure", async () => {
    const hook = await trackedHook(user("admin"));
    vi.mocked(testingApi.fetchSummary).mockResolvedValue(success(stats("after-clear")));
    vi.mocked(testingApi.fetchOperations).mockResolvedValue(
      success({ operations: operations("after-clear"), policies: [policy("after-clear")] })
    );
    vi.mocked(testingApi.fetchSessions)
      .mockReset()
      .mockResolvedValueOnce(failure("unavailable", "替换加载失败"))
      .mockResolvedValueOnce(success(page([session("retry", 200)], "retry-next")));

    let cleared!: boolean;
    await act(async () => {
      cleared = await hook.current.clearEvidence({ scope: "all" });
    });

    expect(cleared).toBe(false);
    expect(hook.current.sessions).toEqual([]);
    expect(hook.current.status).toBe("stale");
    expect(hook.current.error?.message).toBe("替换加载失败");

    await act(async () => {
      await hook.current.refresh();
    });
    expect(hook.current.sessions.map((item) => item.sessionId)).toEqual(["retry"]);
    expect(hook.current.status).toBe("ready");
    expect(hook.current.error).toBeNull();
  });

  it("masks prior data synchronously on both role and account transitions", async () => {
    const hook = await trackedHook(user("same", "admin"));
    const neverSummary = deferred<ApiResult<TestingStats>>();
    const neverSessions = deferred<Awaited<ReturnType<typeof testingApi.fetchSessions>>>();
    const neverRuns = deferred<Awaited<ReturnType<typeof testingApi.fetchRuns>>>();
    vi.mocked(testingApi.fetchSummary).mockReturnValue(neverSummary.promise);
    vi.mocked(testingApi.fetchSessions).mockReturnValue(neverSessions.promise);
    vi.mocked(testingApi.fetchRuns).mockReturnValue(neverRuns.promise);

    await hook.rerender(user("same", "tester"));
    const firstRoleRender = hook.records.find((record) => record.scope === "same:tester")!;
    expect(firstRoleRender.data.sessions).toEqual([]);
    expect(firstRoleRender.data.sessionDetails).toEqual({});
    expect(firstRoleRender.data.operations).toBeNull();
    expect(firstRoleRender.data.status).toBe("loading");

    await hook.rerender(user("next", "tester"));
    const firstAccountRender = hook.records.find((record) => record.scope === "next:tester")!;
    expect(firstAccountRender.data.sessions).toEqual([]);
    expect(firstAccountRender.data.runs).toEqual([]);
    expect(firstAccountRender.data.lastSyncedAt).toBeNull();
  });

  it("expires the current account when an older same-scope refresh returns unauthorized", async () => {
    const onAuthenticationExpired = vi.fn();
    const hook = await trackedHook(user("admin"), onAuthenticationExpired);
    const olderSummary = deferred<ApiResult<TestingStats>>();
    const olderPage = deferred<Awaited<ReturnType<typeof testingApi.fetchSessions>>>();
    const olderOperations = deferred<Awaited<ReturnType<typeof testingApi.fetchOperations>>>();

    vi.mocked(testingApi.fetchSummary)
      .mockReset()
      .mockReturnValueOnce(olderSummary.promise)
      .mockResolvedValueOnce(success(stats("newer")));
    vi.mocked(testingApi.fetchSessions)
      .mockReset()
      .mockReturnValueOnce(olderPage.promise)
      .mockResolvedValueOnce(success(page([session("newer", 30)])));
    vi.mocked(testingApi.fetchOperations)
      .mockReset()
      .mockReturnValueOnce(olderOperations.promise)
      .mockResolvedValueOnce(success({ operations: operations("newer"), policies: [policy("newer")] }));

    let olderPromise!: Promise<void>;
    act(() => {
      olderPromise = hook.current.refresh();
    });
    await act(async () => {
      await hook.current.refresh();
    });

    olderSummary.resolve(failure("unauthorized", "会话已过期"));
    olderPage.resolve(success(page([session("older", 20)])));
    olderOperations.resolve(success({ operations: operations("older"), policies: [policy("older")] }));
    await act(async () => {
      await olderPromise;
    });

    expect(onAuthenticationExpired).toHaveBeenCalledTimes(1);
    expect(hook.current.sessions.map((item) => item.sessionId)).toEqual(["newer", "initial"]);
  });

  it("returns mutation validation failures without poisoning global sync state", async () => {
    const hook = await trackedHook(user("admin"));
    vi.mocked(testingApi.createRun).mockResolvedValue(failure("conflict", "同名发布验证已存在"));

    let result!: Awaited<ReturnType<typeof hook.current.createRun>>;
    await act(async () => {
      result = await hook.current.createRun({ name: "重复", build: "build", owner: "admin" });
    });

    expect(result).toEqual(failure("conflict", "同名发布验证已存在"));
    expect(hook.current.status).toBe("ready");
    expect(hook.current.error).toBeNull();
  });

  it("surfaces a typed sync error when saving notes fails without dropping evidence", async () => {
    const hook = await trackedHook(user("admin"));
    vi.mocked(testingApi.updateSessionNotes).mockResolvedValue(failure("unavailable", "备注保存失败"));

    let saved!: boolean;
    await act(async () => {
      saved = await hook.current.saveNotes("initial", "保留证据");
    });

    expect(saved).toBe(false);
    expect(hook.current.status).toBe("stale");
    expect(hook.current.error).toEqual({
      kind: "unavailable",
      message: "备注保存失败"
    });
    expect(hook.current.sessions.map((item) => item.sessionId)).toEqual(["initial"]);
  });

  it("surfaces clear uncertainty as stale typed state without dropping evidence", async () => {
    const hook = await trackedHook(user("admin"));
    vi.mocked(testingApi.clear).mockResolvedValue(failure("unavailable", "无法确认清除结果"));

    let cleared!: boolean;
    await act(async () => {
      cleared = await hook.current.clearEvidence({ scope: "all" });
    });

    expect(cleared).toBe(false);
    expect(hook.current.status).toBe("stale");
    expect(hook.current.error).toEqual({
      kind: "unavailable",
      message: "无法确认清除结果"
    });
    expect(hook.current.sessions.map((item) => item.sessionId)).toEqual(["initial"]);
  });

  it("lets the last-started role read win across mutation refreshes and full polling", async () => {
    const hook = await trackedHook(user("admin"));
    const mutationOperations = deferred<Awaited<ReturnType<typeof testingApi.fetchOperations>>>();
    const fullOperations = deferred<Awaited<ReturnType<typeof testingApi.fetchOperations>>>();
    vi.mocked(testingApi.fetchOperations)
      .mockReset()
      .mockReturnValueOnce(mutationOperations.promise)
      .mockReturnValueOnce(fullOperations.promise);
    vi.mocked(testingApi.fetchSummary).mockResolvedValue(success(stats("full")));
    vi.mocked(testingApi.fetchSessions).mockResolvedValue(success(page([session("full", 40)])));

    let mutationPromise!: Promise<ApiResult<TestingRun>>;
    act(() => {
      mutationPromise = hook.current.createRun({ name: "run", build: "build", owner: "admin" });
    });
    await flush();

    let fullPromise!: Promise<void>;
    act(() => {
      fullPromise = hook.current.refresh();
    });
    await flush();
    fullOperations.resolve(success({ operations: operations("newer-full"), policies: [policy("newer-full")] }));
    await act(async () => {
      await fullPromise;
    });
    expect(hook.current.operations?.runs[0]?.id).toBe("newer-full");

    mutationOperations.resolve(
      success({ operations: operations("older-mutation"), policies: [policy("older-mutation")] })
    );
    await act(async () => {
      await mutationPromise;
    });
    expect(hook.current.operations?.runs[0]?.id).toBe("newer-full");
  });

  it("clears a role-refresh transport error after the next authoritative role refresh succeeds", async () => {
    const hook = await trackedHook(user("admin"));
    vi.mocked(testingApi.fetchOperations)
      .mockReset()
      .mockResolvedValueOnce(failure("unavailable", "操作数据刷新失败"))
      .mockResolvedValueOnce(success({ operations: operations("recovered"), policies: [policy("recovered")] }));

    await act(async () => {
      await hook.current.createRun({ name: "first", build: "build-1", owner: "admin" });
    });
    expect(hook.current.status).toBe("stale");
    expect(hook.current.error?.message).toBe("操作数据刷新失败");

    await act(async () => {
      await hook.current.createRun({ name: "second", build: "build-2", owner: "admin" });
    });
    expect(hook.current.operations?.runs[0]?.id).toBe("recovered");
    expect(hook.current.status).toBe("ready");
    expect(hook.current.error).toBeNull();
  });

  it("polls once at 10 seconds and clears the old scope timer on unmount", async () => {
    const hook = await trackedHook(user("admin"));
    vi.mocked(testingApi.fetchSummary).mockClear();
    vi.mocked(testingApi.fetchSessions).mockClear();
    vi.mocked(testingApi.fetchOperations).mockClear();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(testingApi.fetchSummary).toHaveBeenCalledTimes(1);
    expect(testingApi.fetchSessions).toHaveBeenCalledTimes(1);
    expect(testingApi.fetchOperations).toHaveBeenCalledTimes(1);

    await act(async () => {
      hook.renderer.unmount();
    });
    vi.advanceTimersByTime(20_000);
    await flush();
    expect(testingApi.fetchSummary).toHaveBeenCalledTimes(1);
    expect(testingApi.fetchSessions).toHaveBeenCalledTimes(1);
    expect(testingApi.fetchOperations).toHaveBeenCalledTimes(1);
  });
});
