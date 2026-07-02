import { afterEach, describe, expect, it } from "vitest";
import { buildHealth } from "../server/config";
import { METRICS_WINDOW_MINUTES, metrics, metricsWindow, recordMetricsSnapshot } from "../server/metrics";

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

    expect(metrics.snapshot()).toMatchObject({
      rejectedUpgrades: 1,
      upstreamFailures: 1,
      upstreamReconnects: 1,
      ttsFallbacks: 1,
      watchdogTerminations: 2,
      watchdogIdleCloses: 1
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
});
