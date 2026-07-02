// In-process relay counters, exposed on /health so the Lightsail deployment
// can be checked with one curl: how many sessions are live, whether the Doubao
// upstream is flapping, and how often the browser-TTS fallback is carrying
// replies. Deliberately simple — no histograms, no external dependencies;
// counters reset when the process restarts (uptimeSec says when that was).

export type RelayMetrics = {
  /** Currently connected /agent clients. */
  activeSessions: number;
  /** Sessions accepted since the relay started. */
  totalSessions: number;
  /** Upgrade attempts rejected by auth/origin/rate-limit. */
  rejectedUpgrades: number;
  /** Doubao upstream errors and failed handshakes. */
  upstreamFailures: number;
  /** In-place upstream reconnect attempts (see doubao.ts retry). */
  upstreamReconnects: number;
  /** Turns where the browser-TTS fallback spoke instead of Doubao audio. */
  ttsFallbacks: number;
  /** Sessions the watchdog terminated for missed pongs. */
  watchdogTerminations: number;
  /** Sessions the watchdog closed as idle. */
  watchdogIdleCloses: number;
};

const counters: RelayMetrics = {
  activeSessions: 0,
  totalSessions: 0,
  rejectedUpgrades: 0,
  upstreamFailures: 0,
  upstreamReconnects: 0,
  ttsFallbacks: 0,
  watchdogTerminations: 0,
  watchdogIdleCloses: 0
};

export const metrics = {
  sessionOpened() {
    counters.activeSessions += 1;
    counters.totalSessions += 1;
  },
  sessionClosed() {
    counters.activeSessions = Math.max(0, counters.activeSessions - 1);
  },
  rejectedUpgrade() {
    counters.rejectedUpgrades += 1;
  },
  upstreamFailure() {
    counters.upstreamFailures += 1;
  },
  upstreamReconnect() {
    counters.upstreamReconnects += 1;
  },
  ttsFallback() {
    counters.ttsFallbacks += 1;
  },
  watchdogSweep(terminated: number, idled: number) {
    counters.watchdogTerminations += terminated;
    counters.watchdogIdleCloses += idled;
  },
  snapshot(): RelayMetrics {
    return { ...counters };
  },
  /** Test hook. */
  reset() {
    for (const key of Object.keys(counters) as Array<keyof RelayMetrics>) {
      counters[key] = 0;
    }
    history.length = 0;
    processStartedAt = Date.now();
  }
};

// --- trailing-window rates ---------------------------------------------------
// Totals alone can't distinguish "the upstream failed 40 times last month" from
// "it is failing right now". A per-minute snapshot ring buffer lets /health also
// report deltas over the trailing window.

/** Trailing window reported by metricsWindow(). */
export const METRICS_WINDOW_MINUTES = 15;

type HistoryEntry = { at: number; snapshot: RelayMetrics };

const history: HistoryEntry[] = [];
let processStartedAt = Date.now();

/** Appends a snapshot and prunes entries older than the window. */
export function recordMetricsSnapshot(now = Date.now()) {
  history.push({ at: now, snapshot: metrics.snapshot() });
  // Keep one entry beyond the window so a baseline at exactly window-age exists.
  const cutoff = now - (METRICS_WINDOW_MINUTES + 1) * 60_000;
  while (history.length > 1 && history[0].at < cutoff) history.shift();
}

export type MetricsWindow = {
  /** Actual minutes the window covers (shorter right after startup). */
  minutes: number;
  sessionsStarted: number;
  rejectedUpgrades: number;
  upstreamFailures: number;
  upstreamReconnects: number;
  ttsFallbacks: number;
  watchdogTerminations: number;
  watchdogIdleCloses: number;
};

/** Counter deltas over the trailing METRICS_WINDOW_MINUTES. */
export function metricsWindow(now = Date.now()): MetricsWindow {
  const cutoff = now - METRICS_WINDOW_MINUTES * 60_000;
  // Baseline: the newest snapshot at or before the window start; a process
  // younger than the window falls back to its zeroed start.
  let baseline: HistoryEntry | undefined;
  for (const entry of history) {
    if (entry.at > cutoff) break;
    baseline = entry;
  }
  const base = baseline?.snapshot;
  const baseAt = baseline?.at ?? processStartedAt;
  const current = metrics.snapshot();
  const delta = (key: keyof RelayMetrics) => current[key] - (base?.[key] ?? 0);

  return {
    minutes: Math.min(METRICS_WINDOW_MINUTES, Math.max(1, Math.round((now - baseAt) / 60_000))),
    sessionsStarted: delta("totalSessions"),
    rejectedUpgrades: delta("rejectedUpgrades"),
    upstreamFailures: delta("upstreamFailures"),
    upstreamReconnects: delta("upstreamReconnects"),
    ttsFallbacks: delta("ttsFallbacks"),
    watchdogTerminations: delta("watchdogTerminations"),
    watchdogIdleCloses: delta("watchdogIdleCloses")
  };
}

/** Starts the once-a-minute history recorder. Returns a stop function. */
export function startMetricsHistory(): () => void {
  const timer = setInterval(() => recordMetricsSnapshot(), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
