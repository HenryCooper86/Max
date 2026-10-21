import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestingStats } from "../shared/agent";
import type {
  TestingAuditEvent,
  TestingOperationsSnapshot,
  TestingPolicy,
  TestingRun,
  TestingRunRequirement
} from "../shared/testing";
import { GovernanceWorkspace } from "../src/components/admin/GovernanceWorkspace";
import { ReleaseValidation } from "../src/components/admin/ReleaseValidation";
import { LanguageProvider, LanguageToggle } from "../src/components/LanguageToggle";
import type { AdminTestingData } from "../src/components/admin/useAdminTestingData";
import { setWorkspaceLocation } from "../src/components/admin/workspace-location";
import type { HelmetAgent } from "../src/hooks/useHelmetAgent";
import type { ApiResult } from "../src/lib/api-client";
import type { AuthUser } from "../src/lib/auth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("window", globalThis);

function authUser(role: AuthUser["role"]): AuthUser {
  return {
    id: role,
    username: role,
    displayName: role,
    role,
    createdAt: 1,
    lastLoginAt: 1
  };
}

function policy(version: string, latency = 800): TestingPolicy {
  return {
    version,
    createdAt: 1,
    createdBy: "admin",
    description: `策略 ${version}`,
    active: true,
    release: {
      maxFailSessions: 0,
      maxWatchSessions: 1,
      maxInvalidSessions: 0,
      maxP95LatencyMs: latency,
      minStandardSessions: 1,
      minSafetyCriticalSessions: 3,
      requiredPlatforms: ["web"]
    },
    regression: {
      minimumMatchedCohortSessions: 1,
      latencyWatchDeltaMs: 50,
      latencyFailDeltaMs: 100,
      scoreWatchDelta: -5,
      scoreFailDelta: -10
    }
  };
}

function requirement(id: string): TestingRunRequirement {
  return {
    id,
    testCaseId: "standard-navigation",
    platform: "web",
    networkType: "wifi",
    language: "zh",
    requiredValidSessions: 1
  };
}

function run(): TestingRun {
  return {
    id: "run-1",
    name: "候选发布",
    build: "build-1",
    status: "ready",
    owner: "reviewer",
    createdAt: 1,
    updatedAt: 1,
    policyVersion: "v1",
    requirements: [requirement("requirement-1"), requirement("requirement-2")],
    assignments: [],
    notes: ""
  };
}

function operations(activePolicy = policy("v1"), runs = [run()]): TestingOperationsSnapshot {
  return {
    activePolicy,
    runs,
    reviews: [],
    audit: [
      {
        id: "audit-1",
        at: 1,
        actor: "admin",
        action: "policy.publish",
        targetType: "policy",
        targetId: activePolicy.version,
        detail: {}
      }
    ]
  };
}

function adminData(snapshot = operations()): AdminTestingData {
  return {
    testing: null,
    sessions: [],
    sessionDetails: {},
    operations: snapshot,
    policies: [snapshot.activePolicy],
    runs: [],
    nextCursor: undefined,
    sessionTotal: 0,
    status: "ready",
    error: null,
    lastSyncedAt: 1,
    searchResults: [],
    searchTotal: 0,
    searchCursor: undefined,
    searchStatus: "idle",
    searchError: null,
    searchSessions: vi.fn().mockResolvedValue(undefined),
    clearSearch: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    loadMore: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn().mockResolvedValue(null),
    saveNotes: vi.fn().mockResolvedValue(true),
    clearEvidence: vi.fn().mockResolvedValue(true),
    createRun: vi.fn(),
    updateRun: vi.fn(),
    createAssignment: vi.fn(),
    saveReview: vi.fn(),
    createPolicy: vi.fn()
  };
}

function agent(): HelmetAgent {
  return {
    health: { build: { gitCommit: "build-current" } },
    setTestingAssignmentContext: vi.fn()
  } as unknown as HelmetAgent;
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.find((node) => node.type === "button" && text(node) === label);
}

/** Text of the rendered audit event rows only, excluding the filter bar whose
 * dropdown options duplicate the same action labels. */
function auditEventsText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByProps({ className: "auditEvent" })
    .map((node) => text(node))
    .join("\n");
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

beforeEach(() => {
  const originalConsoleError = console.error;
  vi.spyOn(console, "error").mockImplementation((message: unknown, ...optionalParams: unknown[]) => {
    if (message === "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer") return;
    originalConsoleError(message, ...optionalParams);
  });
});

afterEach(async () => {
  if (renderer) {
    await act(async () => renderer?.unmount());
    renderer = null;
  }
  vi.restoreAllMocks();
});

type AdminLocationStub = { back: () => void; restore: () => void; hash: () => string };

/** react-test-renderer has no DOM history; stand in for location/history/hashchange
 * so URL-driven release selection can be exercised end to end. */
