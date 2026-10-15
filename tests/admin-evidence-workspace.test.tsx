import { readFileSync } from "node:fs";
import { act, useState } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TesterSessionSummary, TesterStats, TestingStats } from "../shared/agent";
import {
  TESTING_CAMPAIGNS,
  TESTING_TEST_CASES,
  type TestingOperationsSnapshot,
  type TestingPolicy,
  type TestingReview,
  type TestingRun
} from "../shared/testing";
import { AdminOverview } from "../src/components/admin/AdminOverview";
import { AdminWorkspace } from "../src/components/admin/AdminWorkspace";
import { LanguageProvider, LanguageToggle } from "../src/components/LanguageToggle";
import { EvidenceWorkspace } from "../src/components/admin/EvidenceWorkspace";
import type { HelmetAgent } from "../src/hooks/useHelmetAgent";
import type { AuthUser } from "../src/lib/auth";
import { useAdminTestingData, type AdminTestingData } from "../src/components/admin/useAdminTestingData";
import { testingApi } from "../src/lib/testing-api";
import { getTestingReview, resetTestingStore, upsertTestingReview } from "../server/testing-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("window", globalThis);

const campaign = TESTING_CAMPAIGNS[0];
const testCase = TESTING_TEST_CASES.find((item) => item.campaignId === campaign.id) ?? TESTING_TEST_CASES[0];

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "admin",
    username: "admin",
    displayName: "管理员",
    role: "admin",
    createdAt: 1,
    lastLoginAt: 1,
    ...overrides
  };
}

function tester(testerKey: string, testerId: string, qualityCounts: TesterStats["qualityCounts"]): TesterStats {
  return {
    testerKey,
    testerId,
    ipAddress: "127.0.0.1",
    region: "华东",
    activeSessions: 0,
    totalSessions: qualityCounts.pass + qualityCounts.watch + qualityCounts.fail,
    totalSessionMs: 1_000,
    audioUpBytes: 100,
    audioDownBytes: 200,
    controlDownBytes: 10,
    micFrames: 1,
    serverEvents: 1,
    latencySamples: 1,
    avgLatencyMs: 120,
    p95LatencyMs: 180,
    errorEvents: 0,
    ttsFallbacks: 0,
    qualityCounts,
    lastSeenAt: 100,
    recentTurns: []
  };
}

function session(
  sessionId: string,
  testerKey: string,
  testerId: string,
  quality: "pass" | "watch" | "fail",
  notes: string
): TesterSessionSummary {
  return {
    sessionId,
    testerKey,
    testerId,
    ipAddress: "127.0.0.1",
    region: "华东",
    campaignId: campaign.id,
    campaignName: campaign.name,
    testCaseId: testCase.id,
    testCaseName: `${testerId}目标用例`,
    appVersion: "0.1.0",
    gitCommit: "abcdef123456",
    deviceLabel: "浏览器",
    browserLanguage: "zh-CN",
    networkType: "wifi",
    platform: "web",
    startedAt: 100,
    endedAt: quality === "fail" ? 300 : 200,
    durationMs: 1_000,
    audioUpBytes: 100,
    audioDownBytes: 200,
    controlDownBytes: 10,
    micFrames: 1,
    serverEvents: 1,
    latencySamples: 1,
    avgLatencyMs: 120,
    p95LatencyMs: 180,
    errorEvents: 0,
    ttsFallbacks: 0,
    quality,
    validity: { status: "valid", reasons: [], detail: "有效证据" },
    flags: quality === "pass" ? [] : ["需要复核"],
    notes,
    policyVersion: "policy-v1",
    evidenceHash: "abcdef1234567890",
    evidenceIntegrity: "verified",
    capturedEvaluation: {
      testCaseId: testCase.id,
      testCaseName: testCase.name,
      score: quality === "pass" ? 100 : 20,
      quality,
      checks: []
    },
    capturedValidity: { status: "valid", reasons: [], detail: "有效证据" },
    audioQuality: { droppedFrames: 0, outgoingFps: 50, jitterMs: 0, clippingPct: 0, silencePct: 0 },
    evaluation: {
      testCaseId: testCase.id,
      testCaseName: testCase.name,
      score: quality === "pass" ? 100 : 20,
      quality,
      checks: []
    },
    turns: []
  };
}

function testing(users: TesterStats[], sessions: TesterSessionSummary[]): TestingStats {
  return {
    windowMinutes: 30,
    catalog: { campaigns: TESTING_CAMPAIGNS, testCases: TESTING_TEST_CASES, goldenReplays: [] },
    history: {
      persistent: true,
      maxSessions: 1_000,
      maxTranscriptTurnsPerTester: 100,
      maxTranscriptTurnsPerSession: 100
    },
    totals: {
      activeTestSessions: 0,
      totalTestSessions: sessions.length,
      audioUpBytes: 100,
      audioDownBytes: 200,
      controlDownBytes: 10,
      avgLatencyMs: 120,
      p95LatencyMs: 180,
      errorEvents: 0,
      ttsFallbacks: 0,
      validTestSessions: sessions.length,
      invalidTestSessions: 0
    },
    releaseGate: {
      status: "pass",
      build: "abcdef123456",
      generatedAt: 1,
      criteria: {
        minValidSessionsPerRequiredCase: 1,
        maxFailSessions: 0,
        maxWatchSessions: 0,
        maxInvalidSessions: 0,
        maxP95LatencyMs: 500,
        minStandardSessions: 1,
        minSafetyCriticalSessions: 1,
        requiredPlatforms: ["web"]
      },
      requiredTestCaseIds: [testCase.id],
      validSessions: sessions.length,
      invalidSessions: 0,
      failSessions: users.reduce((sum, item) => sum + item.qualityCounts.fail, 0),
      watchSessions: users.reduce((sum, item) => sum + item.qualityCounts.watch, 0),
      p95LatencyMs: 180,
      cases: [],
      blockers: [],
      warnings: []
    },
    regression: {
      status: "insufficient",
      current: {
        build: "abcdef123456",
        sessions: sessions.length,
        validSessions: sessions.length,
        invalidSessions: 0,
        failSessions: 0,
        watchSessions: 0,
        p95LatencyMs: 180,
        avgScore: 100,
        ttsFallbackRatePct: 0,
        failRatePct: 0,
        latestAt: 1,
        cohorts: 1
      },
      findings: [],
      cohorts: [],
      baselineSource: "none"
    },
    users,
    sessions,
    timeline: []
  };
}

function agent(): HelmetAgent {
  return {
    testerId: "current",
    testerRegion: "华东",
    testingCampaignId: campaign.id,
    testingTestCaseId: testCase.id,
    health: {
      build: { gitCommit: "abcdef123456" },
      metrics: { activeSessions: 0 }
    },
    refreshHealth: vi.fn().mockResolvedValue(undefined),
    setTesterId: vi.fn(),
    setTestingCampaignId: vi.fn(),
    setTestingTestCaseId: vi.fn()
  } as unknown as HelmetAgent;
}

function data(sessions: TesterSessionSummary[], users: TesterStats[]): AdminTestingData {
  const byId = Object.fromEntries(sessions.map((item) => [item.sessionId, item]));
  return {
    testing: testing(users, sessions),
    sessions,
    sessionDetails: byId,
    operations: null,
    policies: [],
    runs: [],
    nextCursor: undefined,
    sessionTotal: sessions.length,
    status: "ready",
    error: null,
    lastSyncedAt: 1,
    refresh: vi.fn().mockResolvedValue(undefined),
    loadMore: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn(async (sessionId: string) => byId[sessionId] ?? null),
    saveNotes: vi.fn().mockResolvedValue(true),
    clearEvidence: vi.fn().mockResolvedValue(true),
    createRun: vi.fn(),
    updateRun: vi.fn(),
    createAssignment: vi.fn(),
    saveReview: vi.fn(),
    createPolicy: vi.fn()
  };
}

