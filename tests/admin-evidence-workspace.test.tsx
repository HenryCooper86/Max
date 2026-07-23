import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TesterSessionSummary, TesterStats, TestingStats } from "../shared/agent";
import { TESTING_CAMPAIGNS, TESTING_TEST_CASES } from "../shared/testing";
import type { HelmetAgent } from "../src/hooks/useHelmetAgent";
import type { AuthUser } from "../src/lib/auth";
import { EvidenceWorkspace } from "../src/components/admin/EvidenceWorkspace";
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

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}

function input(renderer: ReactTestRenderer, placeholder: string) {
  return renderer.root.find((node) => node.type === "input" && node.props.placeholder === placeholder);
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
    await act(async () => {
      renderer = create(
        <EvidenceWorkspace
          active
          requestedSessionId={null}
          onRequestedSessionHandled={onRequestedSessionHandled}
          agent={agent()}
          user={user()}
          data={sharedData}
        />
      );
    });
    await flush();

    await act(async () => {
      input(renderer!, "用例、设备、标记或构建").props.onChange({ target: { value: "不存在" } });
      renderer!.root.find((node) => node.type === "button" && text(node) === "PASS").props.onClick();
    });

    await act(async () => {
      renderer!.update(
        <EvidenceWorkspace
          active
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

  it("preserves filters, selection, and note draft while hidden and removes background focus exposure", async () => {
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
      renderer!.root.findByType("textarea").props.onChange({ target: { value: "未保存草稿" } });
    });

    await act(async () => {
      renderer!.update(
        <EvidenceWorkspace
          active={false}
          requestedSessionId={null}
          onRequestedSessionHandled={onRequestedSessionHandled}
          agent={sharedAgent}
          user={sharedUser}
          data={sharedData}
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
          data={sharedData}
        />
      );
    });

    expect(input(renderer!, "ID、IP 或区域").props.value).toBe("华东");
    expect(input(renderer!, "用例、设备、标记或构建").props.value).toBe("目标用例");
    expect(renderer!.root.findByType("textarea").props.value).toBe("未保存草稿");
    expect(hiddenWorkspace.props.hidden).toBe(false);
    expect(hiddenWorkspace.props.inert).toBeUndefined();
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
