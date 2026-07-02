import { afterEach, describe, expect, it } from "vitest";
import { buildHealth } from "../server/config";
import { metrics } from "../server/metrics";

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
});
