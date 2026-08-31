import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TesterSessionSummary } from "../shared/agent";
import { normalizeTestingBuildIdentity, testingBuildsMatch } from "../shared/testing";
import {
  createTestingAssignment,
  createTestingPolicy,
  countUnresolvedTestingReviewsForRun,
  createTestingRun,
  deleteStoredTestingSession,
  evidenceHash,
  getActiveTestingPolicy,
  getApprovedBaselineBuild,
  getTestingRun,
  listTestingAudit,
  listTestingPolicies,
  listTestingReviews,
  loadTestingSessionsExcludingBuild,
  loadTestingSessionsForBuild,
  resetTestingStore,
  saveTestingSession,
  storedTestingSessionPage,
  updateTestingAssignment,
  updateTestingRun,
  upsertTestingReview
} from "../server/testing-store";

function sessionEvidence(
  sessionId: string,
  runId: string,
  assignmentId: string,
  overrides: Partial<TesterSessionSummary> = {}
): TesterSessionSummary {
  const evaluation = {
    testCaseId: "baseline-live-session",
    testCaseName: "Baseline Live Session",
    score: 100,
    quality: "pass" as const,
    checks: [{ id: "safe", label: "Safe response", status: "pass" as const, detail: "Passed." }]
  };
  const validity = { status: "valid" as const, reasons: [], detail: "Valid release evidence." };
  const base: Omit<TesterSessionSummary, "evidenceHash"> = {
    sessionId,
    testerKey: "rider@203.0.113.8",
    testerId: "rider",
    ipAddress: "203.0.113.8",
    region: "Asia/Shanghai",
    campaignId: "release-readiness",
    campaignName: "Release Readiness",
    testCaseId: "baseline-live-session",
    testCaseName: "Baseline Live Session",
    appVersion: "1.0.0",
    gitCommit: "candidate-build",
    deviceLabel: "test browser",
    browserLanguage: "en-US",
    networkType: "wifi",
    platform: "web",
    runId,
    assignmentId,
    startedAt: 1_000,
    endedAt: 5_000,
    durationMs: 4_000,
    audioUpBytes: 640,
    audioDownBytes: 960,
    controlDownBytes: 120,
    micFrames: 2,
    serverEvents: 3,
    latencySamples: 1,
    avgLatencyMs: 120,
    p95LatencyMs: 120,
    errorEvents: 0,
    ttsFallbacks: 0,
    quality: "pass",
    validity,
    flags: [],
    notes: "",
    policyVersion: getActiveTestingPolicy().version,
    evidenceIntegrity: "verified",
    capturedEvaluation: evaluation,
    capturedValidity: validity,
    audioQuality: { droppedFrames: 0, outgoingFps: 50, jitterMs: 0.2, clippingPct: 0, silencePct: 10 },
    evaluation,
    turns: [
      { sessionId, at: 2_000, speaker: "rider", text: "Max, route status?", final: true },
      { sessionId, at: 2_500, speaker: "agent", text: "Route clear. Ride safely.", final: true }
    ],
    ...overrides
  };
  return { ...base, evidenceHash: evidenceHash(base) };
}

beforeEach(() => resetTestingStore());
afterEach(() => resetTestingStore());

