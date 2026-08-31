// In-process relay counters and their trailing-window history. This module is
// deliberately independent from the larger tester evidence pipeline so basic
// health metrics remain small, reviewable, and reusable.

export type RelayMetrics = {
  activeSessions: number;
  totalSessions: number;
  rejectedUpgrades: number;
  upstreamFailures: number;
  upstreamReconnects: number;
  ttsFallbacks: number;
  watchdogTerminations: number;
  watchdogIdleCloses: number;
  audioUpBytes: number;
  audioDownBytes: number;
  controlDownBytes: number;
};

const counters: RelayMetrics = {
  activeSessions: 0,
  totalSessions: 0,
  rejectedUpgrades: 0,
  upstreamFailures: 0,
  upstreamReconnects: 0,
  ttsFallbacks: 0,
  watchdogTerminations: 0,
  watchdogIdleCloses: 0,
  audioUpBytes: 0,
  audioDownBytes: 0,
  controlDownBytes: 0
};

export const relayMetrics = {
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
  clientAudio(bytes: number) {
    counters.audioUpBytes += Math.max(0, bytes);
  },
  serverAudio(bytes: number) {
    counters.audioDownBytes += Math.max(0, bytes);
  },
  serverEvent(bytes: number) {
    counters.controlDownBytes += Math.max(0, bytes);
  },
  snapshot(): RelayMetrics {
    return { ...counters };
  }
};

export const METRICS_WINDOW_MINUTES = 15;
type HistoryEntry = { at: number; snapshot: RelayMetrics };
const history: HistoryEntry[] = [];
let processStartedAt = Date.now();

export function resetRelayMetrics() {
  for (const key of Object.keys(counters) as Array<keyof RelayMetrics>) counters[key] = 0;
  history.length = 0;
  processStartedAt = Date.now();
}

export function recordMetricsSnapshot(now = Date.now()) {
  history.push({ at: now, snapshot: relayMetrics.snapshot() });
  const cutoff = now - (METRICS_WINDOW_MINUTES + 1) * 60_000;
  while (history.length > 1) {
    const oldest = history[0];
    if (!oldest || oldest.at >= cutoff) break;
    history.shift();
  }
}

export type MetricsWindow = {
  minutes: number;
  sessionsStarted: number;
  rejectedUpgrades: number;
  upstreamFailures: number;
  upstreamReconnects: number;
  ttsFallbacks: number;
  watchdogTerminations: number;
  watchdogIdleCloses: number;
  audioUpBytes: number;
  audioDownBytes: number;
  controlDownBytes: number;
};

export function metricsWindow(now = Date.now()): MetricsWindow {
  const cutoff = now - METRICS_WINDOW_MINUTES * 60_000;
  let baseline: HistoryEntry | undefined;
  for (const entry of history) {
    if (entry.at > cutoff) break;
    baseline = entry;
  }
  const base = baseline?.snapshot;
  const baseAt = baseline?.at ?? processStartedAt;
  const current = relayMetrics.snapshot();
  const delta = (key: keyof RelayMetrics) => current[key] - (base?.[key] ?? 0);

  return {
    minutes: Math.min(METRICS_WINDOW_MINUTES, Math.max(1, Math.round((now - baseAt) / 60_000))),
    sessionsStarted: delta("totalSessions"),
    rejectedUpgrades: delta("rejectedUpgrades"),
    upstreamFailures: delta("upstreamFailures"),
    upstreamReconnects: delta("upstreamReconnects"),
    ttsFallbacks: delta("ttsFallbacks"),
    watchdogTerminations: delta("watchdogTerminations"),
    watchdogIdleCloses: delta("watchdogIdleCloses"),
    audioUpBytes: delta("audioUpBytes"),
    audioDownBytes: delta("audioDownBytes"),
    controlDownBytes: delta("controlDownBytes")
  };
}

export function startMetricsHistory(): () => void {
  const timer = setInterval(() => recordMetricsSnapshot(), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
