import type { TestingStats, TestingTimelineBucket, TesterStats } from "../shared/agent";

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
  /** Rider mic audio bytes received from clients. */
  audioUpBytes: number;
  /** Agent PCM audio bytes sent back to clients. */
  audioDownBytes: number;
  /** JSON event bytes sent back to clients. */
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
  },
  /** Test hook. */
  reset() {
    for (const key of Object.keys(counters) as Array<keyof RelayMetrics>) {
      counters[key] = 0;
    }
    history.length = 0;
    testingSessions.clear();
    testers.clear();
    testingTimeline.clear();
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
  audioUpBytes: number;
  audioDownBytes: number;
  controlDownBytes: number;
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
    watchdogIdleCloses: delta("watchdogIdleCloses"),
    audioUpBytes: delta("audioUpBytes"),
    audioDownBytes: delta("audioDownBytes"),
    controlDownBytes: delta("controlDownBytes")
  };
}

/** Starts the once-a-minute history recorder. Returns a stop function. */
export function startMetricsHistory(): () => void {
  const timer = setInterval(() => recordMetricsSnapshot(), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

// --- per-tester QA statistics -----------------------------------------------
// These in-memory stats are intentionally dependency-free so the relay can run
// as a single production test process. They answer "who tested what, how much
// audio moved, and how the realtime path behaved" between process restarts.

export const TESTING_WINDOW_MINUTES = 30;
const ANONYMOUS_TESTER_ID = "anonymous";
const MAX_TESTERS = 50;
const MAX_LATENCY_SAMPLES_PER_TESTER = 128;

type MutableTesterStats = {
  testerId: string;
  activeSessions: number;
  totalSessions: number;
  totalSessionMs: number;
  audioUpBytes: number;
  audioDownBytes: number;
  controlDownBytes: number;
  micFrames: number;
  serverEvents: number;
  errorEvents: number;
  ttsFallbacks: number;
  lastSeenAt: number;
  latencyMs: number[];
};

type ActiveTestingSession = {
  testerId: string;
  startedAt: number;
};

type MutableTestingBucket = Omit<TestingTimelineBucket, "avgLatencyMs"> & {
  latencyTotalMs: number;
};

const testers = new Map<string, MutableTesterStats>();
const testingSessions = new Map<string, ActiveTestingSession>();
const testingTimeline = new Map<number, MutableTestingBucket>();

export function normalizeTesterId(value: unknown): string {
  if (typeof value !== "string") return ANONYMOUS_TESTER_ID;
  const withoutControls = value
    .normalize("NFKC")
    .split("")
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return withoutControls.slice(0, 80) || ANONYMOUS_TESTER_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function currentBucket(now: number): MutableTestingBucket {
  const at = Math.floor(now / 60_000) * 60_000;
  let bucket = testingTimeline.get(at);
  if (!bucket) {
    bucket = {
      at,
      sessionsStarted: 0,
      audioUpBytes: 0,
      audioDownBytes: 0,
      controlDownBytes: 0,
      latencySamples: 0,
      latencyTotalMs: 0,
      errorEvents: 0
    };
    testingTimeline.set(at, bucket);
  }
  const cutoff = at - TESTING_WINDOW_MINUTES * 60_000;
  for (const key of testingTimeline.keys()) {
    if (key < cutoff) testingTimeline.delete(key);
  }
  return bucket;
}

function getTester(testerId: string, now: number): MutableTesterStats {
  const id = normalizeTesterId(testerId);
  let tester = testers.get(id);
  if (!tester) {
    tester = {
      testerId: id,
      activeSessions: 0,
      totalSessions: 0,
      totalSessionMs: 0,
      audioUpBytes: 0,
      audioDownBytes: 0,
      controlDownBytes: 0,
      micFrames: 0,
      serverEvents: 0,
      errorEvents: 0,
      ttsFallbacks: 0,
      lastSeenAt: now,
      latencyMs: []
    };
    testers.set(id, tester);
    trimInactiveTesters();
  }
  tester.lastSeenAt = now;
  return tester;
}

function trimInactiveTesters() {
  if (testers.size <= MAX_TESTERS) return;
  const inactive = [...testers.values()]
    .filter((tester) => tester.activeSessions === 0)
    .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
  while (testers.size > MAX_TESTERS && inactive.length) {
    testers.delete(inactive.shift()!.testerId);
  }
}

function activeTester(sessionId: string, now: number): MutableTesterStats | null {
  const session = testingSessions.get(sessionId);
  if (!session) return null;
  return getTester(session.testerId, now);
}

function recordLatency(tester: MutableTesterStats, latencyMs: number, now: number) {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  const rounded = Math.round(latencyMs);
  tester.latencyMs.push(rounded);
  if (tester.latencyMs.length > MAX_LATENCY_SAMPLES_PER_TESTER) tester.latencyMs.shift();
  const bucket = currentBucket(now);
  bucket.latencySamples += 1;
  bucket.latencyTotalMs += rounded;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], percentileRank: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileRank / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function testerSnapshot(tester: MutableTesterStats): TesterStats {
  return {
    testerId: tester.testerId,
    activeSessions: tester.activeSessions,
    totalSessions: tester.totalSessions,
    totalSessionMs: tester.totalSessionMs,
    audioUpBytes: tester.audioUpBytes,
    audioDownBytes: tester.audioDownBytes,
    controlDownBytes: tester.controlDownBytes,
    micFrames: tester.micFrames,
    serverEvents: tester.serverEvents,
    latencySamples: tester.latencyMs.length,
    avgLatencyMs: average(tester.latencyMs),
    p95LatencyMs: percentile(tester.latencyMs, 95),
    errorEvents: tester.errorEvents,
    ttsFallbacks: tester.ttsFallbacks,
    lastSeenAt: tester.lastSeenAt
  };
}

function timelineSnapshot(now: number): TestingTimelineBucket[] {
  const end = Math.floor(now / 60_000) * 60_000;
  return Array.from({ length: TESTING_WINDOW_MINUTES }, (_, index) => {
    const at = end - (TESTING_WINDOW_MINUTES - 1 - index) * 60_000;
    const bucket = testingTimeline.get(at);
    if (!bucket) {
      return {
        at,
        sessionsStarted: 0,
        audioUpBytes: 0,
        audioDownBytes: 0,
        controlDownBytes: 0,
        latencySamples: 0,
        avgLatencyMs: 0,
        errorEvents: 0
      };
    }
    return {
      at: bucket.at,
      sessionsStarted: bucket.sessionsStarted,
      audioUpBytes: bucket.audioUpBytes,
      audioDownBytes: bucket.audioDownBytes,
      controlDownBytes: bucket.controlDownBytes,
      latencySamples: bucket.latencySamples,
      avgLatencyMs: bucket.latencySamples ? Math.round(bucket.latencyTotalMs / bucket.latencySamples) : 0,
      errorEvents: bucket.errorEvents
    };
  });
}

export function beginTesterSession(sessionId: string, testerId: unknown, now = Date.now()) {
  if (testingSessions.has(sessionId)) return;
  const id = normalizeTesterId(testerId);
  const tester = getTester(id, now);
  tester.activeSessions += 1;
  tester.totalSessions += 1;
  tester.lastSeenAt = now;
  testingSessions.set(sessionId, { testerId: id, startedAt: now });
  currentBucket(now).sessionsStarted += 1;
}

export function endTesterSession(sessionId: string, now = Date.now()) {
  const session = testingSessions.get(sessionId);
  if (!session) return;
  const tester = getTester(session.testerId, now);
  tester.activeSessions = Math.max(0, tester.activeSessions - 1);
  tester.totalSessionMs += Math.max(0, now - session.startedAt);
  tester.lastSeenAt = now;
  testingSessions.delete(sessionId);
}

export function recordTesterClientAudio(sessionId: string, bytes: number, now = Date.now()) {
  const tester = activeTester(sessionId, now);
  if (!tester) return;
  const safeBytes = Math.max(0, bytes);
  tester.audioUpBytes += safeBytes;
  tester.micFrames += 1;
  tester.lastSeenAt = now;
  currentBucket(now).audioUpBytes += safeBytes;
}

export function recordTesterServerAudio(sessionId: string, bytes: number, now = Date.now()) {
  const tester = activeTester(sessionId, now);
  if (!tester) return;
  const safeBytes = Math.max(0, bytes);
  tester.audioDownBytes += safeBytes;
  tester.lastSeenAt = now;
  currentBucket(now).audioDownBytes += safeBytes;
}

export function recordTesterServerEvent(sessionId: string, payload: unknown, bytes: number, now = Date.now()) {
  const tester = activeTester(sessionId, now);
  if (!tester) return;
  const safeBytes = Math.max(0, bytes);
  tester.controlDownBytes += safeBytes;
  tester.serverEvents += 1;
  tester.lastSeenAt = now;
  const bucket = currentBucket(now);
  bucket.controlDownBytes += safeBytes;

  if (!isRecord(payload) || typeof payload.type !== "string") return;
  if (payload.type === "error") {
    tester.errorEvents += 1;
    bucket.errorEvents += 1;
  }
  if (payload.type === "metric" && typeof payload.latencyMs === "number") {
    recordLatency(tester, payload.latencyMs, now);
  }
}

export function recordTesterTtsFallback(sessionId: string, now = Date.now()) {
  const tester = activeTester(sessionId, now);
  if (!tester) return;
  tester.ttsFallbacks += 1;
  tester.lastSeenAt = now;
}

export function testingSnapshot(now = Date.now()): TestingStats {
  const users = [...testers.values()].map(testerSnapshot).sort((a, b) => {
    if (b.activeSessions !== a.activeSessions) return b.activeSessions - a.activeSessions;
    if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
    return b.totalSessions - a.totalSessions;
  });
  const latency = users.flatMap((user) => {
    const tester = testers.get(user.testerId);
    return tester?.latencyMs ?? [];
  });
  return {
    windowMinutes: TESTING_WINDOW_MINUTES,
    totals: {
      activeTestSessions: users.reduce((sum, user) => sum + user.activeSessions, 0),
      totalTestSessions: users.reduce((sum, user) => sum + user.totalSessions, 0),
      audioUpBytes: users.reduce((sum, user) => sum + user.audioUpBytes, 0),
      audioDownBytes: users.reduce((sum, user) => sum + user.audioDownBytes, 0),
      controlDownBytes: users.reduce((sum, user) => sum + user.controlDownBytes, 0),
      avgLatencyMs: average(latency),
      p95LatencyMs: percentile(latency, 95),
      errorEvents: users.reduce((sum, user) => sum + user.errorEvents, 0),
      ttsFallbacks: users.reduce((sum, user) => sum + user.ttsFallbacks, 0)
    },
    users,
    timeline: timelineSnapshot(now)
  };
}