function policy(): TestingPolicy {
  return {
    version: "policy-v1",
    createdAt: 1,
    createdBy: "admin",
    description: "当前策略",
    active: true,
    release: {
      maxFailSessions: 0,
      maxWatchSessions: 1,
      maxInvalidSessions: 0,
      maxP95LatencyMs: 800,
      minStandardSessions: 1,
      minSafetyCriticalSessions: 1,
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

function review(sessionId: string, overrides: Partial<TestingReview> = {}): TestingReview {
  return {
    id: `review-${sessionId}`,
    sessionId,
    status: "open",
    severity: "high",
    owner: "reviewer",
    title: `${sessionId} 需要复核`,
    comment: "复核内容",
    createdAt: 1,
    updatedAt: 1,
    createdBy: "reviewer",
    ...overrides
  };
}

function operations(reviews: TestingReview[]): TestingOperationsSnapshot {
  return { activePolicy: policy(), runs: [], reviews, audit: [] };
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}

function input(renderer: ReactTestRenderer, placeholder: string) {
  return renderer.root.find((node) => node.type === "input" && node.props.placeholder === placeholder);
}

function textarea(renderer: ReactTestRenderer, placeholder: string) {
  return renderer.root.find((node) => node.type === "textarea" && node.props.placeholder === placeholder);
}

function reviewTitleInput(renderer: ReactTestRenderer) {
  return renderer.root
    .find((node) => node.type === "div" && node.props.className === "reviewComposer")
    .findAllByType("input")[1];
}

function reviewSubmitButton(renderer: ReactTestRenderer) {
  return renderer.root.find(
    (node) => node.type === "button" && ["新建复核", "更新复核", "正在保存…"].includes(text(node))
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  const originalConsoleError = console.error;
  vi.spyOn(console, "error").mockImplementation((message: unknown, ...optionalParams: unknown[]) => {
    if (message === "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer") {
      return;
    }
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

describe("EvidenceWorkspace navigation state", () => {
  it("clears scoped evidence drafts and auto-selects allowed evidence after a reviewer becomes a tester", async () => {
    const reviewerSession = session("reviewer-session", "reviewer-key", "reviewer", "fail", "审核员备注");
    const testerSession = session("tester-session", "tester-key", "tester", "pass", "测试员备注");
    const reviewerData = data([reviewerSession], [tester("reviewer-key", "reviewer", { pass: 0, watch: 0, fail: 1 })]);
    reviewerData.operations = operations([review(reviewerSession.sessionId, { title: "审核员复核" })]);
    const testerData = data([testerSession], [tester("tester-key", "tester", { pass: 1, watch: 0, fail: 0 })]);
    const sharedAgent = agent();

    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={user({ id: "reviewer-user", username: "reviewer", role: "reviewer" })}
          data={reviewerData}
        />
      );
    });
    await flush();

    await act(async () => {
      textarea(renderer!, "复现上下文、设备条件和调查记录…").props.onChange({ target: { value: "审核员未保存备注" } });
      reviewTitleInput(renderer!).props.onChange({ target: { value: "审核员未保存复核" } });
    });

    await act(async () => {
      renderer!.update(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={user({ id: "tester-user", username: "tester", role: "tester" })}
          data={testerData}
        />
      );
    });
    await flush();

    expect(
      text(renderer!.root.find((node) => node.type === "button" && node.props.className === "sessionButton active"))
    ).toContain("tester目标用例");
    expect(text(renderer!.root)).not.toContain("审核员未保存备注");
    expect(text(renderer!.root)).not.toContain("审核员未保存复核");
    expect(text(renderer!.root)).not.toContain("reviewer目标用例");
  });

  it("invalidates a prior review save when the reviewer identity changes", async () => {
    const selected = session("shared-session", "shared-key", "shared", "fail", "旧作用域备注");
    const oldReview = review(selected.sessionId, { title: "旧作用域复核", updatedAt: 1 });
    const newScopeReview = review(selected.sessionId, { title: "新作用域复核", updatedAt: 2 });
    const oldScopeData = data([selected], [tester("shared-key", "shared", { pass: 0, watch: 0, fail: 1 })]);
    oldScopeData.operations = operations([oldReview]);
    const newScopeData = data([selected], [tester("shared-key", "shared", { pass: 0, watch: 0, fail: 1 })]);
    newScopeData.operations = operations([newScopeReview]);
    const pending = deferred<Awaited<ReturnType<AdminTestingData["saveReview"]>>>();
    oldScopeData.saveReview = vi.fn(() => pending.promise);
    newScopeData.saveReview = oldScopeData.saveReview;
    const sharedAgent = agent();

    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={user({ id: "reviewer-one", username: "reviewer-one", role: "reviewer" })}
          data={oldScopeData}
        />
      );
    });
    await flush();

    act(() => reviewTitleInput(renderer!).props.onChange({ target: { value: "旧作用域未保存复核" } }));
    act(() => reviewSubmitButton(renderer!).props.onClick());
    expect(reviewSubmitButton(renderer!).props.disabled).toBe(true);

    await act(async () => {
      renderer!.update(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={user({ id: "reviewer-two", username: "reviewer-two", role: "reviewer" })}
          data={newScopeData}
        />
      );
    });
    await flush();

    expect(reviewTitleInput(renderer!).props.value).toBe("新作用域复核");
    expect(reviewSubmitButton(renderer!).props.disabled).toBe(false);

    await act(async () => {
      pending.resolve({ ok: true, data: { ...oldReview, title: "旧作用域已保存", updatedAt: 3 } });
      await pending.promise;
    });
    await flush();

    expect(reviewTitleInput(renderer!).props.value).toBe("新作用域复核");
    expect(reviewSubmitButton(renderer!).props.disabled).toBe(false);
    expect(text(renderer!.root)).not.toContain("复核记录已保存并写入审计日志。");
    expect(newScopeData.refresh).not.toHaveBeenCalled();
  });

  it("opens a requested evidence session by resetting obstructing filters and selecting its tester", async () => {
    const current = session("current-session", "current-key", "current", "pass", "当前备注");
    const target = session("target-session", "target-key", "target", "fail", "目标备注");
    const sharedData = data(
      [current, target],
      [
        tester("current-key", "current", { pass: 1, watch: 0, fail: 0 }),
        tester("target-key", "target", { pass: 0, watch: 0, fail: 1 })
      ]
    );
    const onRequestedSessionHandled = vi.fn();
    const focusEvidence = vi.fn();
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          focusRequestKey={0}
          requestedSessionId={null}
          onRequestedSessionHandled={onRequestedSessionHandled}
          agent={agent()}
          user={user()}
          data={sharedData}
        />,
        {
          createNodeMock: (element) =>
            element.type === "section" && element.props["aria-label"] === "证据与问题" ? { focus: focusEvidence } : null
        }
      );
    });
    await flush();

    await act(async () => {
      input(renderer!, "用例、设备、标记或构建").props.onChange({ target: { value: "不存在" } });
      renderer!.root.find((node) => node.type === "button" && text(node) === "PASS").props.onClick();
    });
    expect(focusEvidence).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.update(
        <EvidenceWorkspace
          active
          focusRequestKey={1}
          requestedSessionId="target-session"
          onRequestedSessionHandled={onRequestedSessionHandled}
          agent={agent()}
          user={user()}
          data={sharedData}
        />
      );
    });
    await flush();

    expect(sharedData.loadSession).toHaveBeenCalledWith("target-session");
    expect(onRequestedSessionHandled).toHaveBeenCalledWith("target-session");
    expect(focusEvidence).toHaveBeenCalledTimes(1);
    expect(
      renderer!.root.find((node) => node.type === "section" && node.props["aria-label"] === "证据与问题").props.tabIndex
    ).toBe(-1);
    expect(input(renderer!, "用例、设备、标记或构建").props.value).toBe("");
    expect(renderer!.root.find((node) => node.type === "button" && text(node) === "FAIL").props["aria-pressed"]).toBe(
      true
    );
    expect(renderer!.root.find((node) => node.type === "button" && text(node) === "PASS").props["aria-pressed"]).toBe(
      false
    );
    const activeSession = renderer!.root.find(
      (node) => node.type === "button" && node.props.className === "sessionButton active"
    );
    expect(text(activeSession)).toContain("target目标用例");
    const selectedTester = renderer!.root.find((node) => node.type === "tr" && node.props.className === "selected");
    expect(text(selectedTester)).toContain("target");
  });

  it("acknowledges a pending requested session when ordinary navigation supersedes it", async () => {
    const requestedA = session("session-a", "shared-key", "tester-a", "fail", "A 备注");
    const selectedB = session("session-b", "shared-key", "tester-b", "fail", "B 备注");
    const sharedData = data(
      [requestedA, selectedB],
      [tester("shared-key", "shared-tester", { pass: 0, watch: 0, fail: 2 })]
    );
    const loadA = deferred<TesterSessionSummary | null>();
    vi.mocked(sharedData.loadSession).mockImplementation((sessionId: string) =>
      sessionId === requestedA.sessionId ? loadA.promise : Promise.resolve(selectedB)
    );
    const onRequestedSessionHandled = vi.fn();
    const sharedAgent = agent();
    const sharedUser = user();

    function RequestedEvidenceParent({ snapshot }: { snapshot: AdminTestingData }) {
      const [requestedSessionId, setRequestedSessionId] = useState<string | null>(requestedA.sessionId);
      return (
        <EvidenceWorkspace
          active
          focusRequestKey={1}
          requestedSessionId={requestedSessionId}
          onRequestedSessionHandled={(sessionId) => {
            onRequestedSessionHandled(sessionId);
            setRequestedSessionId((current) => (current === sessionId ? null : current));
          }}
          agent={sharedAgent}
          user={sharedUser}
          data={snapshot}
        />
      );
    }

    await act(async () => {
      renderer = create(<RequestedEvidenceParent snapshot={sharedData} />);
    });
    expect(sharedData.loadSession).toHaveBeenCalledTimes(1);
    expect(sharedData.loadSession).toHaveBeenCalledWith(requestedA.sessionId);

    const sessionBButton = renderer.root.find(
      (node) =>
        node.type === "button" &&
        String(node.props.className).startsWith("sessionButton") &&
        text(node).includes("tester-b目标用例")
    );
    await act(async () => sessionBButton.props.onClick());
    await flush();

    expect(onRequestedSessionHandled).toHaveBeenCalledTimes(1);
    expect(onRequestedSessionHandled).toHaveBeenCalledWith(requestedA.sessionId);
    expect(sharedData.loadSession).toHaveBeenCalledWith(selectedB.sessionId);
    expect(
      text(renderer.root.find((node) => node.type === "button" && node.props.className === "sessionButton active"))
    ).toContain("tester-b目标用例");

    await act(async () => {
      loadA.resolve(requestedA);
      await loadA.promise;
    });
    expect(
      text(renderer.root.find((node) => node.type === "button" && node.props.className === "sessionButton active"))
    ).toContain("tester-b目标用例");

    await act(async () => {
      renderer?.update(<RequestedEvidenceParent snapshot={{ ...sharedData, operations: operations([]) }} />);
    });
    await flush();
    expect(sharedData.loadSession).toHaveBeenCalledTimes(2);
    expect(
      text(renderer.root.find((node) => node.type === "button" && node.props.className === "sessionButton active"))
    ).toContain("tester-b目标用例");
  });

  it("pins selection and a dirty note draft across hidden polling/detail updates", async () => {
    const selected = session("selected-session", "current-key", "current", "pass", "服务端备注");
    const sharedData = data([selected], [tester("current-key", "current", { pass: 1, watch: 0, fail: 0 })]);
    const sharedAgent = agent();
    const sharedUser = user();
    const onRequestedSessionHandled = vi.fn();
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={onRequestedSessionHandled}
          agent={sharedAgent}
          user={sharedUser}
          data={sharedData}
        />
      );
    });
    await flush();

    await act(async () => {
      input(renderer!, "ID、IP 或区域").props.onChange({ target: { value: "华东" } });
      input(renderer!, "用例、设备、标记或构建").props.onChange({ target: { value: "目标用例" } });
    });
    await flush();
    await act(async () => {
      textarea(renderer!, "复现上下文、设备条件和调查记录…").props.onChange({ target: { value: "未保存草稿" } });
    });

    const background = session("background-session", "current-key", "current", "fail", "后台新会话");
    const selectedFromPoll = { ...selected, notes: "服务端刷新备注" };
    const changedData = data(
      [background, selectedFromPoll],
      [tester("current-key", "current", { pass: 1, watch: 0, fail: 1 })]
    );
    await act(async () => {
      renderer!.update(
        <EvidenceWorkspace
          active={false}
          requestedSessionId={null}
          onRequestedSessionHandled={onRequestedSessionHandled}
          agent={sharedAgent}
          user={sharedUser}
          data={changedData}
        />
      );
    });
    const hiddenWorkspace = renderer!.root.find(
      (node) => node.type === "section" && node.props["aria-label"] === "证据与问题"
    );
    expect(hiddenWorkspace.props.hidden).toBe(true);
    expect(hiddenWorkspace.props.inert).toBe(true);

    await act(async () => {
      renderer!.update(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={onRequestedSessionHandled}
          agent={sharedAgent}
          user={sharedUser}
          data={changedData}
        />
      );
    });

    expect(input(renderer!, "ID、IP 或区域").props.value).toBe("华东");
    expect(input(renderer!, "用例、设备、标记或构建").props.value).toBe("目标用例");
    expect(textarea(renderer!, "复现上下文、设备条件和调查记录…").props.value).toBe("未保存草稿");
    const activeSession = renderer!.root.find(
      (node) => node.type === "button" && node.props.className === "sessionButton active"
    );
    expect(text(activeSession)).toContain("PASS");
    expect(text(activeSession)).not.toContain("FAIL");
    expect(hiddenWorkspace.props.hidden).toBe(false);
    expect(hiddenWorkspace.props.inert).toBeUndefined();

    await act(async () => {
      renderer!.root.find((node) => node.type === "button" && text(node) === "保存备注").props.onClick();
      await Promise.resolve();
    });
    expect(changedData.saveNotes).toHaveBeenCalledWith("selected-session", "未保存草稿");

    const cleanRefresh = data(
      [background, { ...selected, notes: "服务端确认备注" }],
      [tester("current-key", "current", { pass: 1, watch: 0, fail: 1 })]
    );
    await act(async () => {
      renderer!.update(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={onRequestedSessionHandled}
          agent={sharedAgent}
          user={sharedUser}
          data={cleanRefresh}
        />
      );
    });
    expect(textarea(renderer!, "复现上下文、设备条件和调查记录…").props.value).toBe("服务端确认备注");
  });

  it("repins explicit session filters while passive polling keeps the current selection", async () => {
    const pass = session("pass-session", "current-key", "current", "pass", "PASS 备注");
    const fail = session("fail-session", "current-key", "current", "fail", "FAIL 备注");
    const sharedData = data([pass, fail], [tester("current-key", "current", { pass: 1, watch: 0, fail: 1 })]);
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={agent()}
          user={user()}
          data={sharedData}
        />
      );
    });
    await flush();

    await act(async () => {
      renderer!.root.find((node) => node.type === "button" && text(node) === "PASS").props.onClick();
    });
    await flush();
    expect(textarea(renderer!, "复现上下文、设备条件和调查记录…").props.value).toBe("PASS 备注");

    await act(async () => {
      renderer!.root.find((node) => node.type === "button" && text(node) === "FAIL").props.onClick();
    });
    await flush();

    const failSelection = renderer!.root.find(
      (node) => node.type === "button" && node.props.className === "sessionButton active"
    );
    expect(text(failSelection)).toContain("FAIL");
    expect(textarea(renderer!, "复现上下文、设备条件和调查记录…").props.value).toBe("FAIL 备注");

    await act(async () => {
      renderer!.root.find((node) => node.type === "button" && text(node) === "删除会话").props.onClick();
    });
    await act(async () => {
      renderer!.root.find((node) => node.type === "button" && text(node).includes("fail-session")).props.onClick();
      await Promise.resolve();
    });
    expect(sharedData.clearEvidence).toHaveBeenCalledWith({ scope: "session", sessionId: "fail-session" });

    await act(async () => {
      renderer!.root.find((node) => node.type === "button" && text(node) === "全部").props.onClick();
    });
    await flush();
    await act(async () => {
      input(renderer!, "用例、设备、标记或构建").props.onChange({ target: { value: "不存在" } });
    });
    await flush();
    expect(
      renderer!.root.findAll(
        (node) => node.type === "textarea" && node.props.placeholder === "复现上下文、设备条件和调查记录…"
      )
    ).toHaveLength(0);
    expect(renderer!.root.find((node) => node.type === "button" && text(node) === "导出会话").props.disabled).toBe(
      true
    );
    expect(renderer!.root.find((node) => node.type === "button" && text(node) === "删除会话").props.disabled).toBe(
      true
    );

    await act(async () => {
      input(renderer!, "用例、设备、标记或构建").props.onChange({ target: { value: "pass-session" } });
    });
    await flush();
    expect(textarea(renderer!, "复现上下文、设备条件和调查记录…").props.value).toBe("PASS 备注");
  });

  it("keeps edits made during a deferred note save dirty and save-enabled", async () => {
    const selected = session("selected-session", "current-key", "current", "pass", "A");
    const sharedData = data([selected], [tester("current-key", "current", { pass: 1, watch: 0, fail: 0 })]);
    const save = deferred<boolean>();
    sharedData.saveNotes = vi.fn(() => save.promise);
    const sharedAgent = agent();
    const sharedUser = user();
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={sharedUser}
          data={sharedData}
        />
      );
    });
    await flush();

    await act(async () => {
      textarea(renderer!, "复现上下文、设备条件和调查记录…").props.onChange({ target: { value: "B" } });
    });
    await act(async () => {
      renderer!.root.find((node) => node.type === "button" && text(node) === "保存备注").props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      textarea(renderer!, "复现上下文、设备条件和调查记录…").props.onChange({ target: { value: "C" } });
    });

    const saveEditedDraft = renderer!.root.find((node) => node.type === "button" && text(node) === "保存备注");
    expect(textarea(renderer!, "复现上下文、设备条件和调查记录…").props.value).toBe("C");
    expect(saveEditedDraft.props.disabled).toBe(false);

    await act(async () => {
      save.resolve(true);
      await save.promise;
    });
    expect(textarea(renderer!, "复现上下文、设备条件和调查记录…").props.value).toBe("C");
    expect(renderer!.root.find((node) => node.type === "button" && text(node) === "保存备注").props.disabled).toBe(
      false
    );

    const savedEcho = data(
      [{ ...selected, notes: "B" }],
      [tester("current-key", "current", { pass: 1, watch: 0, fail: 0 })]
    );
    await act(async () => {
      renderer!.update(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={sharedUser}
          data={savedEcho}
        />
      );
    });
    expect(textarea(renderer!, "复现上下文、设备条件和调查记录…").props.value).toBe("C");
  });

  it("focuses an untargeted overview handoff once without focusing ordinary navigation", async () => {
    const selected = session("selected-session", "current-key", "current", "pass", "服务端备注");
    const sharedData = data([selected], [tester("current-key", "current", { pass: 1, watch: 0, fail: 0 })]);
    const focusEvidence = vi.fn();
    const sharedAgent = agent();
    const sharedUser = user();
    const onRequestedSessionHandled = vi.fn();
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active={false}
          focusRequestKey={0}
          requestedSessionId={null}
          onRequestedSessionHandled={onRequestedSessionHandled}
          agent={sharedAgent}
          user={sharedUser}
          data={sharedData}
        />,
        {
          createNodeMock: (element) =>
            element.type === "section" && element.props["aria-label"] === "证据与问题" ? { focus: focusEvidence } : null
        }
      );
    });

    await act(async () => {
      renderer!.update(
        <EvidenceWorkspace
          active
          focusRequestKey={1}
          requestedSessionId={null}
          onRequestedSessionHandled={onRequestedSessionHandled}
          agent={sharedAgent}
          user={sharedUser}
          data={sharedData}
        />
      );
    });
    expect(focusEvidence).toHaveBeenCalledTimes(1);
    expect(onRequestedSessionHandled).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.update(
        <EvidenceWorkspace
          active={false}
          focusRequestKey={1}
          requestedSessionId={null}
          onRequestedSessionHandled={onRequestedSessionHandled}
          agent={sharedAgent}
          user={sharedUser}
          data={sharedData}
        />
      );
      renderer!.update(
        <EvidenceWorkspace
          active
          focusRequestKey={1}
          requestedSessionId={null}
          onRequestedSessionHandled={onRequestedSessionHandled}
          agent={sharedAgent}
          user={sharedUser}
          data={sharedData}
        />
      );
    });
    expect(focusEvidence).toHaveBeenCalledTimes(1);
  });

  it("preserves evidence filters after a confirmed all-evidence clear", async () => {
    const selected = session("selected-session", "current-key", "current", "pass", "服务端备注");
    const sharedData = data([selected], [tester("current-key", "current", { pass: 1, watch: 0, fail: 0 })]);
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={agent()}
          user={user()}
          data={sharedData}
        />
      );
    });
    await flush();

    await act(async () => {
      input(renderer!, "ID、IP 或区域").props.onChange({ target: { value: "华东" } });
      input(renderer!, "用例、设备、标记或构建").props.onChange({ target: { value: "目标用例" } });
      renderer!.root.find((node) => node.type === "button" && text(node) === "PASS").props.onClick();
    });
    await act(async () => {
      renderer!.root.find((node) => node.type === "button" && text(node) === "清除全部证据").props.onClick();
    });
    await act(async () => {
      renderer!.root.find((node) => node.type === "button" && text(node).includes("全部测试证据")).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sharedData.clearEvidence).toHaveBeenCalledWith({ scope: "all" });
    expect(input(renderer!, "ID、IP 或区域").props.value).toBe("华东");
    expect(input(renderer!, "用例、设备、标记或构建").props.value).toBe("目标用例");
    expect(renderer!.root.find((node) => node.type === "button" && text(node) === "PASS").props["aria-pressed"]).toBe(
      true
    );
  });
});