describe("testing operations store", () => {
  it("uses one build identity while retaining historical Git SHA compatibility", () => {
    expect(normalizeTestingBuildIdentity("ABCDEF0123456789ABCDEF0123456789ABCDEF01")).toBe("abcdef012345");
    expect(testingBuildsMatch("abcdef0", "abcdef012345")).toBe(true);
    expect(testingBuildsMatch("abcdef012345", "abcdef0123456789abcdef0123456789abcdef01")).toBe(true);
    expect(testingBuildsMatch("abcdef0", "1234567")).toBe(false);

    const run = createTestingRun({ build: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" }, "lead", "current");
    expect(run.build).toBe("abcdef012345");

    saveTestingSession(sessionEvidence("legacy-short-sha", run.id, "assignment", { gitCommit: "abcdef0" }));
    saveTestingSession(
      sessionEvidence("legacy-full-sha", run.id, "assignment", {
        gitCommit: "abcdef0123456789abcdef0123456789abcdef01"
      })
    );
    saveTestingSession(sessionEvidence("different-sha", run.id, "assignment", { gitCommit: "123456789abc" }));

    expect(loadTestingSessionsForBuild(run.build).map((session) => session.sessionId)).toEqual([
      "legacy-short-sha",
      "legacy-full-sha"
    ]);
    expect(loadTestingSessionsExcludingBuild(run.build).map((session) => session.sessionId)).toEqual(["different-sha"]);
    expect(storedTestingSessionPage({ build: run.build }).items.map((session) => session.sessionId)).toEqual([
      "legacy-short-sha",
      "legacy-full-sha"
    ]);
  });

  it("credits and displays on re-evaluated validity, not the capture-time payload", () => {
    const run = createTestingRun({ name: "Candidate", build: "candidate-build", owner: "lead" }, "lead", "current");
    const requirement = run.requirements.find((item) => item.id === "baseline-live-session:web");
    if (!requirement) return;
    const assigned = createTestingAssignment(run.id, { requirementId: requirement.id, assignee: "rider" }, "lead");
    const assignment = assigned?.assignments[0];
    if (!assignment) return;

    // The stored payload CLAIMS valid/pass, but its (empty) transcript would
    // re-evaluate as invalid/fail under the current catalog — as if it were
    // captured under an older, looser policy.
    saveTestingSession(
      sessionEvidence("stale-valid", run.id, assignment.id, {
        turns: [],
        micFrames: 0,
        quality: "pass",
        validity: { status: "valid", reasons: [], detail: "Valid release evidence." },
        capturedValidity: { status: "valid", reasons: [], detail: "Valid release evidence." }
      })
    );

    // Not credited: re-evaluated validity is invalid, matching the release gate.
    expect(getTestingRun(run.id)?.assignments[0].completedSessionIds).toEqual([]);

    // The durable page shows the re-evaluated classification, not the stale payload…
    const shown = storedTestingSessionPage({ testCaseId: "baseline-live-session" }).items.find(
      (session) => session.sessionId === "stale-valid"
    );
    expect(shown?.validity.status).toBe("invalid");
    expect(shown?.quality).toBe("fail");
    // …while the capture-time snapshot stays available for the audit trail.
    expect(shown?.capturedValidity.status).toBe("valid");
  });

  it("filters and counts the evidence page by re-derived quality, not the capture-time value", () => {
    // Re-derives to "pass" (full transcript, mic audio, low latency) but was
    // frozen as "fail" — as if captured under a stricter policy since relaxed.
    saveTestingSession(sessionEvidence("fresh-pass", "", "", { endedAt: 3_000, quality: "fail" }));
    // Frozen as "pass" but re-derives to "fail": empty transcript, no mic audio.
    saveTestingSession(
      sessionEvidence("stale-fail", "", "", { endedAt: 2_000, turns: [], micFrames: 0, quality: "pass" })
    );

    // The filter must honor the re-derived classification shown for each row, not
    // the stale payload column — otherwise ?quality=pass would hide fresh-pass
    // (stored "fail") and surface stale-fail (stored "pass", renders "fail").
    const pass = storedTestingSessionPage({ quality: "pass" });
    expect(pass.items.map((session) => session.sessionId)).toEqual(["fresh-pass"]);
    expect(pass.items[0]?.quality).toBe("pass");
    expect(pass.total).toBe(1);

    const fail = storedTestingSessionPage({ quality: "fail" });
    expect(fail.items.map((session) => session.sessionId)).toEqual(["stale-fail"]);
    expect(fail.items[0]?.quality).toBe("fail");
    expect(fail.total).toBe(1);
  });

  it("paginates the quality-filtered evidence page with a cursor", () => {
    for (const [sessionId, endedAt] of [
      ["fail-a", 3_000],
      ["fail-b", 2_000],
      ["fail-c", 1_000]
    ] as const) {
      saveTestingSession(sessionEvidence(sessionId, "", "", { endedAt, turns: [], micFrames: 0 }));
    }

    const first = storedTestingSessionPage({ quality: "fail", limit: 2 });
    expect(first.items.map((session) => session.sessionId)).toEqual(["fail-a", "fail-b"]);
    expect(first.total).toBe(3);
    expect(first.nextCursor).toBeDefined();

    const second = storedTestingSessionPage({ quality: "fail", limit: 2, cursor: first.nextCursor });
    expect(second.items.map((session) => session.sessionId)).toEqual(["fail-c"]);
    expect(second.total).toBe(3);
    expect(second.nextCursor).toBeUndefined();
  });

  it("only credits matching decision-grade evidence to an assignment", () => {
    const active = getActiveTestingPolicy();
    createTestingPolicy(
      { version: "two-per-platform", release: { ...active.release, minStandardSessions: 6 } },
      "lead",
      500
    );
    const run = createTestingRun({ name: "Candidate", build: "candidate-build", owner: "lead" }, "lead", "current");
    const requirement = run.requirements.find((item) => item.id === "baseline-live-session:web");
    expect(requirement?.requiredValidSessions).toBe(2);
    if (!requirement) return;
    const assigned = createTestingAssignment(run.id, { requirementId: requirement.id, assignee: "rider" }, "lead");
    const assignment = assigned?.assignments[0];
    expect(assignment).toBeDefined();
    if (!assignment) return;

    saveTestingSession(sessionEvidence("wrong-build", run.id, assignment.id, { gitCommit: "other-build" }));
    expect(getTestingRun(run.id)?.assignments[0].completedSessionIds).toEqual([]);

    saveTestingSession(sessionEvidence("matching-one", run.id, assignment.id));
    expect(getTestingRun(run.id)?.assignments[0]).toMatchObject({
      status: "in-progress",
      completedSessionIds: ["matching-one"]
    });

    saveTestingSession(sessionEvidence("matching-two", run.id, assignment.id));
    expect(getTestingRun(run.id)?.assignments[0]).toMatchObject({
      status: "complete",
      completedSessionIds: ["matching-one", "matching-two"]
    });
    expect(listTestingAudit().filter((event) => event.action === "assignment.evidence-credited")).toHaveLength(2);
    expect(
      updateTestingAssignment(run.id, assignment.id, { assignee: "next-rider" }, "lead")?.assignments[0]
    ).toMatchObject({ assignee: "next-rider", status: "pending", completedSessionIds: [] });
  });

  it("keeps captured evidence hashes stable across mutable review fields", () => {
    const run = createTestingRun({ build: "candidate-build" }, "lead", "current");
    const original = sessionEvidence("hash-check", run.id, "assignment");
    const withNotes = { ...original, notes: "Reviewer annotation", quality: "watch" as const };
    expect(evidenceHash(withNotes)).toBe(original.evidenceHash);
    expect(evidenceHash({ ...original, campaignName: "Renamed Campaign", testCaseName: "Renamed Case" })).toBe(
      original.evidenceHash
    );
    expect(evidenceHash({ ...original, capturedEvaluation: { ...original.capturedEvaluation, score: 10 } })).not.toBe(
      original.evidenceHash
    );
  });

  it("versions bounded policies and retains review/audit history", () => {
    const active = getActiveTestingPolicy();
    const policy = createTestingPolicy(
      {
        version: "qa-policy",
        description: "Tightened release threshold",
        release: { ...active.release, maxP95LatencyMs: -10, minSafetyCriticalSessions: 0 },
        regression: { ...active.regression, latencyWatchDeltaMs: 300, latencyFailDeltaMs: 100 }
      },
      "admin",
      10_000
    );
    expect(policy.release.maxP95LatencyMs).toBe(50);
    expect(policy.release.minSafetyCriticalSessions).toBe(1);
    expect(policy.regression.latencyFailDeltaMs).toBe(300);
    expect(listTestingPolicies().filter((item) => item.active)).toEqual([
      expect.objectContaining({ version: policy.version })
    ]);

    const review = upsertTestingReview(
      { sessionId: "evidence-1", severity: "critical", title: "Unsafe reply", owner: "reviewer" },
      "reviewer",
      11_000
    );
    expect(review?.status).toBe("open");
    expect(listTestingReviews()).toContainEqual(expect.objectContaining({ sessionId: "evidence-1" }));
    expect(listTestingAudit().map((event) => event.action)).toEqual(
      expect.arrayContaining(["policy.created", "review.created"])
    );
  });

  it("applies policy platforms and immutable case minimums to new runs", () => {
    const active = getActiveTestingPolicy();
    createTestingPolicy(
      {
        version: "web-only",
        release: {
          ...active.release,
          requiredPlatforms: ["web"],
          minStandardSessions: 1,
          minSafetyCriticalSessions: 1
        }
      },
      "admin",
      20_000
    );
    const run = createTestingRun({ build: "candidate-build" }, "admin", "current");
    expect(run.requirements).toHaveLength(6);
    expect(run.requirements.every((requirement) => requirement.platform === "web")).toBe(true);
    expect(run.requirements.find((requirement) => requirement.testCaseId === "baseline-live-session")).toMatchObject({
      requiredValidSessions: 2
    });
    expect(run.requirements.find((requirement) => requirement.testCaseId === "emergency-safe-guidance")).toMatchObject({
      requiredValidSessions: 3
    });
  });

  it("does not reapprove or mutate assignments on a completed release run", () => {
    const run = createTestingRun({ build: "approved-build" }, "admin", "current", 40_000);
    const approved = updateTestingRun(run.id, { status: "approved" }, "admin", 41_000);
    expect(approved?.approvedAt).toBe(41_000);
    const annotated = updateTestingRun(run.id, { notes: "Post-release record" }, "admin", 42_000);
    expect(annotated?.approvedAt).toBe(41_000);
    expect(listTestingAudit().filter((event) => event.action === "baseline.approved")).toHaveLength(1);
    expect(
      createTestingAssignment(run.id, { requirementId: run.requirements[0].id, assignee: "rider" }, "admin")
    ).toBeNull();
  });

  it("revokes assignment credit and an invalidated baseline when evidence is deleted", () => {
    const run = createTestingRun({ build: "deletion-build" }, "admin", "current", 50_000);
    const requirement = run.requirements.find((item) => item.id === "baseline-live-session:web");
    expect(requirement).toBeTruthy();
    if (!requirement) return;
    const assigned = createTestingAssignment(run.id, { requirementId: requirement.id, assignee: "rider" }, "admin");
    const assignment = assigned?.assignments[0];
    expect(assignment).toBeTruthy();
    if (!assignment) return;
    saveTestingSession(sessionEvidence("deletable-evidence", run.id, assignment.id, { gitCommit: "deletion-build" }));
    expect(getTestingRun(run.id)?.assignments[0].completedSessionIds).toEqual(["deletable-evidence"]);

    updateTestingRun(run.id, { status: "approved" }, "admin", 51_000);
    expect(getApprovedBaselineBuild()).toBe("deletion-build");
    expect(deleteStoredTestingSession("deletable-evidence")).toBe(1);
    expect(getTestingRun(run.id)).toMatchObject({
      status: "blocked",
      assignments: [expect.objectContaining({ status: "pending", completedSessionIds: [] })]
    });
    expect(getApprovedBaselineBuild()).toBeUndefined();
  });

  it("pages indexed evidence safely and starts a fresh issue after waiver", () => {
    const first = sessionEvidence("indexed-first", "run", "assignment", { testerId: "alice" });
    const second = sessionEvidence("indexed-second", "run", "assignment", {
      testerId: "bob",
      quality: "watch"
    });
    saveTestingSession(first);
    saveTestingSession(second);

    expect(storedTestingSessionPage({ limit: Number.NaN, search: "indexed-first" })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ sessionId: "indexed-first" })]
    });
    expect(storedTestingSessionPage({}, "alice").items.map((session) => session.sessionId)).toEqual(["indexed-first"]);

    const original = upsertTestingReview({ sessionId: first.sessionId, title: "Investigate" }, "reviewer", 30_000);
    expect(original).toBeTruthy();
    if (!original) return;
    upsertTestingReview({ ...original, status: "waived", resolution: "Accepted for this run" }, "lead", 31_000);
    const reopened = upsertTestingReview({ sessionId: first.sessionId, title: "New occurrence" }, "reviewer", 32_000);
    expect(reopened?.id).not.toBe(original.id);
    expect(reopened?.status).toBe("open");
  });

  it("updates an existing buried review in place without changing its authoritative attribution", () => {
    // An open review created first, then buried under >500 newer reviews so it
    // falls outside listTestingReviews' capped scan.
    const target = upsertTestingReview(
      { sessionId: "buried-session", runId: "original-run", title: "Investigate" },
      "reviewer",
      1_000
    );
    expect(target).toBeTruthy();
    if (!target) return;
    for (let i = 0; i < 600; i += 1) {
      upsertTestingReview({ sessionId: `filler-${i}`, title: "Filler" }, "reviewer", 2_000 + i);
    }

    // Update by id must patch the buried review in place, not mint a duplicate
    // or let a client move its evidence attribution to another session/run.
    const updated = upsertTestingReview(
      {
        id: target.id,
        sessionId: "unrelated-session",
        runId: "unrelated-run",
        status: "resolved",
        resolution: "Fixed"
      },
      "lead",
      700_000
    );
    expect(updated?.id).toBe(target.id);
    expect(updated?.status).toBe("resolved");
    expect(updated).toMatchObject({ sessionId: "buried-session", runId: "original-run" });
    const forSession = listTestingReviews(1_000).filter((review) => review.sessionId === "buried-session");
    expect(forSession).toHaveLength(1);
  });

  it("counts unresolved reviews for a run even when newer unrelated reviews exceed the recent list cap", () => {
    const run = createTestingRun({ build: "candidate-build" }, "admin", "current", 1_000);
    upsertTestingReview({ sessionId: "target-session", runId: run.id, title: "Must resolve" }, "reviewer", 1_001);
    for (let index = 0; index < 600; index += 1) {
      upsertTestingReview(
        { sessionId: `other-${index}`, runId: `other-run-${index}`, title: "Unrelated" },
        "reviewer",
        2_000 + index
      );
    }

    // Release approval must not decide from the capped recent-review feed.
    expect(countUnresolvedTestingReviewsForRun(run.id)).toBe(1);
  });
});
