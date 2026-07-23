import { describe, expect, it } from "vitest";
import type { TesterSessionSummary, TesterStats } from "../shared/agent";
import {
  allowedAdminSections,
  adminRoleLabel,
  adminStatusAfterFailure,
  confirmationCopy,
  corpusIssueCount,
  mergeAdminSessions,
  normalizeAdminSection,
  surfaceAfterAuthentication
} from "../src/components/admin/admin-model";

function tester(overrides: Partial<TesterStats> = {}): TesterStats {
  return {
    testerKey: "tester-key",
    testerId: "rider",
    ipAddress: "127.0.0.1",
    region: "local",
    activeSessions: 0,
    totalSessions: 0,
    totalSessionMs: 0,
    audioUpBytes: 0,
    audioDownBytes: 0,
    controlDownBytes: 0,
    micFrames: 0,
    serverEvents: 0,
    latencySamples: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    errorEvents: 0,
    ttsFallbacks: 0,
    qualityCounts: { pass: 0, watch: 0, fail: 0 },
    lastSeenAt: 0,
    recentTurns: [],
    ...overrides
  };
}

function session(sessionId: string, endedAt: number): TesterSessionSummary {
  return {
    sessionId,
    testerKey: "tester-key",
    testerId: "rider",
    ipAddress: "127.0.0.1",
    region: "local",
    campaignId: "campaign",
    campaignName: "Campaign",
    testCaseId: "case",
    testCaseName: "Case",
    appVersion: "0.1.0",
    gitCommit: "local",
    deviceLabel: "browser",
    browserLanguage: "zh-CN",
    networkType: "wifi",
    platform: "web",
    startedAt: endedAt - 1_000,
    endedAt,
    durationMs: 1_000,
    audioUpBytes: 0,
    audioDownBytes: 0,
    controlDownBytes: 0,
    micFrames: 0,
    serverEvents: 0,
    latencySamples: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    errorEvents: 0,
    ttsFallbacks: 0,
    quality: "pass",
    validity: { status: "valid", detail: "", reasons: [] },
    flags: [],
    notes: "",
    policyVersion: "policy-v1",
    evidenceHash: "digest",
    evidenceIntegrity: "verified",
    capturedEvaluation: { testCaseId: "case", testCaseName: "Case", score: 100, quality: "pass", checks: [] },
    capturedValidity: { status: "valid", detail: "", reasons: [] },
    audioQuality: { droppedFrames: 0, outgoingFps: 0, jitterMs: 0, clippingPct: 0, silencePct: 0 },
    evaluation: { testCaseId: "case", testCaseName: "Case", score: 100, quality: "pass", checks: [] },
    turns: []
  };
}

describe("Admin navigation permissions", () => {
  it("shows only role-authorized workspace sections", () => {
    expect(allowedAdminSections("tester")).toEqual(["overview", "releases", "evidence"]);
    expect(allowedAdminSections("reviewer")).toEqual(["overview", "releases", "evidence", "governance"]);
    expect(allowedAdminSections("admin")).toEqual(["overview", "releases", "evidence", "accounts", "governance"]);
    expect(normalizeAdminSection("accounts", "reviewer")).toBe("overview");
  });

  it("returns to the login flow when authentication is lost", () => {
    expect(surfaceAfterAuthentication("admin", false)).toBe("voice");
    expect(surfaceAfterAuthentication("admin", true)).toBe("admin");
  });

  it("keeps authenticated workspace surfaces explicit", () => {
    expect(surfaceAfterAuthentication("settings", true)).toBe("settings");
    expect(surfaceAfterAuthentication("admin", true)).toBe("admin");
    expect(surfaceAfterAuthentication("settings", false)).toBe("voice");
  });
});

describe("Admin derived data", () => {
  it("distinguishes an empty load failure from stale previously loaded data", () => {
    expect(adminStatusAfterFailure(false)).toBe("error");
    expect(adminStatusAfterFailure(true)).toBe("stale");
  });

  it("counts issues across the full server aggregate instead of the loaded page", () => {
    expect(
      corpusIssueCount([
        tester({ qualityCounts: { pass: 120, watch: 4, fail: 2 } }),
        tester({ testerKey: "second", qualityCounts: { pass: 80, watch: 3, fail: 1 } })
      ])
    ).toBe(10);
  });

  it("keeps an externally selected detail through the next first-page refresh", () => {
    const external = session("external", 30);
    const merged = mergeAdminSessions([external, session("old", 10)], [session("new", 40), session("old", 50)]);

    expect(merged.map((item) => [item.sessionId, item.endedAt])).toEqual([
      ["old", 50],
      ["new", 40],
      ["external", 30]
    ]);
  });

  it("uses Chinese role and target-specific confirmation copy", () => {
    expect(adminRoleLabel("reviewer")).toBe("审核员");
    expect(confirmationCopy("user", "@alice")).toContain("@alice");
    expect(confirmationCopy("all-evidence", "全部测试证据")).toContain("全部测试证据");
  });
});