function stubAdminLocation(initialHash = ""): AdminLocationStub {
  const hashListeners = new Set<() => void>();
  const pushedHashes: string[] = [];
  const location = { hash: initialHash };
  const history = {
    pushState: (_state: unknown, _title: string, url: string) => {
      pushedHashes.push(location.hash);
      location.hash = url;
    },
    replaceState: (_state: unknown, _title: string, url: string) => {
      location.hash = url;
    },
    back: () => {
      const previous = pushedHashes.pop();
      if (previous !== undefined) location.hash = previous;
    }
  };
  const scope = globalThis as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>([
    ["location", scope.location],
    ["history", scope.history],
    ["addEventListener", scope.addEventListener],
    ["removeEventListener", scope.removeEventListener],
    ["dispatchEvent", scope.dispatchEvent]
  ]);
  const fireHashChange = () => {
    for (const listener of [...hashListeners]) listener();
  };
  scope.location = location;
  scope.history = history;
  scope.addEventListener = (type: string, listener: () => void) => {
    if (type === "hashchange") hashListeners.add(listener);
  };
  scope.removeEventListener = (type: string, listener: () => void) => {
    if (type === "hashchange") hashListeners.delete(listener);
  };
  scope.dispatchEvent = (event: Event) => {
    if (event.type === "hashchange") fireHashChange();
    return true;
  };
  return {
    back: () => {
      history.back();
      fireHashChange();
    },
    restore: () => {
      for (const [key, value] of originals) {
        if (value === undefined) delete scope[key];
        else scope[key] = value;
      }
    },
    hash: () => location.hash
  };
}

