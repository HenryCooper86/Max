import { afterEach, describe, expect, it } from "vitest";
import { buildHealth } from "../server/config";
import {
  METRICS_WINDOW_MINUTES,
  beginTesterSession,
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
    beginTesterSession("relay-1", " rider one ", 1_000);
    recordTesterClientAudio("relay-1", 320, 1_100);
    recordTesterServerAudio("relay-1", 640, 1_200);
    recordTesterServerEvent("relay-1", { type: "metric", latencyMs: 123 }, 88, 1_300);
    recordTesterServerEvent("relay-1", { type: "error", message: "boom" }, 42, 1_400);
    recordTesterTtsFallback("relay-1", 1_500);
    endTesterSession("relay-1", 61_000);

    const snapshot = testingSnapshot(61_000);
    expect(snapshot.totals).toMatchObject({
      activeTestSessions: 0,
      totalTestSessions: 1,
      audioUpBytes: 320,
      audioDownBytes: 640,
      controlDownBytes: 130,
      avgLatencyMs: 123,
      p95LatencyMs: 123,
      errorEvents: 1,
      ttsFallbacks: 1
    });
    expect(snapshot.users[0]).toMatchObject({
      testerId: "rider one",
      totalSessions: 1,
      totalSessionMs: 60_000,
      micFrames: 1,
      serverEvents: 2
    });
    expect(buildHealth(2).testing?.users[0]?.testerId).toBe("rider one");
  });
});
