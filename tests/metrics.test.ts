import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInfo } from "../server/build-info";
import { buildHealth } from "../server/config";
import {
  METRICS_WINDOW_MINUTES,
  beginTesterSession,
  clearAllTesterData,
  clearTesterData,
  clearTestingSession,
  endTesterSession,
  metrics,
  metricsWindow,
  recordMetricsSnapshot,
  recordTesterClientAudio,
  recordTesterAudioQuality,
  recordTesterServerAudio,
  recordTesterServerEvent,
  recordTesterTtsFallback,
  recordTesterTurnFeedback,
  testingSessionDetail,
  testingSessionPage,
  testingSnapshot,
  updateTestingSessionNotes
} from "../server/metrics";
import { DEFAULT_TESTING_POLICY, TESTING_TEST_CASES, type TestingPlatform } from "../shared/testing";
import { createTestingPolicy, getActiveTestingPolicy } from "../server/testing-store";
import * as testingStore from "../server/testing-store";

afterEach(() => {
  vi.restoreAllMocks();
  metrics.reset();
});

function seedValidCompletedSession(
  sessionId: string,
  testCaseId: string,
  gitCommit = buildInfo.gitCommit,
  p95LatencyMs = 180,
  platform: TestingPlatform = "web"
) {
  const agentText: Record<string, string> = {
    "baseline-live-session": "Route looks clear. Keep your eyes on the road and ride safely.",
    "wake-word-addressed-only": "Weather is clear. Keep your eyes on the road and ride safely.",
    "emergency-safe-guidance": "Slow down and pull over safely when you can.",
    "adas-alert-interrupt": "Blind spot alert on your left. Vehicle approaching. Hold your lane.",
    "wind-noise-robustness": "Wind noise is high. I heard you. Repeat only when safe.",
    "degraded-network-recovery": "Network is degraded but connected. I will retry briefly and keep guidance short."
  };
  beginTesterSession(
    sessionId,
    {
      testerId: `qa-${testCaseId}`,
      ipAddress: `203.0.113.${Math.max(1, sessionId.length % 240)}`,
      testingTestCaseId: testCaseId,
      gitCommit,
      deviceLabel: "test browser",
      networkType:
        testCaseId === "degraded-network-recovery"
          ? "degraded"
          : testCaseId === "wind-noise-robustness"
            ? "field"
            : "wifi",
      platform
    },
    1_000
  );
  if (testCaseId !== "adas-alert-interrupt") {
    recordTesterClientAudio(sessionId, 320, 1_100);
    recordTesterServerEvent(sessionId, { type: "transcript", speaker: "rider", text: "Max, run the test." }, 64, 1_150);
  }
  recordTesterServerEvent(sessionId, { type: "metric", latencyMs: p95LatencyMs }, 32, 1_200);
  recordTesterServerEvent(
    sessionId,
    { type: "transcript", speaker: "agent", text: agentText[testCaseId] ?? agentText["baseline-live-session"] },
    96,
    1_260
  );
  endTesterSession(sessionId, 4_000);
}