describe("ReleaseValidation", () => {
  let locationStub: AdminLocationStub | null = null;

  afterEach(async () => {
    // Unmount while the location/history/EventTarget stub is still installed so
    // effect cleanups (window.removeEventListener) can run, then restore globals.
    if (renderer) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
    locationStub?.restore();
    locationStub = null;
  });

  it("approves only through a dedicated two-step action that re-checks every blocker", async () => {
    const snapshot = adminData();
    const candidate = snapshot.operations!.runs[0]!;
    candidate.assignments = candidate.requirements.map((requirement, index) => ({
      id: `assignment-${index}`,
      runId: candidate.id,
      requirementId: requirement.id,
      testCaseId: requirement.testCaseId,
      assignee: "admin",
      platform: "web",
      networkType: "wifi",
      language: "zh",
      status: "complete",
      createdAt: 1,
      updatedAt: 1,
      completedSessionIds: [`session-${index}`]
    }));
    snapshot.testing = {
      releaseGate: { build: "build-1", status: "pass", blockers: [] },
      regression: { baselineSource: "none", status: "insufficient", findings: [] }
    } as unknown as TestingStats;
    let healthBuild = "build-1";
    const render = () => (
      <ReleaseValidation
        agent={{
          ...agent(),
          health: { ...agent().health!, build: { ...agent().health!.build!, gitCommit: healthBuild } }
        }}
        user={authUser("admin")}
        data={snapshot}
      />
    );
    await act(async () => {
      renderer = create(render());
    });
    const lifecycleSelect = () =>
      renderer!.root.find((node) => node.type === "select" && node.props["aria-label"] === "发布运行状态");
    // The generic lifecycle select must never approve.
    expect(
      lifecycleSelect()
        .findAllByType("option")
        .map((option) => option.props.value)
    ).not.toContain("approved");
    await act(async () => lifecycleSelect().props.onChange({ target: { value: "approved" } }));
    expect(snapshot.updateRun).not.toHaveBeenCalled();
    expect(text(renderer!.root)).toContain("请使用“批准发布”操作完成批准");

    // Step one: explicit confirmation showing build and readiness.
    await act(async () => button(renderer!, "批准发布…").props.onClick());
    const dialog = renderer!.root.findByProps({ role: "dialog" });
    expect(text(dialog)).toContain("build-1");
    expect(text(dialog)).toContain("2/2 · 100%");
    expect(button(renderer!, "确认批准").props.disabled).toBe(false);

    // Step two re-evaluates: stale builds, moved runs, stale data and open reviews all block.
    healthBuild = "build-new";
    await act(async () => renderer!.update(render()));
    expect(text(renderer!.root)).toContain("证据构建与当前构建不一致");
    expect(button(renderer!, "确认批准").props.disabled).toBe(true);
    healthBuild = "build-1";
    candidate.build = "build-moved";
    await act(async () => renderer!.update(render()));
    expect(text(renderer!.root)).toContain("构建在确认期间发生了变化");
    expect(button(renderer!, "确认批准").props.disabled).toBe(true);
    candidate.build = "build-1";
    snapshot.status = "stale";
    await act(async () => renderer!.update(render()));
    expect(text(renderer!.root)).toContain("发布数据尚未同步");
    expect(button(renderer!, "确认批准").props.disabled).toBe(true);
    snapshot.status = "ready";
    snapshot.operations!.reviews = [
      {
        id: "review",
        sessionId: "session-0",
        runId: candidate.id,
        status: "open",
        severity: "high",
        owner: "admin",
        title: "Warning",
        comment: "Missing audible start",
        createdAt: 1,
        updatedAt: 1,
        createdBy: "admin"
      }
    ];
    await act(async () => renderer!.update(render()));
    expect(text(renderer!.root)).toContain("解决本运行未完成的证据复核");
    expect(button(renderer!, "确认批准").props.disabled).toBe(true);
    snapshot.operations!.reviews[0]!.runId = "another-run";
    await act(async () => renderer!.update(render()));
    expect(button(renderer!, "确认批准").props.disabled).toBe(false);

    vi.mocked(snapshot.updateRun).mockResolvedValue({ ok: true, data: { ...candidate, status: "approved" } });
    await act(async () => button(renderer!, "确认批准").props.onClick());
    await flush();
    expect(snapshot.updateRun).toHaveBeenCalledWith(candidate.id, { status: "approved" });
    expect(text(renderer!.root)).toContain("已批准");
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });

  it.each(["fail", "watch", "insufficient"] as const)(
    "blocks the dedicated approval on a %s regression despite quality PASS",
    async (regressionStatus) => {
      const snapshot = adminData();
      snapshot.testing = {
        releaseGate: { build: "build-1", status: "pass" },
        regression: {
          baselineSource: "latest-valid",
          status: regressionStatus,
          findings: [{ id: "latency", status: "fail", label: "iOS wake", detail: "Latency increased by 259ms." }]
        }
      } as unknown as TestingStats;
      await act(async () => {
        renderer = create(<ReleaseValidation agent={agent()} user={authUser("admin")} data={snapshot} />);
      });
      const status = renderer!.root.find(
        (node) => node.type === "select" && node.props["aria-label"] === "发布运行状态"
      );
      expect(status.findAllByType("option").map((option) => option.props.value)).not.toContain("approved");
      await act(async () => button(renderer!, "批准发布…").props.onClick());
      const dialog = renderer!.root.findByProps({ role: "dialog" });
      expect(text(dialog)).toContain("Latency increased by 259ms.");
      expect(button(renderer!, "确认批准").props.disabled).toBe(true);
    }
  );

  it("uses English for release counts and successful create, status, and assignment actions", async () => {
    const sharedData = adminData();
    vi.mocked(sharedData.createRun).mockResolvedValue({ ok: true, data: run() });
    vi.mocked(sharedData.updateRun).mockResolvedValue({ ok: true, data: { ...run(), status: "blocked" } });
    vi.mocked(sharedData.createAssignment).mockResolvedValue({ ok: true, data: run() });
    await act(async () => {
      renderer = create(
        <LanguageProvider>
          <LanguageToggle />
          <ReleaseValidation agent={agent()} user={authUser("admin")} data={sharedData} />
        </LanguageProvider>
      );
    });
    act(() => button(renderer!, "EN").props.onClick());
    const runList = renderer.root.findByProps({ className: "releaseRunList" });
    expect(text(runList)).toContain("0/2 samples");
    act(() => button(renderer!, "New release run").props.onClick());
    await act(async () => button(renderer!, "Create release run").props.onClick());
    expect(text(renderer.root)).toContain("Release run “候选发布” created with 2 coverage requirements.");
    act(() => button(renderer!, "中文").props.onClick());
    expect(text(renderer.root)).toContain("发布运行“候选发布”已创建，包含 2 项覆盖要求。");
    act(() => button(renderer!, "EN").props.onClick());
    expect(text(renderer.root)).toContain("Release run “候选发布” created with 2 coverage requirements.");
    await act(async () =>
      renderer!.root
        .find((node) => node.type === "select" && node.props["aria-label"] === "Release run status")
        .props.onChange({ target: { value: "blocked" } })
    );
    expect(text(renderer.root)).toContain("Release run status updated to Blocked.");
    await act(async () =>
      renderer!.root.findAll((node) => node.type === "button" && text(node) === "Assign task")[0].props.onClick()
    );
    expect(text(renderer.root)).toContain("Coverage task assigned to admin.");
  });

  it("keeps the create draft collapsed by default, locks it while creating, and restores it after failure", async () => {
    const pending = deferred<ApiResult<TestingRun>>();
    const sharedData = adminData();
    vi.mocked(sharedData.createRun).mockReturnValueOnce(pending.promise);
    await act(async () => {
      renderer = create(<ReleaseValidation agent={agent()} user={authUser("admin")} data={sharedData} />);
    });
    expect(renderer.root.findAllByProps({ className: "runCreateBar" })).toHaveLength(0);
    await act(async () => button(renderer!, "新建发布运行").props.onClick());
    const draft = renderer.root.findByProps({ className: "runCreateBar" });
    act(() => draft.findAllByType("input")[0].props.onChange({ target: { value: "Keep this draft" } }));
    await act(async () => {
      void button(renderer!, "创建发布运行").props.onClick();
    });
    expect(draft.findAllByType("input").every((field) => field.props.disabled)).toBe(true);
    expect(button(renderer, "正在创建…").props.disabled).toBe(true);
    pending.resolve({ ok: false, error: { kind: "unavailable", message: "Try again" } });
    await flush();
    expect(draft.findAllByType("input").every((field) => !field.props.disabled)).toBe(true);
    expect(draft.findAllByType("input")[0].props.value).toBe("Keep this draft");
    act(() => button(renderer!, "收起创建表单").props.onClick());
    expect(text(renderer.root.findByProps({ className: "releaseHeadActions" }))).toContain("草稿已保留");
  });

  it("keeps unrelated assignment actions enabled and shows the typed server error", async () => {
    const pending = deferred<ApiResult<TestingRun>>();
    const sharedData = adminData();
    vi.mocked(sharedData.createAssignment).mockReturnValueOnce(pending.promise);
    await act(async () => {
      renderer = create(<ReleaseValidation agent={agent()} user={authUser("reviewer")} data={sharedData} />);
    });

    const assignmentButtons = renderer.root.findAll((node) => node.type === "button" && text(node) === "分配任务");
    act(() => assignmentButtons[0].props.onClick());
    expect(assignmentButtons[0].props.disabled).toBe(true);
    expect(assignmentButtons[1].props.disabled).toBe(false);

    await act(async () => {
      pending.resolve({ ok: false, error: { kind: "conflict", message: "该覆盖任务已被分配。" } });
      await pending.promise;
    });
    expect(text(renderer.root)).toContain("该覆盖任务已被分配。");

    vi.mocked(sharedData.createAssignment).mockResolvedValueOnce({ ok: true, data: run() });
    await act(async () => assignmentButtons[1].props.onClick());
    await flush();
    expect(text(renderer.root)).not.toContain("该覆盖任务已被分配。");
    expect(text(renderer.root)).toContain("覆盖任务已分配");
  });

  it("owns concurrent assignment busy state and notices by run plus requirement", async () => {
    const pendingA = deferred<ApiResult<TestingRun>>();
    const pendingB = deferred<ApiResult<TestingRun>>();
    const runA = { ...run(), id: "run-a", name: "发布 A", requirements: [requirement("shared-requirement")] };
    const runB = { ...run(), id: "run-b", name: "发布 B", requirements: [requirement("shared-requirement")] };
    const sharedData = adminData(operations(policy("v1"), [runA]));
    vi.mocked(sharedData.createAssignment).mockReturnValueOnce(pendingA.promise).mockReturnValueOnce(pendingB.promise);
    const renderRun = async (selectedRun: TestingRun) => {
      await act(async () => {
        renderer?.update(
          <ReleaseValidation
            agent={agent()}
            user={authUser("reviewer")}
            data={{ ...sharedData, operations: operations(policy("v1"), [selectedRun]) }}
          />
        );
      });
    };

    await act(async () => {
      renderer = create(<ReleaseValidation agent={agent()} user={authUser("reviewer")} data={sharedData} />);
    });
    act(() => button(renderer, "分配任务").props.onClick());
    expect(button(renderer, "正在分配…").props.disabled).toBe(true);

    await renderRun(runB);
    expect(button(renderer, "分配任务").props.disabled).toBe(false);
    act(() => button(renderer, "分配任务").props.onClick());
    expect(button(renderer, "正在分配…").props.disabled).toBe(true);

    await renderRun(runA);
    expect(button(renderer, "正在分配…").props.disabled).toBe(true);
    await act(async () => {
      pendingB.resolve({ ok: true, data: runB });
      await pendingB.promise;
    });
    await renderRun(runB);
    expect(button(renderer, "分配任务").props.disabled).toBe(false);
    expect(text(renderer.root)).toContain("覆盖任务已分配");

    await renderRun(runA);
    expect(button(renderer, "正在分配…").props.disabled).toBe(true);
    await act(async () => {
      pendingA.resolve({ ok: false, error: { kind: "conflict", message: "A 的旧失败不应覆盖 B。" } });
      await pendingA.promise;
    });
    expect(button(renderer, "分配任务").props.disabled).toBe(false);
    expect(text(renderer.root)).toContain("覆盖任务已分配");
    expect(text(renderer.root)).not.toContain("A 的旧失败不应覆盖 B。");
  });

  it("keeps approval admin-only while preserving tester assignment guidance", async () => {
    const reviewerData = adminData();
    await act(async () => {
      renderer = create(<ReleaseValidation agent={agent()} user={authUser("reviewer")} data={reviewerData} />);
    });
    const status = renderer.root.find((node) => node.type === "select" && node.props["aria-label"] === "发布运行状态");
    expect(status.findAllByType("option").map((option) => option.props.value)).not.toContain("approved");
    expect(renderer.root.findAll((node) => node.type === "button" && text(node) === "批准发布…")).toHaveLength(0);

    await act(async () => renderer?.unmount());
    const approvedRun = run();
    approvedRun.status = "approved";
    approvedRun.approvedBy = "admin";
    const approvedData = adminData(operations(policy("v1"), [approvedRun]));
    await act(async () => {
      renderer = create(<ReleaseValidation agent={agent()} user={authUser("reviewer")} data={approvedData} />);
    });
    const approvedOption = renderer.root
      .find((node) => node.type === "select" && node.props["aria-label"] === "发布运行状态")
      .find((node) => node.type === "option" && node.props.value === "approved");
    expect(approvedOption.props.disabled).toBe(true);
    expect(renderer.root.findAll((node) => node.type === "button" && text(node) === "批准发布…")).toHaveLength(0);

    await act(async () => renderer?.unmount());
    const nativeRun = run();
    nativeRun.assignments = [
      {
        id: "assignment-native",
        runId: nativeRun.id,
        requirementId: nativeRun.requirements[0].id,
        testCaseId: nativeRun.requirements[0].testCaseId,
        assignee: "tester",
        platform: "ios",
        networkType: "wifi",
        language: "zh",
        status: "in-progress",
        createdAt: 1,
        updatedAt: 1,
        completedSessionIds: []
      }
    ];
    const testerData = adminData(operations(policy("v1"), []));
    testerData.runs = [nativeRun];
    await act(async () => {
      renderer = create(<ReleaseValidation agent={agent()} user={authUser("tester")} data={testerData} />);
    });
    expect(text(renderer.root)).toContain("请打开 ios 客户端采集此任务");
  });

  it("tracks the selected run in the URL across refresh, Back, and section switches", async () => {
    locationStub = stubAdminLocation("#/admin/releases");
    const runB = { ...run(), id: "run-b", name: "发布 B" };
    const sharedData = adminData(operations(policy("v1"), [run(), runB]));
    const render = <ReleaseValidation agent={agent()} user={authUser("reviewer")} data={sharedData} />;
    await act(async () => {
      renderer = create(render);
    });
    const runButton = (name: string) =>
      renderer!.root
        .findByProps({ className: "releaseRunList" })
        .findAllByType("button")
        .find((node) => text(node).includes(name))!;
    act(() => runButton("发布 B").props.onClick());
    expect(locationStub.hash()).toBe("#/admin/releases?run=run-b");
    expect(runButton("发布 B").props.className).toBe("active");

    // A fresh mount reads the URL exactly like a page refresh.
    await act(async () => renderer!.unmount());
    await act(async () => {
      renderer = create(render);
    });
    expect(runButton("发布 B").props.className).toBe("active");

    // Browser Back restores the previous selection.
    act(() => locationStub!.back());
    expect(locationStub!.hash()).toBe("#/admin/releases");
    expect(runButton("候选发布").props.className).toBe("active");

    // Section switches never rewrite the URL from the hidden releases panel,
    // and the mounted create draft survives them.
    act(() => button(renderer!, "新建发布运行").props.onClick());
    const draft = renderer.root.findByProps({ className: "runCreateBar" });
    act(() => draft.findAllByType("input")[0].props.onChange({ target: { value: "Keep this draft" } }));
    act(() => setWorkspaceLocation("evidence"));
    expect(locationStub!.hash()).toBe("#/admin/evidence");
    expect(draft.findAllByType("input")[0].props.value).toBe("Keep this draft");
  });

  it("keeps a missing run's empty state from mutating the default run", async () => {
    locationStub = stubAdminLocation("#/admin/releases?run=gone");
    const snapshot = adminData();
    await act(async () => {
      renderer = create(<ReleaseValidation agent={agent()} user={authUser("admin")} data={snapshot} />);
    });
    expect(text(renderer!.root)).toContain("发布运行不可用");
    // A stale URL must never fall back to runs[0] and expose its mutation controls.
    expect(
      renderer!.root.findAll((node) => node.type === "select" && node.props["aria-label"] === "发布运行状态")
    ).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.type === "button" && text(node) === "批准发布…")).toHaveLength(0);
    expect(snapshot.updateRun).not.toHaveBeenCalled();

    // Recovery returns to the available-run list without dispatching a mutation.
    await act(async () => button(renderer!, "查看可用运行").props.onClick());
    expect(locationStub!.hash()).toBe("#/admin/releases");
    expect(snapshot.updateRun).not.toHaveBeenCalled();
    expect(
      renderer!.root.find((node) => node.type === "select" && node.props["aria-label"] === "发布运行状态")
    ).toBeDefined();
  });

  it("restores the remembered run URL when returning to the releases section", async () => {
    locationStub = stubAdminLocation("#/admin/releases");
    const runB = { ...run(), id: "run-b", name: "发布 B" };
    const sharedData = adminData(operations(policy("v1"), [run(), runB]));
    const render = <ReleaseValidation agent={agent()} user={authUser("reviewer")} data={sharedData} />;
    await act(async () => {
      renderer = create(render);
    });
    const runButton = (name: string) =>
      renderer!.root
        .findByProps({ className: "releaseRunList" })
        .findAllByType("button")
        .find((node) => text(node).includes(name))!;
    act(() => runButton("发布 B").props.onClick());
    expect(locationStub!.hash()).toBe("#/admin/releases?run=run-b");

    // Leave the section, then return: the hidden panel must re-assert its URL.
    act(() => setWorkspaceLocation("evidence"));
    expect(locationStub!.hash()).toBe("#/admin/evidence");
    act(() => setWorkspaceLocation("releases"));
    await flush();
    expect(locationStub!.hash()).toBe("#/admin/releases?run=run-b");
    expect(runButton("发布 B").props.className).toBe("active");

    // A refresh (fresh mount) keeps B from the restored URL.
    await act(async () => renderer!.unmount());
    await act(async () => {
      renderer = create(render);
    });
    expect(runButton("发布 B").props.className).toBe("active");
  });

  it("does not let an in-flight create completion hijack a newer run selection", async () => {
    locationStub = stubAdminLocation("#/admin/releases");
    const runB = { ...run(), id: "run-b", name: "发布 B" };
    const created = { ...run(), id: "run-new", name: "新发布" };
    const pending = deferred<ApiResult<TestingRun>>();
    const sharedData = adminData(operations(policy("v1"), [run(), runB]));
    vi.mocked(sharedData.createRun).mockReturnValueOnce(pending.promise);
    await act(async () => {
      renderer = create(<ReleaseValidation agent={agent()} user={authUser("reviewer")} data={sharedData} />);
    });
    await act(async () => button(renderer!, "新建发布运行").props.onClick());
    const runButton = (name: string) =>
      renderer!.root
        .findByProps({ className: "releaseRunList" })
        .findAllByType("button")
        .find((node) => text(node).includes(name))!;
    await act(async () => {
      void button(renderer!, "创建发布运行").props.onClick();
    });
    act(() => runButton("发布 B").props.onClick());
    expect(locationStub!.hash()).toBe("#/admin/releases?run=run-b");

    await act(async () => {
      pending.resolve({ ok: true, data: created });
      await pending.promise;
    });
    await flush();

    expect(locationStub!.hash()).toBe("#/admin/releases?run=run-b");
    expect(runButton("发布 B").props.className).toBe("active");
  });

  it("cannot redirect an in-flight create after the section unmounts", async () => {
    locationStub = stubAdminLocation("#/admin/releases");
    const created = { ...run(), id: "run-new", name: "新发布" };
    const pending = deferred<ApiResult<TestingRun>>();
    const sharedData = adminData();
    vi.mocked(sharedData.createRun).mockReturnValueOnce(pending.promise);
    await act(async () => {
      renderer = create(<ReleaseValidation agent={agent()} user={authUser("reviewer")} data={sharedData} />);
    });
    await act(async () => button(renderer!, "新建发布运行").props.onClick());
    await act(async () => {
      void button(renderer!, "创建发布运行").props.onClick();
    });
    await act(async () => renderer!.unmount());
    renderer = null;

    await act(async () => {
      pending.resolve({ ok: true, data: created });
      await pending.promise;
    });
    expect(locationStub!.hash()).toBe("#/admin/releases");
  });

  it("caps oversampled requirements so over-completing one never implies 100% overall", async () => {
    const snapshot = adminData();
    const candidate = snapshot.operations!.runs[0]!;
    candidate.assignments = [
      {
        id: "assignment-oversampled",
        runId: candidate.id,
        requirementId: "requirement-1",
        testCaseId: candidate.requirements[0]!.testCaseId,
        assignee: "admin",
        platform: "web",
        networkType: "wifi",
        language: "zh",
        status: "complete",
        createdAt: 1,
        updatedAt: 1,
        completedSessionIds: ["s-1", "s-2", "s-3"]
      }
    ];
    await act(async () => {
      renderer = create(<ReleaseValidation agent={agent()} user={authUser("reviewer")} data={snapshot} />);
    });
    const runList = renderer!.root.findByProps({ className: "releaseRunList" });
    expect(text(runList)).toContain("1/2");
    expect(text(runList)).not.toContain("3/2");
    const progress = renderer!.root.findByProps({ "aria-label": "覆盖进度" });
    expect(text(progress)).toContain("1/2");
    expect(text(progress)).toContain("50%");
    expect(text(progress)).not.toContain("100%");
  });
});

