import { afterEach, describe, expect, it } from "vitest";
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
  recordTesterServerAudio,
  recordTesterServerEvent,
  recordTesterTtsFallback,
  testingSnapshot
} from "../server/metrics";

afterEach(() => metrics.reset());

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
      flags: ["errors", "tts-fallback"],
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
    expect(buildHealth(2).testing?.users[0]?.testerId).toBe("rider one");
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
});
