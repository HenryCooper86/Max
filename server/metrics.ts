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
  }
};
