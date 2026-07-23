import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestingOperationsSnapshot, TestingPolicy, TestingRun, TestingRunRequirement } from "../shared/testing";
import { GovernanceWorkspace } from "../src/components/admin/GovernanceWorkspace";
import { ReleaseValidation } from "../src/components/admin/ReleaseValidation";
import type { AdminTestingData } from "../src/components/admin/useAdminTestingData";
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

describe("ReleaseValidation", () => {
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

  it("keeps approval admin-only while preserving tester assignment guidance", async () => {
    const reviewerData = adminData();
    await act(async () => {
      renderer = create(<ReleaseValidation agent={agent()} user={authUser("reviewer")} data={reviewerData} />);
    });
    const status = renderer.root.find((node) => node.type === "select" && node.props["aria-label"] === "发布运行状态");
    expect(status.findAllByType("option").map((option) => option.props.value)).not.toContain("approved");

    await act(async () => renderer?.unmount());
    const approvedRun = run();
    approvedRun.status = "approved";
    const approvedData = adminData(operations(policy("v1"), [approvedRun]));
    await act(async () => {
      renderer = create(<ReleaseValidation agent={agent()} user={authUser("reviewer")} data={approvedData} />);
    });
    const approvedOption = renderer.root
      .find((node) => node.type === "select" && node.props["aria-label"] === "发布运行状态")
      .find((node) => node.type === "option" && node.props.value === "approved");
    expect(approvedOption.props.disabled).toBe(true);

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
        status: "assigned",
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
});

describe("GovernanceWorkspace", () => {
  it("resets the editable draft when the active policy version changes and enforces numeric floors", async () => {
    const sharedData = adminData();
    await act(async () => {
      renderer = create(<GovernanceWorkspace user={authUser("admin")} data={sharedData} />);
    });
    const latency = renderer.root.find((node) => node.type === "input" && node.props.min === 100);
    const rationale = renderer.root.findByType("textarea");
    act(() => {
      latency.props.onChange({ target: { value: "999" } });
      rationale.props.onChange({ target: { value: "准备发布" } });
    });
    expect(latency.props.value).toBe(999);

    const v2 = policy("v2", 640);
    const nextData = { ...sharedData, operations: operations(v2), policies: [v2, policy("v1")] };
    await act(async () => {
      renderer?.update(<GovernanceWorkspace user={authUser("admin")} data={nextData} />);
    });
    expect(latency.props.value).toBe(640);
    expect(rationale.props.value).toBe("");

    act(() => {
      latency.props.onChange({ target: { value: "99" } });
      rationale.props.onChange({ target: { value: "越界值" } });
    });
    expect(button(renderer, "发布版本化策略").props.disabled).toBe(true);
  });

  it("shows typed publication failures, clears them after success, and gives reviewers read-only access", async () => {
    const sharedData = adminData();
    vi.mocked(sharedData.createPolicy)
      .mockResolvedValueOnce({ ok: false, error: { kind: "forbidden", message: "只有管理员可以发布策略。" } })
      .mockResolvedValueOnce({ ok: true, data: policy("v2") });
    await act(async () => {
      renderer = create(<GovernanceWorkspace user={authUser("admin")} data={sharedData} />);
    });
    const rationale = renderer.root.findByType("textarea");
    act(() => rationale.props.onChange({ target: { value: "更新门槛" } }));
    await act(async () => button(renderer, "发布版本化策略").props.onClick());
    expect(text(renderer.root)).toContain("只有管理员可以发布策略。");
    await act(async () => button(renderer, "发布版本化策略").props.onClick());
    expect(text(renderer.root)).not.toContain("只有管理员可以发布策略。");
    expect(text(renderer.root)).toContain("策略 v2 已发布");

    await act(async () => renderer?.unmount());
    await act(async () => {
      renderer = create(<GovernanceWorkspace user={authUser("reviewer")} data={sharedData} />);
    });
    expect(text(renderer.root)).toContain("审核员拥有只读权限");
    expect(renderer.root.findAllByType("input").every((input) => input.props.disabled)).toBe(true);
    act(() => button(renderer, "审计日志").props.onClick());
    expect(text(renderer.root)).toContain("暂无额外详情");
  });
});