describe("EvidenceWorkspace review workflow", () => {
  it("refreshes only visible selected historical evidence outside the first page", async () => {
    vi.useFakeTimers();
    try {
      const historical = session("historical", "old-key", "old", "pass", "old historical notes");
      const recent = session("recent", "current-key", "current", "pass", "recent notes");
      const users = [
        tester("old-key", "old", { pass: 1, watch: 0, fail: 0 }),
        tester("current-key", "current", { pass: 1, watch: 0, fail: 0 })
      ];
      vi.spyOn(testingApi, "fetchSummary").mockResolvedValue({ ok: true, data: testing(users, [recent]) });
      vi.spyOn(testingApi, "fetchSessions").mockResolvedValue({ ok: true, data: { items: [recent], total: 2 } });
      vi.spyOn(testingApi, "fetchOperations").mockResolvedValue({
        ok: true,
        data: { operations: operations([]), policies: [policy()] }
      });
      vi.spyOn(testingApi, "fetchSession").mockResolvedValue({ ok: true, data: historical });
      const sharedAgent = agent();
      const sharedUser = user();
      function HistoricalEvidence({ active }: { active: boolean }) {
        const actualData = useAdminTestingData({ user: sharedUser, onAuthenticationExpired: () => undefined });
        const [requested, setRequested] = useState<string | null>(historical.sessionId);
        return actualData.testing ? (
          <EvidenceWorkspace
            active={active}
            requestedSessionId={requested}
            onRequestedSessionHandled={() => setRequested(null)}
            agent={sharedAgent}
            user={sharedUser}
            data={actualData}
          />
        ) : null;
      }
      await act(async () => {
        renderer = create(<HistoricalEvidence active />);
      });
      const notes = textarea(renderer!, "复现上下文、设备条件和调查记录…");
      expect(notes.props.value).toBe("old historical notes");
      vi.mocked(testingApi.fetchSession).mockResolvedValue({
        ok: true,
        data: { ...historical, notes: "updated historical notes" }
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(notes.props.value).toBe("updated historical notes");
      expect(testingApi.fetchSession).toHaveBeenLastCalledWith(historical.sessionId);
      await act(async () => {
        renderer?.update(<HistoricalEvidence active={false} />);
      });
      const visibleReads = vi.mocked(testingApi.fetchSession).mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(testingApi.fetchSession).toHaveBeenCalledTimes(visibleReads);
    } finally {
      await act(async () => renderer?.unmount());
      renderer = null;
      vi.useRealTimers();
    }
  });

  it("changes only review status while preserving another reviewer's newer metadata", async () => {
    resetTestingStore();
    try {
      const selected = session("selected-session", "current-key", "current", "pass", "");
      const original = upsertTestingReview(
        { sessionId: selected.sessionId, title: "Old title", comment: "Old comment", severity: "high", owner: "first" },
        "first",
        1
      )!;
      const sharedData = data([selected], [tester("current-key", "current", { pass: 1, watch: 0, fail: 0 })]);
      sharedData.operations = operations([original]);
      vi.mocked(sharedData.saveReview).mockImplementation(async (input) => ({
        ok: true,
        data: upsertTestingReview(input, "first", 3)!
      }));
      await act(async () => {
        renderer = create(
          <EvidenceWorkspace
            active
            requestedSessionId={null}
            onRequestedSessionHandled={vi.fn()}
            agent={agent()}
            user={user()}
            data={sharedData}
          />
        );
      });
      const newest = upsertTestingReview(
        { id: original.id, title: "New title", comment: "New comment", severity: "critical", owner: "second" },
        "second",
        2
      )!;
      const statusSelect = renderer.root.find(
        (node) => node.type === "select" && node.props["aria-label"] === "复核状态 Old title"
      );
      await act(async () => statusSelect.props.onChange({ target: { value: "triaged" } }));

      expect(sharedData.saveReview).toHaveBeenCalledWith({
        id: original.id,
        sessionId: selected.sessionId,
        status: "triaged"
      });
      expect(getTestingReview(original.id)).toMatchObject({
        title: newest.title,
        comment: newest.comment,
        severity: newest.severity,
        owner: newest.owner,
        status: "triaged"
      });
    } finally {
      resetTestingStore();
    }
  });

  it("binds the composer and queue navigation to selected evidence and refreshes after saving", async () => {
    const first = session("session-first", "first-key", "first", "fail", "");
    const second = session("session-second", "second-key", "second", "pass", "");
    const sharedData = data(
      [first, second],
      [
        tester("first-key", "first", { pass: 0, watch: 0, fail: 1 }),
        tester("second-key", "second", { pass: 1, watch: 0, fail: 0 })
      ]
    );
    sharedData.operations = operations([review(second.sessionId)]);
    vi.mocked(sharedData.saveReview).mockResolvedValue({ ok: true, data: review(first.sessionId) });
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={agent()}
          user={user()}
          data={sharedData}
        />
      );
    });

    expect(text(renderer.root)).toContain("first目标用例 · first");
    const queueLink = renderer.root.find(
      (node) => node.type === "button" && node.props.className === "reviewEvidenceLink"
    );
    act(() => queueLink.props.onClick());
    expect(text(renderer.root)).toContain("second目标用例 · second");

    const openReview = renderer.root.find(
      (node) => node.type === "button" && (text(node) === "新建复核" || text(node) === "更新复核")
    );
    await act(async () => openReview.props.onClick());
    expect(sharedData.saveReview).toHaveBeenCalledWith(expect.objectContaining({ sessionId: second.sessionId }));
    expect(sharedData.refresh).toHaveBeenCalled();
    expect(text(renderer.root)).toContain("复核记录已保存并写入审计日志。");
  });

  it("shows typed review failures and uses target-specific queue busy state", async () => {
    const first = session("session-first", "first-key", "first", "fail", "");
    const sharedData = data([first], [tester("first-key", "first", { pass: 0, watch: 0, fail: 1 })]);
    const firstReview = review(first.sessionId);
    const secondReview = { ...review("session-other"), id: "review-other", title: "其他复核" };
    sharedData.operations = operations([firstReview, secondReview]);
    const pending = deferred<Awaited<ReturnType<AdminTestingData["saveReview"]>>>();
    vi.mocked(sharedData.saveReview)
      .mockResolvedValueOnce({ ok: false, error: { kind: "conflict", message: "复核状态已被其他审核员更新。" } })
      .mockReturnValueOnce(pending.promise);
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={agent()}
          user={user()}
          data={sharedData}
        />
      );
    });

    const composerButton = renderer.root.find(
      (node) => node.type === "button" && (text(node) === "新建复核" || text(node) === "更新复核")
    );
    await act(async () => composerButton.props.onClick());
    expect(text(renderer.root)).toContain("复核状态已被其他审核员更新。");

    const queueSelects = renderer.root.findAll(
      (node) => node.type === "select" && node.props["aria-label"]?.startsWith("复核状态")
    );
    act(() => queueSelects[0].props.onChange({ target: { value: "triaged" } }));
    expect(queueSelects[0].props.disabled).toBe(true);
    expect(queueSelects[1].props.disabled).toBe(false);
    await act(async () => {
      pending.resolve({ ok: true, data: { ...firstReview, status: "triaged" } });
      await pending.promise;
    });
    expect(text(renderer.root)).not.toContain("复核状态已被其他审核员更新。");
    expect(text(renderer.root)).toContain("复核记录已保存并写入审计日志。");
  });

  it("keeps concurrent queue status targets busy and gives the newest request notice ownership", async () => {
    const first = session("session-first", "first-key", "first", "fail", "");
    const sharedData = data([first], [tester("first-key", "first", { pass: 0, watch: 0, fail: 1 })]);
    const reviewA = review("session-a", { title: "队列 A" });
    const reviewB = review("session-b", { title: "队列 B" });
    sharedData.operations = operations([reviewA, reviewB]);
    const pendingA = deferred<Awaited<ReturnType<AdminTestingData["saveReview"]>>>();
    const pendingB = deferred<Awaited<ReturnType<AdminTestingData["saveReview"]>>>();
    vi.mocked(sharedData.saveReview).mockReturnValueOnce(pendingA.promise).mockReturnValueOnce(pendingB.promise);
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={agent()}
          user={user()}
          data={sharedData}
        />
      );
    });

    const queueSelects = renderer.root.findAll(
      (node) => node.type === "select" && node.props["aria-label"]?.startsWith("复核状态")
    );
    act(() => queueSelects[0].props.onChange({ target: { value: "triaged" } }));
    act(() => queueSelects[1].props.onChange({ target: { value: "resolved" } }));
    expect(queueSelects[0].props.disabled).toBe(true);
    expect(queueSelects[1].props.disabled).toBe(true);

    await act(async () => {
      pendingB.resolve({ ok: true, data: { ...reviewB, status: "resolved" } });
      await pendingB.promise;
    });
    expect(queueSelects[0].props.disabled).toBe(true);
    expect(queueSelects[1].props.disabled).toBe(false);
    expect(text(renderer.root)).toContain("复核记录已保存并写入审计日志。");

    await act(async () => {
      pendingA.resolve({ ok: false, error: { kind: "conflict", message: "队列 A 的旧失败。" } });
      await pendingA.promise;
    });
    expect(queueSelects[0].props.disabled).toBe(false);
    expect(text(renderer.root)).toContain("复核记录已保存并写入审计日志。");
    expect(text(renderer.root)).not.toContain("队列 A 的旧失败。");
  });

  it("keys concurrent composer saves by session and keeps the newer session busy", async () => {
    const first = session("session-first", "first-key", "first", "fail", "");
    const second = session("session-second", "second-key", "second", "pass", "");
    const firstReview = review(first.sessionId, { title: "复核 A" });
    const secondReview = review(second.sessionId, { title: "复核 B" });
    const sharedData = data(
      [first, second],
      [
        tester("first-key", "first", { pass: 0, watch: 0, fail: 1 }),
        tester("second-key", "second", { pass: 1, watch: 0, fail: 0 })
      ]
    );
    sharedData.operations = operations([firstReview, secondReview]);
    const pendingA = deferred<Awaited<ReturnType<AdminTestingData["saveReview"]>>>();
    const pendingB = deferred<Awaited<ReturnType<AdminTestingData["saveReview"]>>>();
    vi.mocked(sharedData.saveReview).mockReturnValueOnce(pendingA.promise).mockReturnValueOnce(pendingB.promise);
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={agent()}
          user={user()}
          data={sharedData}
        />
      );
    });

    act(() => reviewSubmitButton(renderer).props.onClick());
    expect(reviewSubmitButton(renderer).props.disabled).toBe(true);
    const queueB = renderer.root
      .findAll((node) => node.type === "button" && node.props.className === "reviewEvidenceLink")
      .find((node) => text(node).includes("复核 B"));
    expect(queueB).toBeDefined();
    act(() => queueB?.props.onClick());
    expect(reviewSubmitButton(renderer).props.disabled).toBe(false);
    act(() => reviewSubmitButton(renderer).props.onClick());
    expect(reviewSubmitButton(renderer).props.disabled).toBe(true);

    await act(async () => {
      pendingA.resolve({ ok: true, data: firstReview });
      await pendingA.promise;
    });
    expect(reviewSubmitButton(renderer).props.disabled).toBe(true);
    await act(async () => {
      pendingB.resolve({ ok: true, data: secondReview });
      await pendingB.promise;
    });
    expect(reviewSubmitButton(renderer).props.disabled).toBe(false);
    expect(text(renderer.root)).toContain("复核记录已保存并写入审计日志。");
  });

  it("lets the latest unloaded queue handoff own evidence, notes, filters, and review draft", async () => {
    const current = session("session-current", "current-key", "current", "watch", "当前备注");
    const unloadedA = session("session-a", "a-key", "tester-a", "fail", "A 备注");
    const unloadedB = session("session-b", "b-key", "tester-b", "pass", "B 备注");
    const sharedData = data(
      [current],
      [
        tester("current-key", "current", { pass: 0, watch: 1, fail: 0 }),
        tester("a-key", "tester-a", { pass: 0, watch: 0, fail: 1 }),
        tester("b-key", "tester-b", { pass: 1, watch: 0, fail: 0 })
      ]
    );
    const reviewA = review(unloadedA.sessionId, { title: "未加载复核 A" });
    const reviewB = review(unloadedB.sessionId, { title: "未加载复核 B" });
    sharedData.operations = operations([reviewA, reviewB]);
    const loadA = deferred<TesterSessionSummary | null>();
    const loadB = deferred<TesterSessionSummary | null>();
    vi.mocked(sharedData.loadSession).mockImplementation((sessionId: string) =>
      sessionId === unloadedA.sessionId ? loadA.promise : loadB.promise
    );
    const sharedAgent = agent();
    const sharedUser = user();
    const renderWith = async (nextData: AdminTestingData) => {
      await act(async () => {
        renderer?.update(
          <EvidenceWorkspace
            active
            requestedSessionId={null}
            onRequestedSessionHandled={vi.fn()}
            agent={sharedAgent}
            user={sharedUser}
            data={nextData}
          />
        );
      });
    };
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={sharedUser}
          data={sharedData}
        />
      );
    });

    const queueLinks = renderer.root.findAll(
      (node) => node.type === "button" && node.props.className === "reviewEvidenceLink"
    );
    act(() => queueLinks[0].props.onClick());
    act(() => queueLinks[1].props.onClick());
    await act(async () => {
      loadB.resolve(unloadedB);
      await loadB.promise;
    });
    const dataWithB = {
      ...sharedData,
      sessions: [current, unloadedB],
      sessionDetails: { ...sharedData.sessionDetails, [unloadedB.sessionId]: unloadedB },
      sessionTotal: 2
    };
    await renderWith(dataWithB);
    expect(reviewTitleInput(renderer).props.value).toBe("未加载复核 B");
    expect(textarea(renderer, "复现上下文、设备条件和调查记录…").props.value).toBe("B 备注");
    expect(renderer.root.find((node) => node.type === "button" && text(node) === "PASS").props["aria-pressed"]).toBe(
      true
    );

    await act(async () => {
      loadA.resolve(unloadedA);
      await loadA.promise;
    });
    const selectedTester = renderer.root.find((node) => node.type === "tr" && node.props.className === "selected");
    const selectedSessionButton = renderer.root.find(
      (node) => node.type === "button" && node.props.className === "sessionButton active"
    );
    expect(text(selectedTester)).toContain("tester-b");
    expect(text(selectedSessionButton)).toContain("tester-b目标用例");
    expect(renderer.root.find((node) => node.type === "button" && text(node) === "PASS").props["aria-pressed"]).toBe(
      true
    );
    expect(textarea(renderer, "复现上下文、设备条件和调查记录…").props.value).toBe("B 备注");
    expect(reviewTitleInput(renderer).props.value).toBe("未加载复核 B");
  });

  it.each(["ordinary session row", "overview requested session"] as const)(
    "invalidates a pending queue handoff after a newer %s intent",
    async (navigationKind) => {
      const unloadedA = session("session-a", "a-key", "tester-a", "fail", "A 备注");
      const selectedB = session("session-b", "b-key", "tester-b", "pass", "B 备注");
      const sharedData = data(
        [selectedB],
        [
          tester("b-key", "tester-b", { pass: 1, watch: 0, fail: 0 }),
          tester("a-key", "tester-a", { pass: 0, watch: 0, fail: 1 })
        ]
      );
      const reviewA = review(unloadedA.sessionId, { title: "未加载复核 A" });
      const reviewB = review(selectedB.sessionId, { title: "已选择复核 B" });
      sharedData.operations = operations([reviewA, reviewB]);
      const loadA = deferred<TesterSessionSummary | null>();
      vi.mocked(sharedData.loadSession).mockImplementation((sessionId: string) =>
        sessionId === unloadedA.sessionId ? loadA.promise : Promise.resolve(selectedB)
      );
      const sharedAgent = agent();
      const sharedUser = user();
      const onRequestedSessionHandled = vi.fn();
      const renderEvidence = async (requestedSessionId: string | null, focusRequestKey: number) => {
        await act(async () => {
          renderer?.update(
            <EvidenceWorkspace
              active
              focusRequestKey={focusRequestKey}
              requestedSessionId={requestedSessionId}
              onRequestedSessionHandled={onRequestedSessionHandled}
              agent={sharedAgent}
              user={sharedUser}
              data={sharedData}
            />
          );
        });
      };
      await act(async () => {
        renderer = create(
          <EvidenceWorkspace
            active
            focusRequestKey={0}
            requestedSessionId={null}
            onRequestedSessionHandled={onRequestedSessionHandled}
            agent={sharedAgent}
            user={sharedUser}
            data={sharedData}
          />
        );
      });
      await flush();

      const queueA = renderer.root.find(
        (node) => node.type === "button" && node.props.className === "reviewEvidenceLink" && text(node).includes("A")
      );
      act(() => queueA.props.onClick());
      if (navigationKind === "ordinary session row") {
        const sessionBButton = renderer.root.find(
          (node) => node.type === "button" && String(node.props.className).startsWith("sessionButton")
        );
        expect(text(sessionBButton)).toContain("tester-b");
        act(() => sessionBButton.props.onClick());
      } else {
        await renderEvidence(selectedB.sessionId, 1);
        await flush();
      }
      expect(reviewTitleInput(renderer).props.value).toBe("已选择复核 B");

      await act(async () => {
        loadA.resolve(unloadedA);
        await loadA.promise;
      });
      const selectedTester = renderer.root.find((node) => node.type === "tr" && node.props.className === "selected");
      const selectedSessionButton = renderer.root.find(
        (node) => node.type === "button" && node.props.className === "sessionButton active"
      );
      expect(text(selectedTester)).toContain("tester-b");
      expect(text(selectedSessionButton)).toContain("tester-b目标用例");
      const expectedQuality = navigationKind === "ordinary session row" ? "全部" : "PASS";
      expect(
        renderer.root.find((node) => node.type === "button" && text(node) === expectedQuality).props["aria-pressed"]
      ).toBe(true);
      expect(textarea(renderer, "复现上下文、设备条件和调查记录…").props.value).toBe("B 备注");
      expect(reviewTitleInput(renderer).props.value).toBe("已选择复核 B");
    }
  );

  it("reconciles a clean review draft when the same review revision changes", async () => {
    const selected = session("selected-session", "selected-key", "selected", "fail", "");
    const firstReview = review(selected.sessionId, { title: "服务端版本 1", updatedAt: 1 });
    const sharedData = data([selected], [tester("selected-key", "selected", { pass: 0, watch: 0, fail: 1 })]);
    sharedData.operations = operations([firstReview]);
    const sharedAgent = agent();
    const sharedUser = user();
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={sharedUser}
          data={sharedData}
        />
      );
    });
    expect(reviewTitleInput(renderer).props.value).toBe("服务端版本 1");

    const updatedReview = { ...firstReview, title: "服务端版本 2", updatedAt: 2 };
    await act(async () => {
      renderer?.update(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={sharedUser}
          data={{ ...sharedData, operations: operations([updatedReview]) }}
        />
      );
    });
    expect(reviewTitleInput(renderer).props.value).toBe("服务端版本 2");
  });

  it("preserves a dirty review draft through hidden polling, resolution, and replacement", async () => {
    const selected = session("selected-session", "selected-key", "selected", "fail", "");
    const firstReview = review(selected.sessionId, { title: "初始服务端标题", updatedAt: 1 });
    const sharedData = data([selected], [tester("selected-key", "selected", { pass: 0, watch: 0, fail: 1 })]);
    sharedData.operations = operations([firstReview]);
    const sharedAgent = agent();
    const sharedUser = user();
    const renderReviews = async (reviews: TestingReview[], active: boolean) => {
      await act(async () => {
        renderer?.update(
          <EvidenceWorkspace
            active={active}
            requestedSessionId={null}
            onRequestedSessionHandled={vi.fn()}
            agent={sharedAgent}
            user={sharedUser}
            data={{ ...sharedData, operations: operations(reviews) }}
          />
        );
      });
    };
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={sharedUser}
          data={sharedData}
        />
      );
    });
    act(() => reviewTitleInput(renderer).props.onChange({ target: { value: "未保存复核草稿" } }));

    await renderReviews([{ ...firstReview, title: "轮询版本", updatedAt: 2 }], false);
    expect(reviewTitleInput(renderer).props.value).toBe("未保存复核草稿");
    await renderReviews([{ ...firstReview, status: "resolved", title: "已解决版本", updatedAt: 3 }], false);
    expect(reviewTitleInput(renderer).props.value).toBe("未保存复核草稿");
    await renderReviews(
      [review(selected.sessionId, { id: "replacement-review", title: "替换复核", updatedAt: 4 })],
      false
    );
    expect(reviewTitleInput(renderer).props.value).toBe("未保存复核草稿");
    await renderReviews(
      [review(selected.sessionId, { id: "replacement-review", title: "替换复核", updatedAt: 4 })],
      true
    );
    expect(reviewTitleInput(renderer).props.value).toBe("未保存复核草稿");
  });

  it("cleans only the submitted current review draft after a successful save", async () => {
    const selected = session("selected-session", "selected-key", "selected", "fail", "");
    const firstReview = review(selected.sessionId, { title: "初始标题", updatedAt: 1 });
    const sharedData = data([selected], [tester("selected-key", "selected", { pass: 0, watch: 0, fail: 1 })]);
    sharedData.operations = operations([firstReview]);
    const pending = deferred<Awaited<ReturnType<AdminTestingData["saveReview"]>>>();
    vi.mocked(sharedData.saveReview).mockReturnValue(pending.promise);
    const sharedAgent = agent();
    const sharedUser = user();
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={sharedUser}
          data={sharedData}
        />
      );
    });
    act(() => reviewTitleInput(renderer).props.onChange({ target: { value: "提交版本" } }));
    act(() => reviewSubmitButton(renderer).props.onClick());
    act(() => reviewTitleInput(renderer).props.onChange({ target: { value: "保存期间的新编辑" } }));
    await act(async () => {
      pending.resolve({ ok: true, data: { ...firstReview, title: "提交版本", updatedAt: 2 } });
      await pending.promise;
    });
    await act(async () => {
      renderer?.update(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={sharedUser}
          data={{
            ...sharedData,
            operations: operations([{ ...firstReview, title: "服务器后续版本", updatedAt: 3 }])
          }}
        />
      );
    });
    expect(reviewTitleInput(renderer).props.value).toBe("保存期间的新编辑");
  });

  it("marks an unchanged submitted review draft clean so later polling can reconcile", async () => {
    const selected = session("selected-session", "selected-key", "selected", "fail", "");
    const firstReview = review(selected.sessionId, { title: "初始标题", updatedAt: 1 });
    const savedReview = { ...firstReview, title: "提交版本", updatedAt: 2 };
    const sharedData = data([selected], [tester("selected-key", "selected", { pass: 0, watch: 0, fail: 1 })]);
    sharedData.operations = operations([firstReview]);
    vi.mocked(sharedData.saveReview).mockResolvedValue({ ok: true, data: savedReview });
    const sharedAgent = agent();
    const sharedUser = user();
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={sharedUser}
          data={sharedData}
        />
      );
    });
    act(() => reviewTitleInput(renderer).props.onChange({ target: { value: "提交版本" } }));
    await act(async () => reviewSubmitButton(renderer).props.onClick());
    expect(reviewTitleInput(renderer).props.value).toBe("提交版本");

    await act(async () => {
      renderer?.update(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={sharedUser}
          data={{
            ...sharedData,
            operations: operations([{ ...savedReview, title: "服务器后续版本", updatedAt: 3 }])
          }}
        />
      );
    });
    expect(reviewTitleInput(renderer).props.value).toBe("服务器后续版本");
  });

  it("blocks a dirty replaced review from mutating the replacement until the operator adopts it", async () => {
    const selected = session("selected-session", "selected-key", "selected", "fail", "");
    const reviewA = review(selected.sessionId, { id: "review-a", title: "复核 A", updatedAt: 1 });
    const reviewB = review(selected.sessionId, { id: "review-b", title: "复核 B", updatedAt: 2 });
    const sharedData = data([selected], [tester("selected-key", "selected", { pass: 0, watch: 0, fail: 1 })]);
    sharedData.operations = operations([reviewA]);
    vi.mocked(sharedData.saveReview).mockResolvedValue({ ok: true, data: reviewB });
    const sharedAgent = agent();
    const sharedUser = user();
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={sharedUser}
          data={sharedData}
        />
      );
    });
    act(() => reviewTitleInput(renderer).props.onChange({ target: { value: "A 的未保存草稿" } }));
    await act(async () => {
      renderer?.update(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={sharedAgent}
          user={sharedUser}
          data={{ ...sharedData, operations: operations([reviewB]) }}
        />
      );
    });
    expect(reviewTitleInput(renderer).props.value).toBe("A 的未保存草稿");

    await act(async () => reviewSubmitButton(renderer).props.onClick());
    expect(sharedData.saveReview).not.toHaveBeenCalled();
    expect(text(renderer.root)).toContain("复核记录已变化");
    const adoptLatest = renderer.root.find((node) => node.type === "button" && text(node) === "采用最新复核");
    act(() => adoptLatest.props.onClick());
    expect(reviewTitleInput(renderer).props.value).toBe("复核 B");

    act(() => reviewTitleInput(renderer).props.onChange({ target: { value: "基于 B 的新草稿" } }));
    await act(async () => reviewSubmitButton(renderer).props.onClick());
    expect(sharedData.saveReview).toHaveBeenCalledTimes(1);
    expect(sharedData.saveReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: "review-b", status: "open", title: "基于 B 的新草稿" })
    );
  });

  it("selects a later active review when an earlier same-session review is resolved", async () => {
    const selected = session("selected-session", "selected-key", "selected", "fail", "");
    const resolved = review(selected.sessionId, {
      id: "review-resolved",
      status: "resolved",
      title: "已解决复核",
      updatedAt: 1
    });
    const activeReview = review(selected.sessionId, {
      id: "review-active",
      status: "triaged",
      title: "仍在处理的复核",
      updatedAt: 2
    });
    const sharedData = data([selected], [tester("selected-key", "selected", { pass: 0, watch: 0, fail: 1 })]);
    sharedData.operations = operations([resolved, activeReview]);
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={vi.fn()}
          agent={agent()}
          user={user()}
          data={sharedData}
        />
      );
    });

    expect(reviewTitleInput(renderer).props.value).toBe("仍在处理的复核");
    expect(text(reviewSubmitButton(renderer))).toBe("更新复核");
    const resolvedQueueLink = renderer.root.find(
      (node) =>
        node.type === "button" && node.props.className === "reviewEvidenceLink" && text(node).includes("已解决复核")
    );
    act(() => resolvedQueueLink.props.onClick());
    expect(reviewTitleInput(renderer).props.value).toBe("仍在处理的复核");
  });
});

