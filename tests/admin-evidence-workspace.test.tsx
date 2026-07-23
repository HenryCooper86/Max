import { readFileSync } from "node:fs";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TesterSessionSummary, TesterStats, TestingStats } from "../shared/agent";
import {
  TESTING_CAMPAIGNS,
  TESTING_TEST_CASES,
  type TestingOperationsSnapshot,
  type TestingPolicy,
  type TestingReview
} from "../shared/testing";
import { AdminOverview } from "../src/components/admin/AdminOverview";
import { EvidenceWorkspace } from "../src/components/admin/EvidenceWorkspace";
import type { HelmetAgent } from "../src/hooks/useHelmetAgent";
import type { AuthUser } from "../src/lib/auth";
import type { AdminTestingData } from "../src/components/admin/useAdminTestingData";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("window", globalThis);

const campaign = TESTING_CAMPAIGNS[0];
const testCase = TESTING_TEST_CASES.find((item) => item.campaignId === campaign.id) ?? TESTING_TEST_CASES[0];

function user(): AuthUser {
  return {
    id: "admin",
    username: "admin",
    displayName: "管理员",
    role: "admin",
    createdAt: 1,
    lastLoginAt: 1
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

function review(sessionId: string): TestingReview {
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
    createdBy: "reviewer"
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
});

describe("Admin evidence presentation guards", () => {
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
});