describe("relay metrics", () => {
  it("tracks the session lifecycle without going negative", () => {
    metrics.sessionOpened();
    metrics.sessionOpened();
    metrics.sessionClosed();
    expect(metrics.snapshot()).toMatchObject({ activeSessions: 1, totalSessions: 2 });

    metrics.sessionClosed();
    metrics.sessionClosed(); // stray extra close must not underflow
    expect(metrics.snapshot().activeSessions).toBe(0);
  });

  it("accumulates upstream, fallback, and watchdog counters", () => {
    metrics.rejectedUpgrade();
    metrics.upstreamFailure();
    metrics.upstreamReconnect();
    metrics.ttsFallback();
    metrics.watchdogSweep(2, 1);
    metrics.clientAudio(320);
    metrics.serverAudio(640);
    metrics.serverEvent(120);

    expect(metrics.snapshot()).toMatchObject({
      rejectedUpgrades: 1,
      upstreamFailures: 1,
      upstreamReconnects: 1,
      ttsFallbacks: 1,
      watchdogTerminations: 2,
      watchdogIdleCloses: 1,
      audioUpBytes: 320,
      audioDownBytes: 640,
      controlDownBytes: 120
    });
  });

  it("exposes a snapshot on /health that later mutations cannot alter", () => {
    metrics.sessionOpened();
    const health = buildHealth(42);
    expect(health.metrics).toMatchObject({ activeSessions: 1, totalSessions: 1 });

    metrics.sessionOpened();
    expect(health.metrics?.activeSessions).toBe(1); // snapshot, not a live view
  });

  it("reports trailing-window deltas, not lifetime totals", () => {
    const start = 1_000_000;
    // Old activity, snapshotted well before the window.
    metrics.sessionOpened();
    metrics.upstreamFailure();
    recordMetricsSnapshot(start);

    // Fresh activity inside the window.
    const now = start + (METRICS_WINDOW_MINUTES + 5) * 60_000;
    recordMetricsSnapshot(now - METRICS_WINDOW_MINUTES * 60_000);
    metrics.sessionOpened();
    metrics.ttsFallback();

    const window = metricsWindow(now);
    expect(window.minutes).toBe(METRICS_WINDOW_MINUTES);
    expect(window.sessionsStarted).toBe(1); // not the lifetime 2
    expect(window.upstreamFailures).toBe(0); // happened before the window
    expect(window.ttsFallbacks).toBe(1);
  });

  it("falls back to since-startup deltas while younger than the window", () => {
    metrics.sessionOpened();
    const window = metricsWindow();
    expect(window.sessionsStarted).toBe(1);
    expect(window.minutes).toBeLessThanOrEqual(METRICS_WINDOW_MINUTES);
    expect(buildHealth(1).metricsWindow?.sessionsStarted).toBe(1);
  });

  it("tracks per-tester sessions, bandwidth, latency, and fallbacks", () => {
    beginTesterSession(
      "relay-1",
      {
        testerId: " rider one ",
        ipAddress: "::ffff:203.0.113.9",
        region: "Asia/Shanghai",
        testingCampaignId: "wake-word-regression",
        testingTestCaseId: "wake-word-addressed-only",
        appVersion: "1.2.3",
        gitCommit: "abc123",
        deviceLabel: "macOS browser",
        browserLanguage: "en-US",
        networkType: "4g"
      },
      1_000
    );
    recordTesterClientAudio("relay-1", 320, 1_100);
    recordTesterServerAudio("relay-1", 640, 1_200);
    recordTesterServerEvent("relay-1", { type: "metric", latencyMs: 123 }, 88, 1_300);
    recordTesterServerEvent("relay-1", { type: "transcript", speaker: "rider", text: " Max, weather? " }, 64, 1_350);
    recordTesterServerEvent("relay-1", { type: "error", message: "boom" }, 42, 1_400);
    recordTesterTtsFallback("relay-1", 1_500);
    endTesterSession("relay-1", 61_000);

    const snapshot = testingSnapshot(61_000);
    expect(snapshot.history).toMatchObject({
      persistent: false,
      maxTranscriptTurnsPerTester: 80,
      maxTranscriptTurnsPerSession: 120
    });
    expect(snapshot.catalog.testCases.some((testCase) => testCase.id === "wake-word-addressed-only")).toBe(true);
    expect(snapshot.totals).toMatchObject({
      activeTestSessions: 0,
      totalTestSessions: 1,
      audioUpBytes: 320,
      audioDownBytes: 640,
      controlDownBytes: 194,
      avgLatencyMs: 123,
      p95LatencyMs: 123,
      errorEvents: 1,
      ttsFallbacks: 1
    });
    expect(snapshot.sessions[0]).toMatchObject({
      sessionId: "relay-1",
      testerKey: "rider one@203.0.113.9",
      testerId: "rider one",
      ipAddress: "203.0.113.9",
      region: "Asia/Shanghai",
      campaignId: "wake-word-regression",
      campaignName: "Wake Word Regression",
      testCaseId: "wake-word-addressed-only",
      testCaseName: "Wake Word Addressed Only",
      appVersion: "1.2.3",
      gitCommit: "abc123",
      deviceLabel: "macOS browser",
      browserLanguage: "en-US",
      networkType: "4g",
      startedAt: 1_000,
      endedAt: 61_000,
      durationMs: 60_000,
      audioUpBytes: 320,
      audioDownBytes: 640,
      controlDownBytes: 194,
      micFrames: 1,
      serverEvents: 3,
      latencySamples: 1,
      avgLatencyMs: 123,
      p95LatencyMs: 123,
      errorEvents: 1,
      ttsFallbacks: 1,
      quality: "fail",
      flags: expect.arrayContaining(["errors", "tts-fallback", "exchange-shape", "response-order"]),
      evaluation: {
        testCaseId: "wake-word-addressed-only",
        score: expect.any(Number),
        quality: "fail"
      },
      turns: [
        {
          sessionId: "relay-1",
          at: 1_350,
          speaker: "rider",
          text: "Max, weather?",
          final: true
        }
      ]
    });
    expect(snapshot.users[0]).toMatchObject({
      testerKey: "rider one@203.0.113.9",
      testerId: "rider one",
      ipAddress: "203.0.113.9",
      region: "Asia/Shanghai",
      totalSessions: 1,
      totalSessionMs: 60_000,
      micFrames: 1,
      serverEvents: 3,
      recentTurns: [
        {
          sessionId: "relay-1",
          at: 1_350,
          speaker: "rider",
          text: "Max, weather?",
          final: true
        }
      ]
    });
    expect(buildHealth(2, true).testing?.users[0]?.testerId).toBe("rider one");
  });

  it("omits the testing block from /health when the caller is not authorized", () => {
    beginTesterSession("relay-private", { testerId: "qa", ipAddress: "203.0.113.5" }, 1_000);
    const health = buildHealth(1, false);
    expect(health.testing).toBeUndefined();
    expect(health.metrics).toBeDefined(); // liveness data still present
    expect(buildHealth(1, true).testing?.users.length).toBe(1);
  });

  it("keeps accounting intact when more testers than MAX_TESTERS are active at once", () => {
    // Regression: creating tester #51 used to trim the just-created record
    // (the only inactive one), so its session leaked in the active map forever
    // and its completed summary was never written.
    const count = 51;
    for (let index = 0; index < count; index += 1) {
      beginTesterSession(
        `relay-bulk-${index}`,
        { testerId: `tester-${index}`, ipAddress: `198.51.100.${index}` },
        1_000 + index
      );
    }
    expect(testingSnapshot(2_000).totals.activeTestSessions).toBe(count);

    for (let index = 0; index < count; index += 1) {
      endTesterSession(`relay-bulk-${index}`, 60_000 + index);
    }
    const snapshot = testingSnapshot(70_000);
    expect(snapshot.totals.activeTestSessions).toBe(0);
    // Every session produced a completed summary — none were orphaned.
    expect(snapshot.sessions.length).toBe(count);
    const ids = new Set(snapshot.sessions.map((session) => session.sessionId));
    expect(ids.size).toBe(count);
  });

  it("falls back to an IP-scoped tester when no tester id is provided", () => {
    beginTesterSession("relay-2", { ipAddress: "10.0.0.4" }, 2_000);

    const user = testingSnapshot(2_500).users[0];
    expect(user).toMatchObject({
      testerKey: "ip:10.0.0.4@10.0.0.4",
      testerId: "ip:10.0.0.4",
      ipAddress: "10.0.0.4",
      region: "private network",
      activeSessions: 1
    });
  });

  it("captures audio quality, hash integrity, scoped paging, and mutable reviewer notes", () => {
    seedValidCompletedSession("evidence-a", "baseline-live-session", "evidence-build", 120);
    beginTesterSession(
      "evidence-b",
      {
        testerId: "scoped-rider",
        ipAddress: "203.0.113.55",
        testingTestCaseId: "baseline-live-session",
        gitCommit: "evidence-build",
        platform: "web"
      },
      5_000
    );
    recordTesterAudioQuality(
      "evidence-b",
      { droppedFrames: 3, outgoingFps: 49, jitterMs: 1.2, clippingPct: 0.5, silencePct: 18 },
      5_100
    );
    recordTesterAudioQuality(
      "evidence-b",
      { droppedFrames: 2, outgoingFps: 51, jitterMs: 1.8, clippingPct: 1.5, silencePct: 22 },
      5_150
    );
    recordTesterClientAudio("evidence-b", 320, 5_200);
    recordTesterServerEvent(
      "evidence-b",
      { type: "transcript", speaker: "rider", text: "Max, route status?" },
      64,
      5_300
    );
    recordTesterServerEvent(
      "evidence-b",
      { type: "transcript", speaker: "agent", text: "Route clear. Keep your eyes on the road." },
      64,
      5_400
    );
    endTesterSession("evidence-b", 9_000);

    const first = testingSessionPage({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0].turns).toEqual([]);
    expect(first.nextCursor).toBeDefined();
    const second = testingSessionPage({ limit: 1, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);

    const scoped = testingSessionPage({}, "scoped-rider");
    expect(scoped.items.map((session) => session.sessionId)).toEqual(["evidence-b"]);
    const detail = testingSessionDetail("evidence-b", "scoped-rider");
    expect(detail).toMatchObject({
      evidenceIntegrity: "verified",
      audioQuality: { droppedFrames: 3, outgoingFps: 50, jitterMs: 1.5, clippingPct: 1, silencePct: 20 }
    });
    expect(detail?.turns).toHaveLength(2);
    const originalHash = detail?.evidenceHash;
    const updated = updateTestingSessionNotes("evidence-b", "Investigated on device.");
    expect(updated?.notes).toBe("Investigated on device.");
    expect(updated?.evidenceHash).toBe(originalHash);
  });

  it("does not report a cached note update when the durable write fails", () => {
    seedValidCompletedSession("note-write-failure", "baseline-live-session");
    vi.spyOn(testingStore, "saveTestingSession").mockImplementation(() => {
      throw new Error("SQLite unavailable");
    });

    expect(() => updateTestingSessionNotes("note-write-failure", "This must not be reported as saved.")).toThrow(
      "SQLite unavailable"
    );
    expect(testingSessionDetail("note-write-failure")?.notes).toBe("");
  });

  it("classifies invalid sessions and excludes them from release-gate evidence", () => {
    beginTesterSession(
      "invalid-no-reply",
      { testerId: "invalid", ipAddress: "203.0.113.31", testingTestCaseId: "baseline-live-session" },
      1_000
    );
    recordTesterClientAudio("invalid-no-reply", 320, 1_100);
    recordTesterServerEvent(
      "invalid-no-reply",
      { type: "transcript", speaker: "rider", text: "Max, route status?" },
      64,
      1_200
    );
    endTesterSession("invalid-no-reply", 4_000);

    const snapshot = testingSnapshot(5_000);
    expect(snapshot.sessions[0].validity).toMatchObject({
      status: "invalid",
      reasons: expect.arrayContaining(["missing-agent-turn"])
    });
    expect(snapshot.totals).toMatchObject({ validTestSessions: 0, invalidTestSessions: 1 });
    expect(snapshot.releaseGate.status).toBe("fail");
    expect(snapshot.releaseGate.invalidSessions).toBe(1);
    expect(snapshot.releaseGate.validSessions).toBe(0);
  });

  it("passes the release gate when every required case has valid current-build evidence", () => {
    let expectedSessions = 0;
    for (const testCase of TESTING_TEST_CASES) {
      const required = Math.max(
        testCase.minimumValidSessions,
        testCase.risk === "safety-critical"
          ? DEFAULT_TESTING_POLICY.release.minSafetyCriticalSessions
          : DEFAULT_TESTING_POLICY.release.minStandardSessions
      );
      const samplesPerPlatform = Math.ceil(required / testCase.requiredPlatforms.length);
      for (const platform of testCase.requiredPlatforms) {
        for (let index = 0; index < samplesPerPlatform; index += 1) {
          seedValidCompletedSession(
            `gate-${testCase.id}-${platform}-${index}`,
            testCase.id,
            buildInfo.gitCommit,
            180,
            platform
          );
          expectedSessions += 1;
        }
      }
    }

    const gate = testingSnapshot(5_000).releaseGate;
    expect(gate.status).toBe("pass");
    expect(gate.validSessions).toBe(expectedSessions);
    expect(gate.invalidSessions).toBe(0);
    expect(gate.blockers).toEqual([]);
    expect(gate.cases.every((testCase) => testCase.status === "pass")).toBe(true);
  });

  it("uses the active policy platform set for release coverage", () => {
    const active = getActiveTestingPolicy();
    createTestingPolicy(
      { version: "web-candidate", release: { ...active.release, requiredPlatforms: ["web"] } },
      "admin",
      1_000
    );
    for (const testCase of TESTING_TEST_CASES) {
      const required = Math.max(
        testCase.minimumValidSessions,
        testCase.risk === "safety-critical"
          ? active.release.minSafetyCriticalSessions
          : active.release.minStandardSessions
      );
      for (let index = 0; index < required; index += 1) {
        seedValidCompletedSession(`web-policy-${testCase.id}-${index}`, testCase.id, buildInfo.gitCommit, 180, "web");
      }
    }

    const gate = testingSnapshot(5_000).releaseGate;
    expect(gate.status).toBe("pass");
    expect(gate.criteria.requiredPlatforms).toEqual(["web"]);
    expect(gate.cases.every((testCase) => testCase.cohorts.map((cohort) => cohort.platform).join() === "web")).toBe(
      true
    );
    expect(gate.cases.find((testCase) => testCase.testCaseId === "baseline-live-session")?.cohorts[0].required).toBe(2);
    expect(gate.cases.find((testCase) => testCase.testCaseId === "emergency-safe-guidance")?.cohorts[0].required).toBe(
      3
    );
  });

  it("reports regression when the current build drifts from the previous build", () => {
    seedValidCompletedSession("baseline-prev-1", "baseline-live-session", "previous-build", 100);
    seedValidCompletedSession("baseline-prev-2", "baseline-live-session", "previous-build", 100);
    seedValidCompletedSession("baseline-current-1", "baseline-live-session", buildInfo.gitCommit, 500);
    seedValidCompletedSession("baseline-current-2", "baseline-live-session", buildInfo.gitCommit, 500);

    const regression = testingSnapshot(5_000).regression;
    expect(regression.status).toBe("fail");
    expect(regression.baseline?.build).toBe("previous-build");
    expect(regression.deltas?.p95LatencyMs).toBe(400);
    expect(regression.findings).toContainEqual(
      expect.objectContaining({ id: expect.stringContaining("cohort-baseline-live-session"), status: "fail" })
    );
  });

  it("pools raw latency samples for the build p95 instead of collapsing to the worst session", () => {
    // Four clean sessions plus one whose only tail spike (1500ms) makes its OWN
    // per-session p95 = 1500. The old percentile-of-per-session-p95s surfaced
    // that 1500 as the whole build's p95; pooling the raw samples keeps it ~300.
    const seed = (id: string, latencies: number[]) => {
      beginTesterSession(
        id,
        {
          testerId: "qa-pool",
          ipAddress: "203.0.113.10",
          testingTestCaseId: "baseline-live-session",
          gitCommit: buildInfo.gitCommit,
          deviceLabel: "test browser",
          networkType: "wifi",
          platform: "web"
        },
        1_000
      );
      recordTesterClientAudio(id, 320, 1_100);
      recordTesterServerEvent(id, { type: "transcript", speaker: "rider", text: "Max, run the test." }, 64, 1_150);
      latencies.forEach((ms, index) =>
        recordTesterServerEvent(id, { type: "metric", latencyMs: ms }, 32, 1_200 + index)
      );
      recordTesterServerEvent(
        id,
        {
          type: "transcript",
          speaker: "agent",
          text: "Route looks clear. Keep your eyes on the road and ride safely."
        },
        96,
        1_400
      );
      endTesterSession(id, 4_000);
    };
    const clean = Array.from({ length: 10 }, () => 300);
    seed("pool-a", clean);
    seed("pool-b", clean);
    seed("pool-c", clean);
    seed("pool-d", clean);
    seed("pool-e", [...Array.from({ length: 9 }, () => 300), 1500]);

    // Pooled 95th percentile of 49×300 + 1×1500 is 300, not the spike session's 1500.
    expect(testingSnapshot(5_000).releaseGate.p95LatencyMs).toBe(300);
  });

  it("does not let a partial audio-quality update dilute omitted fields", () => {
    beginTesterSession(
      "aq-partial",
      {
        testerId: "qa-aq",
        ipAddress: "203.0.113.11",
        testingTestCaseId: "baseline-live-session",
        gitCommit: buildInfo.gitCommit,
        deviceLabel: "test browser",
        networkType: "wifi",
        platform: "web"
      },
      1_000
    );
    recordTesterClientAudio("aq-partial", 320, 1_050);
    recordTesterServerEvent("aq-partial", { type: "transcript", speaker: "rider", text: "Max, status?" }, 64, 1_080);
    recordTesterAudioQuality("aq-partial", { outgoingFps: 30 }, 1_100);
    recordTesterAudioQuality("aq-partial", { jitterMs: 5 }, 1_150); // no fps in this update
    recordTesterAudioQuality("aq-partial", { outgoingFps: 90 }, 1_200);
    recordTesterServerEvent(
      "aq-partial",
      { type: "transcript", speaker: "agent", text: "Route looks clear. Keep your eyes on the road and ride safely." },
      96,
      1_300
    );
    endTesterSession("aq-partial", 4_000);

    const audio = testingSnapshot(5_000).sessions.find((session) => session.sessionId === "aq-partial")?.audioQuality;
    // Mean of the two real fps samples (30, 90) is 60 — the jitter-only update
    // in between must not pull it toward its stale 30 (old shared-counter bug: 50).
    expect(audio?.outgoingFps).toBe(60);
    expect(audio?.jitterMs).toBe(5);
  });

  it("exposes per-tester quality counts aggregated server-side across all sessions", () => {
    // Two sessions for the same tester (same testerId + ip) plus one for another.
    seedValidCompletedSession("tq-1", "baseline-live-session");
    seedValidCompletedSession("tq-2", "baseline-live-session");
    seedValidCompletedSession("tq-3", "emergency-safe-guidance");

    const users = testingSnapshot(5_000).users;
    const baselineTester = users.find((user) => user.testerId === "qa-baseline-live-session");
    // Both baseline sessions graded pass — the count is a full server aggregate,
    // matching totalSessions rather than whatever page the client happened to load.
    expect(baselineTester?.qualityCounts).toEqual({ pass: 2, watch: 0, fail: 0 });
    expect(baselineTester?.totalSessions).toBe(2);
    const emergencyTester = users.find((user) => user.testerId === "qa-emergency-safe-guidance");
    expect(emergencyTester?.qualityCounts.pass).toBe(1);
  });

  it("does not silently pass a current cohort that lacks matched baseline evidence", () => {
    seedValidCompletedSession("cohort-prev-1", "baseline-live-session", "cohort-previous", 100, "web");
    seedValidCompletedSession("cohort-prev-2", "baseline-live-session", "cohort-previous", 100, "web");
    seedValidCompletedSession("cohort-current-web-1", "baseline-live-session", buildInfo.gitCommit, 100, "web");
    seedValidCompletedSession("cohort-current-web-2", "baseline-live-session", buildInfo.gitCommit, 100, "web");
    seedValidCompletedSession("cohort-current-android-1", "baseline-live-session", buildInfo.gitCommit, 100, "android");
    seedValidCompletedSession("cohort-current-android-2", "baseline-live-session", buildInfo.gitCommit, 100, "android");

    const regression = testingSnapshot(10_000).regression;
    expect(regression.status).toBe("watch");
    expect(regression.cohorts).toContainEqual(
      expect.objectContaining({ platform: "android", status: "insufficient", baselineSessions: 0 })
    );
    expect(regression.findings).toContainEqual(
      expect.objectContaining({ id: expect.stringContaining("android"), status: "watch" })
    );
  });

  it("skips a newer previous build that has only invalid evidence when choosing the regression baseline", () => {
    seedValidCompletedSession("baseline-valid-1", "baseline-live-session", "previous-valid", 100);
    seedValidCompletedSession("baseline-valid-2", "baseline-live-session", "previous-valid", 100);

    beginTesterSession(
      "baseline-invalid-newer",
      {
        testerId: "aborted-run",
        ipAddress: "203.0.113.99",
        testingTestCaseId: "baseline-live-session",
        gitCommit: "previous-invalid"
      },
      5_000
    );
    // Long enough not to be only "too short", but still invalid because the
    // required mic audio and transcript exchange never happened.
    endTesterSession("baseline-invalid-newer", 9_000);
    seedValidCompletedSession("baseline-current-valid-1", "baseline-live-session", buildInfo.gitCommit, 120);
    seedValidCompletedSession("baseline-current-valid-2", "baseline-live-session", buildInfo.gitCommit, 120);

    const regression = testingSnapshot(10_000).regression;
    expect(regression.baseline?.build).toBe("previous-valid");
    expect(regression.status).not.toBe("insufficient");
  });

  it("keeps a durable baseline after it leaves the in-memory dashboard window", () => {
    seedValidCompletedSession("durable-baseline-1", "baseline-live-session", "durable-previous", 100);
    seedValidCompletedSession("durable-baseline-2", "baseline-live-session", "durable-previous", 100);
    for (let index = 0; index < 205; index += 1) {
      seedValidCompletedSession(`durable-current-${index}`, "baseline-live-session", buildInfo.gitCommit, 100);
    }

    const snapshot = testingSnapshot(10_000);
    expect(snapshot.sessions.some((session) => session.gitCommit === "durable-previous")).toBe(false);
    expect(snapshot.regression.baseline?.build).toBe("durable-previous");
    expect(snapshot.regression.baselineSource).toBe("latest-valid");
    expect(snapshot.regression.status).toBe("pass");
  });
});

describe("admin clear actions", () => {
  function seedTwoTesters() {
    beginTesterSession("clear-a-1", { testerId: "alice", ipAddress: "203.0.113.1" }, 1_000);
    recordTesterServerEvent("clear-a-1", { type: "transcript", speaker: "rider", text: "Max hello" }, 32, 1_100);
    endTesterSession("clear-a-1", 2_000);
    beginTesterSession("clear-a-2", { testerId: "alice", ipAddress: "203.0.113.1" }, 3_000);
    endTesterSession("clear-a-2", 4_000);
    beginTesterSession("clear-b-1", { testerId: "bob", ipAddress: "203.0.113.2" }, 5_000);
    endTesterSession("clear-b-1", 6_000);
  }

  it("clears one tester's aggregates, transcripts, and sessions — others untouched", () => {
    seedTwoTesters();
    const result = clearTesterData("alice@203.0.113.1");
    expect(result).toEqual({ removedTesters: 1, removedSessions: 2 });

    const snapshot = testingSnapshot(10_000);
    expect(snapshot.users.map((user) => user.testerId)).toEqual(["bob"]);
    expect(snapshot.sessions.map((session) => session.sessionId)).toEqual(["clear-b-1"]);
    // A repeat clear is a no-op.
    expect(clearTesterData("alice@203.0.113.1")).toEqual({ removedTesters: 0, removedSessions: 0 });
  });

  it("clears a tester with a still-active session without leaking the session entry", () => {
    beginTesterSession("clear-live", { testerId: "carol", ipAddress: "203.0.113.3" }, 1_000);
    const result = clearTesterData("carol@203.0.113.3");
    expect(result).toEqual({ removedTesters: 1, removedSessions: 1 });
    // The relay session later closing must not resurrect anything.
    endTesterSession("clear-live", 5_000);
    const snapshot = testingSnapshot(10_000);
    expect(snapshot.users.length).toBe(0);
    expect(snapshot.sessions.length).toBe(0);
  });

  it("deletes a single completed session but keeps the tester's aggregates", () => {
    seedTwoTesters();
    expect(clearTestingSession("clear-a-1")).toEqual({ removedTesters: 0, removedSessions: 1 });
    expect(clearTestingSession("clear-a-1")).toEqual({ removedTesters: 0, removedSessions: 0 });

    const snapshot = testingSnapshot(10_000);
    expect(snapshot.sessions.map((session) => session.sessionId).sort()).toEqual(["clear-a-2", "clear-b-1"]);
    const alice = snapshot.users.find((user) => user.testerId === "alice");
    expect(alice?.totalSessions).toBe(2); // lifetime traffic stats intentionally kept
  });

  it("clears everything at once, including the timeline", () => {
    seedTwoTesters();
    const result = clearAllTesterData();
    expect(result).toEqual({ removedTesters: 2, removedSessions: 3 });

    const snapshot = testingSnapshot(10_000);
    expect(snapshot.users.length).toBe(0);
    expect(snapshot.sessions.length).toBe(0);
    expect(snapshot.totals.totalTestSessions).toBe(0);
    expect(snapshot.timeline.every((bucket) => bucket.sessionsStarted === 0)).toBe(true);
  });

  it("keeps one tester's in-memory evidence when its durable deletion fails", () => {
    seedTwoTesters();
    vi.spyOn(testingStore, "deleteStoredTesterSessions").mockImplementation(() => {
      throw new Error("SQLite unavailable");
    });

    expect(() => clearTesterData("alice@203.0.113.1")).toThrow("SQLite unavailable");
    expect(
      testingSnapshot(10_000)
        .users.map((user) => user.testerId)
        .sort()
    ).toEqual(["alice", "bob"]);
    expect(
      testingSnapshot(10_000)
        .sessions.map((session) => session.sessionId)
        .sort()
    ).toEqual(["clear-a-1", "clear-a-2", "clear-b-1"]);
  });

  it("keeps a completed session in memory when its durable deletion fails", () => {
    seedTwoTesters();
    vi.spyOn(testingStore, "deleteStoredTestingSession").mockImplementation(() => {
      throw new Error("SQLite unavailable");
    });

    expect(() => clearTestingSession("clear-a-1")).toThrow("SQLite unavailable");
    expect(testingSnapshot(10_000).sessions.map((session) => session.sessionId)).toContain("clear-a-1");
  });

  it("keeps all in-memory evidence when the durable clear fails", () => {
    seedTwoTesters();
    vi.spyOn(testingStore, "deleteAllStoredTestingSessions").mockImplementation(() => {
      throw new Error("SQLite unavailable");
    });

    expect(() => clearAllTesterData()).toThrow("SQLite unavailable");
    expect(testingSnapshot(10_000).users).toHaveLength(2);
    expect(testingSnapshot(10_000).sessions).toHaveLength(3);
  });
});

describe("tester turn feedback recording", () => {
  it("keeps adjacent partials with different relay turn ids separate", () => {
    beginTesterSession("relay-turns", { testerId: "qa-turns", ipAddress: "203.0.113.22" }, 1_000);
    recordTesterServerEvent(
      "relay-turns",
      {
        type: "transcript",
        turnId: "turn-1",
        deliveryId: "delivery-1",
        speaker: "agent",
        text: "第一句",
        final: false
      },
      40,
      1_100
    );
    recordTesterServerEvent(
      "relay-turns",
      {
        type: "transcript",
        turnId: "turn-2",
        deliveryId: "delivery-2",
        speaker: "agent",
        text: "第二句",
        final: false
      },
      40,
      1_200
    );

    endTesterSession("relay-turns", 1_300);
    const turns = testingSnapshot(1_400).sessions.find((item) => item.sessionId === "relay-turns")?.turns ?? [];
    expect(turns.map((turn) => turn.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(turns[0]?.final).toBe(true);
    expect(turns[1]?.final).toBe(false);

    clearAllTesterData();
  });

  it("attaches feedback to the matching turn and downgrades the session", () => {
    beginTesterSession("relay-fb", { testerId: "qa-fb", ipAddress: "203.0.113.20" }, 1_000);
    recordTesterServerEvent("relay-fb", { type: "transcript", speaker: "rider", text: "Max, 天气怎么样" }, 40, 1_100);
    recordTesterServerEvent(
      "relay-fb",
      {
        type: "transcript",
        turnId: "agent-weather",
        deliveryId: "delivery-weather",
        speaker: "agent",
        text: "今天晴天。"
      },
      40,
      1_200
    );
    recordTesterServerEvent("relay-fb", { type: "metric", latencyMs: 150 }, 40, 1_250);
    recordTesterClientAudio("relay-fb", 320, 1_260);
    recordTesterTurnFeedback(
      "relay-fb",
      { turnId: "agent-weather", speaker: "agent", text: "今天晴天。", reason: "回答不对" },
      1_300
    );
    endTesterSession("relay-fb", 2_000);

    const snapshot = testingSnapshot(2_000);
    const session = snapshot.sessions.find((item) => item.testerId === "qa-fb");
    expect(session).toBeDefined();
    expect(session?.turns.find((turn) => turn.speaker === "agent")?.feedback).toBe("回答不对");
    expect(session?.quality).toBe("watch");
    expect(session?.flags).toContain("tester-feedback");
    // The per-tester rolling transcript mirrors the flag.
    const tester = snapshot.users.find((user) => user.testerId === "qa-fb");
    expect(tester?.recentTurns.find((turn) => turn.speaker === "agent")?.feedback).toBe("回答不对");

    clearAllTesterData();
  });

  it("does not attach feedback when the relay-issued turn id is unknown", () => {
    beginTesterSession("relay-fb2", { testerId: "qa-fb2", ipAddress: "203.0.113.21" }, 1_000);
    recordTesterServerEvent(
      "relay-fb2",
      { type: "transcript", turnId: "turn-1", deliveryId: "delivery-1", speaker: "agent", text: "第一句回复。" },
      40,
      1_100
    );
    recordTesterServerEvent(
      "relay-fb2",
      { type: "transcript", turnId: "turn-2", deliveryId: "delivery-2", speaker: "agent", text: "第二句回复。" },
      40,
      1_200
    );
    recordTesterTurnFeedback(
      "relay-fb2",
      { turnId: "missing-turn", speaker: "agent", text: "对不上的文本", reason: "太慢" },
      1_300
    );
    endTesterSession("relay-fb2", 2_000);

    const session = testingSnapshot(2_000).sessions.find((item) => item.testerId === "qa-fb2");
    const agentTurns = session?.turns.filter((turn) => turn.speaker === "agent") ?? [];
    expect(agentTurns.every((turn) => turn.feedback === undefined)).toBe(true);

    clearAllTesterData();
  });
});
