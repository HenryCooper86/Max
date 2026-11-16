import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TesterSessionSummary } from "../shared/agent";
import {
  TESTING_CAMPAIGNS,
  TESTING_TEST_CASES,
  type TestingAssignment,
  type TestingOperationsSnapshot,
  type TestingPolicy,
  type TestingRun,
  type TestingRunRequirement
} from "../shared/testing";
import { TestingOverview } from "../src/components/admin/TestingOverview";
import { TestPlans } from "../src/components/admin/TestPlans";
import { OperationsWorkspace } from "../src/components/admin/OperationsWorkspace";
import { leaveWorkspaceLocation } from "../src/components/admin/workspace-location";
import { useAdminTestingData, type AdminTestingData } from "../src/components/admin/useAdminTestingData";
import type { HelmetAgent } from "../src/hooks/useHelmetAgent";
import type { AuthUser } from "../src/lib/auth";

// The workspace host fetches its own data; these tests replace the hook with a
// controlled snapshot so authorization and rendering boundaries are exercised
// without live network. Components under test are the real ones.
vi.mock("../src/components/admin/useAdminTestingData", () => ({
  useAdminTestingData: vi.fn()
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const campaign = TESTING_CAMPAIGNS[0];
const testCase = TESTING_TEST_CASES[0];

function authUser(role: AuthUser["role"], overrides: Partial<AuthUser> = {}): AuthUser {
  return { id: role, username: role, displayName: role, role, createdAt: 1, lastLoginAt: 1, ...overrides };
}

function session(overrides: Partial<TesterSessionSummary> = {}): TesterSessionSummary {
  return {
    sessionId: "session-1",
    testerKey: "tester-key",
    testerId: "kim",
    ipAddress: "127.0.0.1",
    region: "华东",
    campaignId: campaign.id,
    campaignName: campaign.name,
    testCaseId: testCase.id,
    testCaseName: testCase.name,
    appVersion: "0.1.0",
    gitCommit: "abcdef123456",
    deviceLabel: "浏览器",
    browserLanguage: "zh-CN",
    networkType: "wifi",
    platform: "web",
    startedAt: 1,
    endedAt: 2,
    durationMs: 1000,
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
    quality: "pass",
    validity: { status: "valid", reasons: [], detail: "有效" },
    flags: [],
    notes: "",
    policyVersion: "policy-v1",
    evidenceHash: "abcdef1234567890",
    evidenceIntegrity: "verified",
    capturedEvaluation: {
      testCaseId: testCase.id,
      testCaseName: testCase.name,
      score: 100,
      quality: "pass",
      checks: []
    },
    capturedValidity: { status: "valid", reasons: [], detail: "有效" },
    audioQuality: { droppedFrames: 0, outgoingFps: 50, jitterMs: 0, clippingPct: 0, silencePct: 0 },
    evaluation: { testCaseId: testCase.id, testCaseName: testCase.name, score: 100, quality: "pass", checks: [] },
    turns: [],
    ...overrides
  };
}

function policy(): TestingPolicy {
  return {
    version: "v1",
    createdAt: 1,
    createdBy: "admin",
    description: "策略",
    active: true,
    release: {
      maxFailSessions: 0,
      maxWatchSessions: 1,
      maxInvalidSessions: 0,
      maxP95LatencyMs: 800,
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

function operations(runs: TestingRun[] = []): TestingOperationsSnapshot {
  return { activePolicy: policy(), runs, reviews: [], audit: [] };
}

function requirement(overrides: Partial<TestingRunRequirement> = {}): TestingRunRequirement {
  return {
    id: "req-1",
    testCaseId: testCase.id,
    platform: "web",
    networkType: "wifi",
    language: "zh",
    requiredValidSessions: 1,
    ...overrides
  };
}

function assignment(overrides: Partial<TestingAssignment> = {}): TestingAssignment {
  return {
    id: "assignment-1",
    runId: "run-1",
    requirementId: "req-1",
    testCaseId: testCase.id,
    assignee: "kim",
    platform: "web",
    networkType: "wifi",
    language: "zh",
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    completedSessionIds: [],
    ...overrides
  };
}

function run(overrides: Partial<TestingRun> = {}): TestingRun {
  return {
    id: "run-1",
    name: "候选发布",
    build: "build-1",
    status: "active",
    owner: "reviewer",
    createdAt: 1,
    updatedAt: 1,
    policyVersion: "policy-v1",
    requirements: [],
    assignments: [],
    notes: "",
    ...overrides
  };
}

function adminData(overrides: Partial<AdminTestingData> = {}): AdminTestingData {
  return {
    testing: null,
    sessions: [],
    sessionDetails: {},
    operations: null,
    policies: [],
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
    createPolicy: vi.fn(),
    ...overrides
  };
}

function agent(overrides: Partial<HelmetAgent> = {}): HelmetAgent {
  return {
    health: { build: { gitCommit: "build-current" } },
    connectionState: "offline",
    listening: false,
    starting: false,
    refreshHealth: vi.fn().mockResolvedValue(undefined),
    setTestingAssignmentContext: vi.fn(),
    ...overrides
  } as unknown as HelmetAgent;
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}

function qualityCardStrong(renderer: ReactTestRenderer, tone: "good" | "warn" | "alert"): string {
  const card = renderer.root.findAll(
    (node) => node.type === "button" && node.props.className === `testingQualityCard ${tone}`
  )[0];
  return text(card.findByType("strong"));
}

function navTargets(root: ReactTestInstance): string[] {
  return root
    .findByProps({ className: "adminWorkspaceNavTabs" })
    .findAllByType("a")
    .map((link) => String(link.props.href));
}

function flush() {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const plainClick = { preventDefault: () => undefined, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
const QA_TESTING_NAV = ["overview", "plans", "evidence", "quality", "releases", "diagnostics", "policies"].map(
  (section) => `#/testing/${section}`
);

let renderer: ReactTestRenderer | null = null;
let locationStub: LocationStub | null = null;

type LocationStub = { restore: () => void; hash: () => string };

/** react-test-renderer has no DOM history; an EventTarget-backed URL stands in
 * for location/history/hashchange so URL-driven workspace routing can be
 * exercised end to end. */
function stubBrowserLocation(initialHash: string): LocationStub {
  let url = new URL(`https://max.example/app${initialHash}`);
  const listeners = new Set<() => void>();
  const scope = globalThis as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>([
    ["location", scope.location],
    ["history", scope.history],
    ["addEventListener", scope.addEventListener],
    ["removeEventListener", scope.removeEventListener],
    ["dispatchEvent", scope.dispatchEvent]
  ]);
  const location = {
    get hash() {
      return url.hash;
    },
    get pathname() {
      return url.pathname;
    },
    get search() {
      return url.search;
    },
    get origin() {
      return url.origin;
    }
  };
  const history = {
    pushState: (_state: unknown, _title: string, next: string) => {
      url = new URL(next, url);
    },
    replaceState: (_state: unknown, _title: string, next: string) => {
      url = new URL(next, url);
    }
  };
  const fire = () => {
    for (const listener of [...listeners]) listener();
  };
  scope.location = location;
  scope.history = history;
  scope.addEventListener = (type: string, listener: () => void) => {
    if (type === "hashchange" || type === "popstate") listeners.add(listener);
  };
  scope.removeEventListener = (_type: string, listener: () => void) => {
    listeners.delete(listener);
  };
  scope.dispatchEvent = (event: Event) => {
    if (event.type === "hashchange") fire();
    return true;
  };
  return {
    restore: () => {
      for (const [key, value] of originals) {
        if (value === undefined) delete scope[key];
        else scope[key] = value;
      }
    },
    hash: () => url.hash
  };
}

beforeEach(() => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", {
    hidden: false,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  });
  vi.stubGlobal("HTMLElement", class {});
  const originalConsoleError = console.error;
  vi.spyOn(console, "error").mockImplementation((message: unknown, ...optionalParams: unknown[]) => {
    if (message === "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer") return;
    originalConsoleError(message, ...optionalParams);
  });
});

afterEach(async () => {
  // Unmount while the fake browser and EventTarget stubs are still installed so
  // effect cleanups (window.removeEventListener) can run, then restore globals.
  if (renderer) {
    await act(async () => renderer?.unmount());
    renderer = null;
  }
  locationStub?.restore();
  locationStub = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(useAdminTestingData).mockReset();
});

describe("TestingOverview", () => {
  it("renders a pass-quality recording with invalid validity as incomplete, never success", async () => {
    const invalid = session({
      sessionId: "bad-1",
      quality: "pass",
      validity: { status: "invalid", reasons: ["too-short"], detail: "太短" }
    });
    const data = adminData({ sessions: [invalid], sessionTotal: 1 });
    await act(async () => {
      renderer = create(
        <TestingOverview
          user={authUser("tester")}
          data={data}
          onOpenSessions={vi.fn()}
          onOpenPlans={vi.fn()}
          onStartTesting={vi.fn()}
        />
      );
    });
    const chip = renderer!.root.find(
      (node) =>
        node.type === "span" &&
        typeof node.props.className === "string" &&
        node.props.className.includes("testingQualityChip")
    );
    expect(text(chip)).toBe("记录不完整");
    expect(text(renderer!.root)).toContain("录音时长太短");
    // The pass bucket does not count it; the incomplete bucket does.
    expect(qualityCardStrong(renderer!, "good")).toBe("0");
    const incomplete = renderer!.root.find(
      (node) => node.props.className === "testingQualityCard warn" && text(node).startsWith("记录不完整")
    );
    expect(text(incomplete.findByType("strong"))).toBe("1");
  });

  it("scopes counts to the loaded recent page and reports earlier records honestly", async () => {
    const sessions = Array.from({ length: 8 }, (_, i) =>
      session({ sessionId: `s${i}`, endedAt: 100 + i, quality: i < 2 ? "fail" : "pass" })
    );
    const data = adminData({ sessions, sessionTotal: 10 });
    await act(async () => {
      renderer = create(
        <TestingOverview
          user={authUser("tester")}
          data={data}
          onOpenSessions={vi.fn()}
          onOpenPlans={vi.fn()}
          onStartTesting={vi.fn()}
        />
      );
    });
    expect(renderer!.root.findAllByProps({ className: "testingSessionRow" })).toHaveLength(6);
    // Only the six displayed records are counted; the two older fail records fall outside the page.
    expect(qualityCardStrong(renderer!, "good")).toBe("6");
    expect(qualityCardStrong(renderer!, "alert")).toBe("0");
    // Earlier-record count is the total minus the displayed page, not the loaded page.
    const earlier = renderer!.root.find((node) => node.type === "p" && node.props.className === "testingResultScope");
    expect(text(earlier).match(/\d+/g)).toEqual(["4"]);
  });

  it("preserves a tester-authored session name verbatim", async () => {
    const custom = session({
      sessionId: "named-1",
      testCaseId: "custom-case",
      testCaseName: "紧急制动 · 用户自述「安全第一」!!",
      quality: "pass"
    });
    const data = adminData({ sessions: [custom], sessionTotal: 1 });
    await act(async () => {
      renderer = create(
        <TestingOverview
          user={authUser("tester")}
          data={data}
          onOpenSessions={vi.fn()}
          onOpenPlans={vi.fn()}
          onStartTesting={vi.fn()}
        />
      );
    });
    const row = renderer!.root.findByProps({ className: "testingSessionRow" });
    expect(text(row.findByType("strong"))).toBe("紧急制动 · 用户自述「安全第一」!!");
  });
});

describe("TestPlans", () => {
  it("shows a tester only their own assigned requirements, capped and without metadata", async () => {
    const reqA = requirement({ id: "REQ-SECRET-A", testCaseId: "emergency-safe-guidance", requiredValidSessions: 2 });
    const reqB = requirement({ id: "REQ-SECRET-B", testCaseId: "wake-word-addressed-only", requiredValidSessions: 1 });
    const reqC = requirement({ id: "REQ-SECRET-C", testCaseId: testCase.id, requiredValidSessions: 3 });
    const plan = run({
      id: "RUN-SECRET",
      build: "BUILD-SECRET-123",
      requirements: [reqA, reqB, reqC],
      assignments: [
        assignment({
          id: "ASSIGN-SECRET",
          requirementId: "REQ-SECRET-A",
          assignee: "kim",
          status: "in-progress",
          completedSessionIds: ["s1", "s2", "s3"]
        }),
        assignment({ id: "other-assign", requirementId: "REQ-SECRET-B", assignee: "alice", status: "pending" })
      ]
    });
    const data = adminData({ runs: [plan] });
    await act(async () => {
      renderer = create(
        <TestPlans
          user={authUser("tester", { username: "kim", id: "kim" })}
          agent={agent()}
          data={data}
          onOpenSessions={vi.fn()}
          onStartTesting={vi.fn()}
        />
      );
    });
    const planText = text(renderer!.root);
    expect(planText).toContain("2/2");
    // Only the tester's requirement survives; the other assignee's and the unassigned requirement are hidden.
    expect(renderer!.root.findAllByProps({ className: "testingPlanTask" })).toHaveLength(1);
    expect(planText).toContain("kim");
    expect(planText).not.toContain("alice");
    // No system identifiers or build metadata leak into the human plan.
    expect(planText).not.toContain("BUILD-SECRET-123");
    expect(planText).not.toContain("RUN-SECRET");
    expect(planText).not.toContain("REQ-SECRET-A");
    expect(planText).not.toContain("REQ-SECRET-B");
    expect(planText).not.toContain("ASSIGN-SECRET");
  });

  it("omits unassigned requirements for non-tester roles too", async () => {
    const reqA = requirement({ id: "req-a", testCaseId: "emergency-safe-guidance", requiredValidSessions: 2 });
    const reqC = requirement({ id: "req-c", testCaseId: testCase.id, requiredValidSessions: 3 });
    const plan = run({
      requirements: [reqA, reqC],
      assignments: [assignment({ id: "assign-a", requirementId: "req-a", assignee: "alice", status: "pending" })]
    });
    const data = adminData({ operations: operations([plan]) });
    await act(async () => {
      renderer = create(
        <TestPlans
          user={authUser("reviewer")}
          agent={agent()}
          data={data}
          onOpenSessions={vi.fn()}
          onStartTesting={vi.fn()}
        />
      );
    });
    const planText = text(renderer!.root);
    expect(renderer!.root.findAllByProps({ className: "testingPlanTask" })).toHaveLength(1);
    // The denominator counts only the assigned requirement, not the unassigned one.
    expect(planText).toContain("0/2");
    expect(planText).not.toContain("0/3");
  });

  it.each(["active", "blocked"] as const)(
    "offers compatible browser tasks for a %s plan and guides native-device users",
    async (status) => {
      const reqA = requirement({ id: "req-a", testCaseId: "emergency-safe-guidance", requiredValidSessions: 1 });
      const plan = run({
        status,
        requirements: [reqA],
        assignments: [
          assignment({ id: "a-web", requirementId: "req-a", assignee: "kim", platform: "web", status: "pending" }),
          assignment({
            id: "a-helmet",
            requirementId: "req-a",
            assignee: "kim",
            platform: "embedded",
            status: "pending"
          })
        ]
      });
      const data = adminData({ runs: [plan] });
      await act(async () => {
        renderer = create(
          <TestPlans
            user={authUser("tester", { username: "kim", id: "kim" })}
            agent={agent()}
            data={data}
            onOpenSessions={vi.fn()}
            onStartTesting={vi.fn()}
          />
        );
      });
      expect(renderer!.root.findAllByProps({ className: "testingAssigneeStart" })).toHaveLength(1);
      expect(text(renderer!.root)).toContain("头盔");
    }
  );
});

describe("OperationsWorkspace", () => {
  it("renders a tester's forged administration accounts URL as the testing workspace without admin controls", async () => {
    locationStub = stubBrowserLocation("#/admin/accounts");
    vi.mocked(useAdminTestingData).mockReturnValue(adminData());
    await act(async () => {
      renderer = create(
        <OperationsWorkspace
          agent={agent()}
          user={authUser("tester", { username: "kim" })}
          onAuthenticationExpired={vi.fn()}
          onClose={vi.fn(() => true)}
        />
      );
    });
    await flush();
    const root = renderer!.root;
    expect(navTargets(root)).toEqual(["#/testing/overview", "#/testing/plans", "#/testing/evidence"]);
    expect(root.findAllByType("a").some((link) => String(link.props.href).startsWith("#/admin/"))).toBe(false);
    expect(locationStub.hash()).toBe("#/testing/overview");
  });

  it("redirects a tester's forged advanced diagnostics URL without exposing technical tools", async () => {
    locationStub = stubBrowserLocation("#/testing/diagnostics?tab=diagnostics");
    vi.mocked(useAdminTestingData).mockReturnValue(adminData());
    await act(async () => {
      renderer = create(
        <OperationsWorkspace
          agent={agent()}
          user={authUser("tester", { username: "kim" })}
          onAuthenticationExpired={vi.fn()}
          onClose={vi.fn(() => true)}
        />
      );
    });
    await flush();
    const root = renderer!.root;
    expect(navTargets(root)).toEqual(["#/testing/overview", "#/testing/plans", "#/testing/evidence"]);
    expect(root.findAllByType("a").some((link) => String(link.props.href).startsWith("#/admin/"))).toBe(false);
    expect(locationStub.hash()).toBe("#/testing/overview");
  });

  it("switches an administrator between distinct navigation and profile tools", async () => {
    locationStub = stubBrowserLocation("#/testing/overview");
    vi.mocked(useAdminTestingData).mockReturnValue(adminData({ operations: operations() }));
    await act(async () => {
      renderer = create(
        <OperationsWorkspace
          agent={agent()}
          user={authUser("admin")}
          onAuthenticationExpired={vi.fn()}
          onClose={vi.fn(() => true)}
        />
      );
    });
    await flush();
    const root = () => renderer!.root;
    expect(navTargets(root())).toEqual(QA_TESTING_NAV);
    expect(root().findAll((node) => node.type === "button" && text(node).startsWith("复制令牌"))).toHaveLength(0);

    await act(async () => root().findAllByProps({ className: "workspaceSwitch" })[0].props.onClick(plainClick));
    expect(locationStub.hash()).toBe("#/admin/overview");
    expect(navTargets(root())).toEqual(["#/admin/overview", "#/admin/studio", "#/admin/accounts", "#/admin/audit"]);
    expect(root().findAll((node) => node.type === "button" && text(node).startsWith("复制令牌"))).toHaveLength(1);

    await act(async () => root().findAllByProps({ className: "workspaceSwitch" })[0].props.onClick(plainClick));
    expect(locationStub.hash()).toBe("#/testing/overview");
    expect(navTargets(root())).toEqual(QA_TESTING_NAV);
    expect(root().findAll((node) => node.type === "button" && text(node).startsWith("复制令牌"))).toHaveLength(0);
  });

  it("gives a reviewer QA management in Testing but no Administration access", async () => {
    locationStub = stubBrowserLocation("#/admin/overview");
    vi.mocked(useAdminTestingData).mockReturnValue(adminData({ operations: operations() }));
    await act(async () => {
      renderer = create(
        <OperationsWorkspace
          agent={agent()}
          user={authUser("reviewer")}
          onAuthenticationExpired={vi.fn()}
          onClose={vi.fn(() => true)}
        />
      );
    });
    await flush();
    const root = renderer!.root;
    expect(navTargets(root)).toEqual(QA_TESTING_NAV);
    expect(locationStub.hash()).toBe("#/testing/overview");
    expect(root.findAllByProps({ className: "workspaceSwitch" })).toHaveLength(0);
    // Token copy is self-service: reviewers keep it in Testing even without an
    // Administration entry.
    expect(root.findAll((node) => node.type === "button" && text(node).startsWith("复制令牌"))).toHaveLength(1);
  });

  it("does not rewrite a navigation that leaves both workspaces", async () => {
    locationStub = stubBrowserLocation("#/admin/overview");
    vi.mocked(useAdminTestingData).mockReturnValue(adminData({ operations: operations() }));
    await act(async () => {
      renderer = create(
        <OperationsWorkspace
          agent={agent()}
          user={authUser("admin")}
          onAuthenticationExpired={vi.fn()}
          onClose={vi.fn(() => true)}
        />
      );
    });
    await act(async () => leaveWorkspaceLocation());
    await flush();
    expect(locationStub.hash()).toBe("");
  });
});