describe("Admin evidence presentation guards", () => {
  function currentRun(overrides: Partial<TestingRun> = {}): TestingRun {
    return {
      id: "current-run",
      name: "Current release",
      build: "abcdef123456",
      status: "ready",
      owner: "admin",
      createdAt: 1,
      updatedAt: 2,
      policyVersion: "policy-v1",
      requirements: [],
      assignments: [],
      notes: "",
      ...overrides
    };
  }

  it.each(["open", "triaged"] as const)("blocks the overview for a current run's %s safety review", async (status) => {
    const snapshot = testing([], []);
    const current = operations([review("adas-failure", { runId: "current-run", status, severity: "critical" })]);
    current.runs = [currentRun()];
    await act(async () => {
      renderer = create(
        <AdminOverview
          agent={agent()}
          testing={snapshot}
          sessions={[]}
          operations={current}
          onOpenEvidence={vi.fn()}
          onOpenReleases={vi.fn()}
        />
      );
    });
    const card = renderer!.root.find((node) => node.type === "button" && text(node).includes("发布门禁"));
    expect(text(card.findByType("strong"))).toBe("受阻");
    expect(text(renderer!.root)).toContain("本运行未完成的证据复核");
  });

  it("keeps a manually blocked current run blocked even when numeric checks pass", async () => {
    const current = operations([]);
    current.runs = [currentRun({ status: "blocked" })];
    await act(async () => {
      renderer = create(
        <AdminOverview
          agent={agent()}
          testing={testing([], [])}
          sessions={[]}
          operations={current}
          onOpenEvidence={vi.fn()}
          onOpenReleases={vi.fn()}
        />
      );
    });
    const card = renderer!.root.find((node) => node.type === "button" && text(node).includes("发布门禁"));
    expect(text(card.findByType("strong"))).toBe("受阻");
  });

  it("shows the same blocked run to testers whose role-scoped runs have no operations metadata", async () => {
    await act(async () => {
      renderer = create(
        <AdminOverview
          agent={agent()}
          testing={testing([], [])}
          sessions={[]}
          operations={null}
          runs={[currentRun({ status: "blocked" })]}
          onOpenEvidence={vi.fn()}
          onOpenReleases={vi.fn()}
        />
      );
    });
    const card = renderer!.root.find((node) => node.type === "button" && text(node).includes("发布门禁"));
    expect(text(card.findByType("strong"))).toBe("受阻");
  });

  it("waits for authoritative release review when only a tester's partial assignments are available", async () => {
    await act(async () => {
      renderer = create(
        <AdminOverview
          agent={agent()}
          testing={testing([], [])}
          sessions={[]}
          operations={null}
          runs={[currentRun()]}
          onOpenEvidence={vi.fn()}
          onOpenReleases={vi.fn()}
        />
      );
    });
    const card = renderer!.root.find((node) => node.type === "button" && text(node).includes("发布门禁"));
    expect(text(card.findByType("strong"))).toBe("等待");
    expect(text(renderer!.root)).toContain("等待发布复核信息");
  });

  it("requires current-run coverage before showing awaiting approval", async () => {
    const current = operations([]);
    current.runs = [
      currentRun({
        requirements: [
          {
            id: "required-adas",
            testCaseId: "adas-alert-interrupt",
            platform: "android",
            networkType: "any",
            language: "any",
            requiredValidSessions: 2
          }
        ]
      })
    ];
    await act(async () => {
      renderer = create(
        <AdminOverview
          agent={agent()}
          testing={testing([], [])}
          sessions={[]}
          operations={current}
          onOpenEvidence={vi.fn()}
          onOpenReleases={vi.fn()}
        />
      );
    });
    const card = renderer!.root.find((node) => node.type === "button" && text(node).includes("发布门禁"));
    expect(text(card.findByType("strong"))).toBe("受阻");
    expect(text(renderer!.root)).toContain("完成全部覆盖要求");
  });

  it("scopes overview blockers to the latest matching run and ignores resolved reviews", async () => {
    const current = operations([
      review("old-adas", { runId: "old-run", status: "open" }),
      review("fixed-adas", { runId: "current-run", status: "resolved" })
    ]);
    current.runs = [currentRun({ id: "old-run", updatedAt: 1, status: "blocked" }), currentRun()];
    await act(async () => {
      renderer = create(
        <AdminOverview
          agent={agent()}
          testing={testing([], [])}
          sessions={[]}
          operations={current}
          onOpenEvidence={vi.fn()}
          onOpenReleases={vi.fn()}
        />
      );
    });
    const card = renderer!.root.find((node) => node.type === "button" && text(node).includes("发布门禁"));
    expect(text(card.findByType("strong"))).toBe("待批准");
  });

  it.each(["stale", "loading", "error"] as const)(
    "does not certify an approved snapshot when Admin data is %s",
    async (dataStatus) => {
      const current = operations([]);
      current.approvedBaselineBuild = "abcdef123456";
      await act(async () => {
        renderer = create(
          <AdminOverview
            agent={agent()}
            testing={testing([], [])}
            sessions={[]}
            operations={current}
            dataStatus={dataStatus}
            onOpenEvidence={vi.fn()}
            onOpenReleases={vi.fn()}
          />
        );
      });
      const card = renderer!.root.find((node) => node.type === "button" && text(node).includes("发布门禁"));
      expect(text(card.findByType("strong"))).toBe("等待");
      expect(text(renderer!.root)).toContain("发布数据尚未同步");
    }
  );

  it("waits for matching evidence when health advances beyond an approved testing snapshot", async () => {
    const snapshot = testing([], []);
    snapshot.releaseGate.status = "pass";
    snapshot.regression.baselineSource = "none";
    const approved = operations([]);
    approved.approvedBaselineBuild = snapshot.releaseGate.build;
    const nextAgent = {
      ...agent(),
      health: { ...agent().health!, build: { ...agent().health!.build!, gitCommit: "fedcba654321" } }
    };
    await act(async () => {
      renderer = create(
        <AdminOverview
          agent={nextAgent}
          testing={snapshot}
          sessions={[]}
          operations={approved}
          onOpenEvidence={vi.fn()}
          onOpenReleases={vi.fn()}
        />
      );
    });
    const card = renderer!.root.find((node) => node.type === "button" && text(node).includes("发布门禁"));
    expect(text(card.findByType("strong"))).toBe("等待");
    expect(text(renderer!.root)).not.toContain("已批准");
    expect(text(renderer!.root)).toContain("证据构建与当前构建不一致");
  });

  it("does not present a passed quality gate as release PASS when regression fails", async () => {
    const snapshot = testing([], []);
    snapshot.releaseGate.status = "pass";
    snapshot.regression.baselineSource = "latest-valid";
    snapshot.regression.status = "fail";
    snapshot.regression.findings = [
      { id: "wake-latency", status: "fail", label: "iOS wake", detail: "Latency increased by 259ms." }
    ];
    await act(async () => {
      renderer = create(
        <AdminOverview
          agent={agent()}
          testing={snapshot}
          sessions={[]}
          operations={operations([])}
          onOpenEvidence={vi.fn()}
          onOpenReleases={vi.fn()}
        />
      );
    });
    const card = renderer!.root.find((node) => node.type === "button" && text(node).includes("发布门禁"));
    expect(text(card.findByType("strong"))).toBe("受阻");
    expect(text(renderer!.root)).toContain("Latency increased by 259ms.");
    expect(text(card)).toContain("回归 FAIL");
  });

  it("distinguishes awaiting approval from an approved passing release", async () => {
    const snapshot = testing([], []);
    snapshot.releaseGate.status = "pass";
    snapshot.regression.baselineSource = "none";
    await act(async () => {
      renderer = create(
        <AdminOverview
          agent={agent()}
          testing={snapshot}
          sessions={[]}
          operations={operations([])}
          onOpenEvidence={vi.fn()}
          onOpenReleases={vi.fn()}
        />
      );
    });
    const card = () => renderer!.root.find((node) => node.type === "button" && text(node).includes("发布门禁"));
    expect(text(card().findByType("strong"))).toBe("待批准");
    const approved = operations([]);
    approved.approvedBaselineBuild = snapshot.releaseGate.build;
    await act(async () =>
      renderer!.update(
        <AdminOverview
          agent={agent()}
          testing={snapshot}
          sessions={[]}
          operations={approved}
          onOpenEvidence={vi.fn()}
          onOpenReleases={vi.fn()}
        />
      )
    );
    expect(text(card().findByType("strong"))).toBe("已批准");
  });

  it("shows a healthy inactive voice session and localizes admin header and waiting KPI", async () => {
    const previousWindow = window;
    const previousDocument = globalThis.document;
    const previousHTMLElement = globalThis.HTMLElement;
    vi.stubGlobal("window", {
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    });
    vi.stubGlobal("document", {
      activeElement: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    });
    vi.stubGlobal("HTMLElement", class {});
    const waiting = testing([], []);
    waiting.releaseGate.status = "waiting";
    vi.spyOn(testingApi, "fetchSummary").mockResolvedValue({ ok: true, data: waiting });
    vi.spyOn(testingApi, "fetchSessions").mockResolvedValue({ ok: true, data: { items: [], total: 0 } });
    vi.spyOn(testingApi, "fetchOperations").mockResolvedValue({
      ok: true,
      data: { operations: operations([]), policies: [policy()] }
    });
    const idleAgent = {
      ...agent(),
      connected: false,
      listening: false,
      starting: false,
      connectionState: "offline" as const
    };
    const renderWorkspace = (nextAgent: HelmetAgent) => (
      <LanguageProvider>
        <LanguageToggle />
        <AdminWorkspace agent={nextAgent} user={user()} onAuthenticationExpired={vi.fn()} onClose={vi.fn()} />
      </LanguageProvider>
    );
    try {
      await act(async () => {
        renderer = create(renderWorkspace(idleAgent));
      });
      act(() => renderer!.root.find((node) => node.type === "button" && node.children.includes("EN")).props.onClick());
      const header = renderer!.root.findByProps({ className: "adminWorkspaceContext" });
      expect(text(header)).toContain("Voice session inactive");
      expect(text(header)).not.toContain("Relay offline");
      expect(text(header)).toContain("Build abcdef123456");
      expect(text(header)).toContain("Last synced");
      const gate = renderer!.root.find((node) => node.type === "button" && text(node).includes("Release gate"));
      expect(text(gate.findByType("strong"))).toBe("Waiting");

      await act(async () => {
        renderer?.update(renderWorkspace({ ...idleAgent, connectionState: "connecting", starting: true }));
      });
      expect(text(header)).toContain("Voice · Connecting");
      await act(async () => {
        renderer?.update(renderWorkspace({ ...idleAgent, connected: true, connectionState: "degraded" }));
      });
      expect(text(header)).toContain("Voice · Degraded");
      expect(header.findAllByType("span")[0].props.className).not.toBe("online");
      await act(async () => {
        renderer?.update(renderWorkspace({ ...idleAgent, health: null }));
      });
      expect(text(header)).toContain("Build Local");
      await act(async () => {
        renderer?.update(renderWorkspace({ ...idleAgent, listening: true }));
      });
      expect(text(header)).toContain("Voice · Offline");
      act(() =>
        renderer!.root.find((node) => node.type === "button" && node.children.includes("中文")).props.onClick()
      );
      await act(async () => {
        renderer?.update(renderWorkspace(idleAgent));
      });
      expect(text(header)).toContain("语音会话未开启");
      expect(text(header)).toContain("构建 abcdef123456");
      expect(text(gate.findByType("strong"))).toBe("等待");
    } finally {
      await act(async () => renderer?.unmount());
      renderer = null;
      vi.stubGlobal("window", previousWindow);
      vi.stubGlobal("document", previousDocument);
      vi.stubGlobal("HTMLElement", previousHTMLElement);
    }
  });

  it("ships an author-level hidden rule that overrides the testing panel display", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

    expect(styles).toMatch(
      /\.adminWorkspaceContent\s*>\s*\.testingPanel\[hidden\]\s*\{[^}]*display:\s*none\s*!important;?[^}]*\}/s
    );
  });

  it("keeps valid evidence and P95 cautionary while the gate has no decision-grade evidence", async () => {
    const waiting = testing([], []);
    waiting.totals.p95LatencyMs = 0;
    waiting.releaseGate.status = "waiting";
    waiting.releaseGate.validSessions = 0;
    waiting.releaseGate.invalidSessions = 0;
    waiting.releaseGate.p95LatencyMs = 0;

    await act(async () => {
      renderer = create(
        <AdminOverview
          agent={agent()}
          testing={waiting}
          sessions={[]}
          operations={null}
          onOpenEvidence={vi.fn()}
          onOpenReleases={vi.fn()}
        />
      );
    });

    const validEvidence = renderer!.root.find((node) => node.type === "button" && text(node).includes("有效证据"));
    const p95 = renderer!.root.find((node) => node.type === "button" && text(node).includes("门禁 P95 首音"));
    expect(validEvidence.props.className).toBe("opsCard warn");
    expect(p95.props.className).toBe("opsCard warn");
  });

  it("keeps the tablet section bar clear of an auto-height header and constrains long context", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const tabletStyles = [
      ...styles.matchAll(/@media \(max-width: 900px\) \{([\s\S]*?)(?=\n\}\n\n@media|\n\}\n\n\/\*)/g)
    ].find((match) => match[1].includes(".adminWorkspaceLayout"))?.[1];

    expect(tabletStyles).toMatch(/\.adminWorkspaceHeader\s*\{[^}]*position:\s*relative;/s);
    expect(tabletStyles).toMatch(/\.adminWorkspaceNav\s*\{[^}]*top:\s*0;/s);
    expect(styles).toMatch(
      /\.adminWorkspaceContext\s*>\s*span,\s*\.adminWorkspaceContext\s*>\s*small\s*\{[^}]*max-width:[^;]+;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s
    );
  });

  it("stacks overview and detail work areas at the tablet breakpoint", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const tabletStyles = [
      ...styles.matchAll(/@media \(max-width: 900px\) \{([\s\S]*?)(?=\n\}\n\n@media|\n\}\n\n\/\*)/g)
    ].find((match) => match[1].includes(".adminWorkspaceLayout"))?.[1];
    const singleColumnSelectors = [...(tabletStyles?.matchAll(/([^{}]+)\{[^{}]*grid-template-columns:\s*1fr;/g) ?? [])]
      .map((match) => match[1])
      .join("\n");

    expect(singleColumnSelectors).toContain(".adminWorkGrid");
    expect(singleColumnSelectors).toContain(".adminDataSplit");
  });

  it("collapses every operational form grid through the 640px breakpoint", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const mobileStyles = [
      ...styles.matchAll(/@media \(max-width: 640px\) \{([\s\S]*?)(?=\n\}\n\n@media|\n\}\n\n\/\*)/g)
    ].find((match) => match[1].includes(".adminWorkspaceHeader"))?.[1];
    const singleColumnSelectors = [...(mobileStyles?.matchAll(/([^{}]+)\{[^{}]*grid-template-columns:\s*1fr;/g) ?? [])]
      .map((match) => match[1])
      .join("\n");

    for (const selector of [".runCreateBar", ".coverageMatrix", ".reviewFields", ".policyFields", ".evidenceNotes"]) {
      expect(singleColumnSelectors).toContain(selector);
    }
  });

  it("preserves each semantic metric edge color on hover", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

    expect(styles).toMatch(
      /\.adminMetricGrid\s+button\.opsCard\.good:hover\s*\{[^}]*border-left-color:\s*var\(--admin-good\);/s
    );
    expect(styles).toMatch(
      /\.adminMetricGrid\s+button\.opsCard\.warn:hover\s*\{[^}]*border-left-color:\s*var\(--admin-warn\);/s
    );
    expect(styles).toMatch(
      /\.adminMetricGrid\s+button\.opsCard\.alert:hover\s*\{[^}]*border-left-color:\s*var\(--admin-alert\);/s
    );
  });
});