describe("GovernanceWorkspace", () => {
  function auditEvents(activeVersion = "v1"): TestingAuditEvent[] {
    return [
      {
        id: "audit-policy",
        at: Date.now() - 60_000,
        actor: "admin",
        action: "policy.created",
        targetType: "policy",
        targetId: activeVersion,
        detail: { previousVersion: "2026-07-15.1" }
      },
      {
        id: "audit-run",
        at: Date.now() - 120_000,
        actor: "reviewer",
        action: "run.updated",
        targetType: "run",
        targetId: "run-1",
        detail: { status: "ready", owner: "reviewer" }
      },
      {
        id: "audit-session",
        at: Date.now() - 180_000,
        actor: "admin",
        action: "session.notes-updated",
        targetType: "session",
        targetId: "session-1",
        detail: { notesLength: 24 }
      },
      {
        id: "audit-role",
        at: Date.now() - 240_000,
        actor: "admin",
        action: "account.role-changed",
        targetType: "account",
        targetId: "alice",
        detail: { role: "reviewer" }
      }
    ];
  }

  function governanceData(
    snapshot: TestingOperationsSnapshot = { ...operations(), audit: auditEvents() },
    policies: TestingPolicy[] = [snapshot.activePolicy]
  ): AdminTestingData {
    const data = adminData(snapshot);
    data.policies = policies;
    return data;
  }

  const latencyInput = () => renderer!.root.findByProps({ "aria-label": "发布 P95 上限（ms）" });
  const governanceFilterField = (label: string) =>
    renderer!.root.find((node) => node.props.className === "governanceFilterField" && text(node).startsWith(label));
  const clearFilterButtons = () =>
    renderer!.root.findAll((node) => node.type === "button" && text(node) === "清除筛选");

  it("keeps an unsaved draft across same-version and new-version polls, blocking publish until refreshed", async () => {
    await act(async () => {
      renderer = create(<GovernanceWorkspace user={authUser("admin")} data={governanceData()} />);
    });
    const latency = latencyInput();
    const rationale = renderer.root.findByType("textarea");
    act(() => {
      latency.props.onChange({ target: { value: "999" } });
      rationale.props.onChange({ target: { value: "准备发布" } });
    });
    expect(latency.props.value).toBe("999");

    // A fresh poll object with the same active version must not clobber the draft.
    await act(async () => {
      renderer?.update(
        <GovernanceWorkspace
          user={authUser("admin")}
          data={governanceData({ ...operations(), audit: auditEvents() })}
        />
      );
    });
    expect(latency.props.value).toBe("999");
    expect(rationale.props.value).toBe("准备发布");

    // A new active version must also preserve the dirty draft and block publishing
    // until the user explicitly loads the latest policy.
    const v2 = policy("v2", 640);
    await act(async () => {
      renderer?.update(
        <GovernanceWorkspace
          user={authUser("admin")}
          data={governanceData({ ...operations(v2), audit: auditEvents("v2") }, [v2, policy("v1")])}
        />
      );
    });
    expect(latency.props.value).toBe("999");
    expect(rationale.props.value).toBe("准备发布");
    expect(text(renderer.root)).toContain("生效策略已更新，草稿已保留。");
    expect(button(renderer, "检查并发布").props.disabled).toBe(true);

    // An out-of-range edit on the preserved draft still validates against the field bounds.
    act(() => {
      latency.props.onChange({ target: { value: "49" } });
      rationale.props.onChange({ target: { value: "越界值" } });
    });
    expect(text(renderer.root)).toContain("需在 50–60000 之间");
    expect(button(renderer, "检查并发布").props.disabled).toBe(true);
  });

  it("adopts a new active version automatically when the fresh draft is untouched", async () => {
    await act(async () => {
      renderer = create(<GovernanceWorkspace user={authUser("admin")} data={governanceData()} />);
    });
    const latency = latencyInput();
    expect(latency.props.value).toBe("800");
    expect(button(renderer, "检查并发布").props.disabled).toBe(true);

    const v2 = policy("v2", 640);
    await act(async () => {
      renderer?.update(
        <GovernanceWorkspace
          user={authUser("admin")}
          data={governanceData({ ...operations(v2), audit: auditEvents("v2") }, [v2, policy("v1")])}
        />
      );
    });
    expect(latency.props.value).toBe("640");
    expect(text(renderer.root)).not.toContain("载入最新策略");
  });

  it("requires explicit discard before loading the latest policy over a dirty draft", async () => {
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmMock);
    try {
      await act(async () => {
        renderer = create(<GovernanceWorkspace user={authUser("admin")} data={governanceData()} />);
      });
      const latency = latencyInput();
      const rationale = renderer.root.findByType("textarea");
      act(() => {
        latency.props.onChange({ target: { value: "999" } });
        rationale.props.onChange({ target: { value: "准备发布" } });
      });

      const v2 = policy("v2", 640);
      await act(async () => {
        renderer?.update(
          <GovernanceWorkspace
            user={authUser("admin")}
            data={governanceData({ ...operations(v2), audit: auditEvents("v2") }, [v2, policy("v1")])}
          />
        );
      });
      expect(latency.props.value).toBe("999");

      // Declining the discard keeps the dirty draft intact.
      act(() => button(renderer, "载入最新策略").props.onClick());
      expect(latency.props.value).toBe("999");
      expect(rationale.props.value).toBe("准备发布");

      // Confirming the discard loads the latest active policy.
      confirmMock.mockReturnValue(true);
      act(() => button(renderer, "载入最新策略").props.onClick());
      expect(latency.props.value).toBe("640");
      expect(rationale.props.value).toBe("");
    } finally {
      vi.stubGlobal("confirm", undefined);
    }
  });

  it("keeps a cleared allowed-zero threshold empty and invalid instead of silently zero", async () => {
    await act(async () => {
      renderer = create(<GovernanceWorkspace user={authUser("admin")} data={governanceData()} />);
    });
    const failSessions = renderer!.root.findByProps({ "aria-label": "允许失败证据数" });
    expect(failSessions.props.value).toBe("0");
    act(() => failSessions.props.onChange({ target: { value: "" } }));
    expect(failSessions.props.value).toBe("");
    expect(text(renderer!.root)).toContain("请输入有效数字");
    expect(button(renderer!, "检查并发布").props.disabled).toBe(true);
  });

  it("requires an explicit review step with old→new values before publishing", async () => {
    const pending = deferred<ApiResult<TestingPolicy>>();
    const sharedData = governanceData();
    vi.mocked(sharedData.createPolicy).mockReturnValueOnce(pending.promise);
    await act(async () => {
      renderer = create(<GovernanceWorkspace user={authUser("admin")} data={sharedData} />);
    });
    const latency = latencyInput();
    const rationale = renderer.root.findByType("textarea");
    expect(button(renderer, "检查并发布").props.disabled).toBe(true);
    act(() => {
      latency.props.onChange({ target: { value: "999" } });
      rationale.props.onChange({ target: { value: "Keep this rationale" } });
    });
    expect(button(renderer, "检查并发布").props.disabled).toBe(false);

    act(() => button(renderer, "检查并发布").props.onClick());
    const panel = renderer.root.findByProps({ className: "policyReviewPanel" });
    expect(text(panel)).toContain("800");
    expect(text(panel)).toContain("999");
    expect(text(panel)).toContain("Keep this rationale");
    expect(renderer.root.findAllByType("input").every((field) => field.props.disabled)).toBe(true);

    await act(async () => {
      void button(renderer, "确认发布").props.onClick();
    });
    expect(renderer.root.findAllByType("input").every((field) => field.props.disabled)).toBe(true);
    expect(sharedData.createPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ release: expect.objectContaining({ maxP95LatencyMs: 999 }) })
    );

    pending.resolve({ ok: false, error: { kind: "unavailable", message: "Try again" } });
    await flush();
    expect(text(renderer.root)).toContain("Try again");
    act(() => button(renderer, "继续编辑").props.onClick());
    expect(renderer.root.findAllByType("input").every((field) => !field.props.disabled)).toBe(true);
    expect(rationale.props.value).toBe("Keep this rationale");
    expect(latency.props.value).toBe("999");
  });

  it("publishes after confirmation, reports the new version, and keeps reviewers read-only", async () => {
    const sharedData = governanceData();
    vi.mocked(sharedData.createPolicy)
      .mockResolvedValueOnce({ ok: false, error: { kind: "forbidden", message: "只有管理员可以发布策略。" } })
      .mockResolvedValueOnce({ ok: true, data: policy("v2") });
    await act(async () => {
      renderer = create(<GovernanceWorkspace user={authUser("admin")} data={sharedData} />);
    });
    const rationale = renderer.root.findByType("textarea");
    act(() => rationale.props.onChange({ target: { value: "更新门槛" } }));
    act(() => button(renderer, "检查并发布").props.onClick());
    await act(async () => button(renderer, "确认发布").props.onClick());
    expect(text(renderer.root)).toContain("只有管理员可以发布策略。");
    await act(async () => button(renderer, "确认发布").props.onClick());
    expect(text(renderer.root)).not.toContain("只有管理员可以发布策略。");
    expect(text(renderer.root)).toContain("策略 v2 已发布");
    expect(renderer.root.findAllByProps({ className: "policyReviewPanel" })).toHaveLength(0);

    await act(async () => renderer?.unmount());
    await act(async () => {
      renderer = create(<GovernanceWorkspace user={authUser("reviewer")} data={sharedData} />);
    });
    expect(text(renderer.root)).toContain("审核员拥有只读权限");
    expect(renderer.root.findAllByType("input").every((input) => input.props.disabled)).toBe(true);
  });

  it("renders readable audit history, links only loaded records, and keeps raw ids behind a toggle", async () => {
    await act(async () => {
      renderer = create(<GovernanceWorkspace user={authUser("admin")} data={governanceData()} />);
    });
    act(() => button(renderer, "审计日志").props.onClick());
    expect(text(renderer.root)).toContain("更新发布验证");
    expect(text(renderer.root)).toContain("变更账号角色");
    expect(text(renderer.root)).toContain("新角色");
    expect(text(renderer.root)).toContain("审核员");
    expect(text(renderer.root)).toContain("状态");
    expect(text(renderer.root)).toContain("待批准");

    const runLink = renderer.root.findByProps({ href: "#/admin/releases?run=run-1" });
    expect(text(runLink)).toContain("候选发布");
    const policyLink = renderer.root.findByProps({ href: "#/admin/governance?tab=policy&policy=v1" });
    expect(text(policyLink)).toBe("v1");
    // session-1 is not in the loaded evidence, so it must never render as a dead link
    expect(
      renderer.root.findAllByType("a").some((node) => (node.props.href ?? "").includes("#/testing/evidence"))
    ).toBe(false);
    // The unloaded session and the account target have no loaded destination,
    // so both render as plain missing targets rather than dead links.
    expect(renderer.root.findAllByProps({ className: "auditTargetMissing" })).toHaveLength(2);

    const toggles = renderer.root.findAllByProps({ className: "auditRawToggle" });
    act(() => toggles[2].props.onClick());
    const raw = renderer.root.findByProps({ className: "auditRaw" });
    expect(text(raw)).toContain('"targetId": "session-1"');
    expect(text(raw)).toContain('"notesLength": 24');
  });

  it("filters the audit trail by search, actor, action, and date with a useful empty state", async () => {
    await act(async () => {
      renderer = create(<GovernanceWorkspace user={authUser("admin")} data={governanceData()} />);
    });
    act(() => button(renderer, "审计日志").props.onClick());
    expect(text(renderer.root)).toContain("显示 4 / 4 条记录");

    act(() =>
      governanceFilterField("操作人")
        .findByType("input")
        .props.onChange({ target: { value: "reviewer" } })
    );
    expect(text(renderer.root)).toContain("显示 1 / 4 条记录");
    expect(auditEventsText(renderer)).toContain("更新发布验证");
    expect(auditEventsText(renderer)).not.toContain("变更账号角色");

    act(() =>
      governanceFilterField("搜索")
        .findByType("input")
        .props.onChange({ target: { value: "候选发布" } })
    );
    expect(text(renderer.root)).toContain("显示 1 / 4 条记录");
    act(() => clearFilterButtons()[0].props.onClick());
    expect(text(renderer.root)).toContain("显示 4 / 4 条记录");

    act(() =>
      governanceFilterField("操作类型")
        .findByType("select")
        .props.onChange({ target: { value: "account.role-changed" } })
    );
    expect(text(renderer.root)).toContain("显示 1 / 4 条记录");

    act(() =>
      governanceFilterField("开始日期")
        .findByType("input")
        .props.onChange({ target: { value: "2099-01-01" } })
    );
    expect(text(renderer.root)).toContain("没有匹配筛选条件的审计记录。");
    act(() => clearFilterButtons()[0].props.onClick());
    expect(text(renderer.root)).toContain("显示 4 / 4 条记录");
  });

  it("hydrates the governance tab and audit filters from the URL", async () => {
    vi.stubGlobal("location", { hash: "#/admin/governance?tab=audit&actor=admin" });
    try {
      await act(async () => {
        renderer = create(<GovernanceWorkspace user={authUser("admin")} data={governanceData()} />);
      });
      expect(text(renderer.root)).toContain("显示 3 / 4 条记录");
      expect(governanceFilterField("操作人").findByType("input").props.value).toBe("admin");
      expect(auditEventsText(renderer)).not.toContain("更新发布验证");
    } finally {
      vi.stubGlobal("location", undefined);
    }
  });

  it("compares a selected historical version against the active policy across every threshold", async () => {
    const active = policy("v1", 800);
    const older = policy("v0", 900);
    await act(async () => {
      renderer = create(
        <GovernanceWorkspace
          user={authUser("admin")}
          data={governanceData({ ...operations(active), audit: auditEvents() }, [active, older])}
        />
      );
    });
    const history = renderer.root.findByProps({ className: "policyHistory" });
    expect(text(history)).toContain("正在查看当前生效版本。");
    act(() => history.findByProps({ "aria-label": "历史版本" }).props.onChange({ target: { value: "v0" } }));
    expect(text(history)).toContain("与当前生效版本 v1 对比：");
    expect(text(history)).toContain("必需平台");
    expect(text(history)).toContain("900");
    expect(text(history)).toContain("800");
    const changed = history.findAllByProps({ className: "policyDiffRow changed" });
    expect(text(changed[0])).toContain("900");
    expect(text(changed[0])).toContain("800");
  });
});
