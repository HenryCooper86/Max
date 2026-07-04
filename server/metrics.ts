import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  TesterSessionSummary,
  TestingQuality,
  TestingStats,
  TestingTimelineBucket,
  TesterStats,
  TesterTranscriptTurn
} from "../shared/agent";

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
    completedSessions.length = 0;
    testingHistoryLoaded = TESTING_HISTORY_PATH === null;
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
const UNKNOWN_TESTER_ID = "unknown-tester";
const UNKNOWN_IP = "unknown-ip";
const MAX_TESTERS = 50;
const MAX_LATENCY_SAMPLES_PER_TESTER = 128;
const MAX_TRANSCRIPT_TURNS_PER_TESTER = 80;
const MAX_TRANSCRIPT_TURNS_PER_SESSION = 120;
const MAX_COMPLETED_SESSIONS = readBoundedInt(process.env.TESTING_HISTORY_MAX_SESSIONS, 200, 20, 5_000);
const TESTING_HISTORY_PATH = resolveTestingHistoryPath();

type MutableTesterStats = {
  testerKey: string;
  testerId: string;
  ipAddress: string;
  region: string;
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
  recentTurns: TesterTranscriptTurn[];
};

type ActiveTestingSession = {
  sessionId: string;
  testerKey: string;
  startedAt: number;
  audioUpBytes: number;
  audioDownBytes: number;
  controlDownBytes: number;
  micFrames: number;
  serverEvents: number;
  errorEvents: number;
  ttsFallbacks: number;
  latencyMs: number[];
  turns: TesterTranscriptTurn[];
};

type TesterIdentity = {
  testerId?: unknown;
  ipAddress?: unknown;
  region?: unknown;
};

type MutableTestingBucket = Omit<TestingTimelineBucket, "avgLatencyMs"> & {
  latencyTotalMs: number;
};

const testers = new Map<string, MutableTesterStats>();
const testingSessions = new Map<string, ActiveTestingSession>();
const testingTimeline = new Map<number, MutableTestingBucket>();
const completedSessions: TesterSessionSummary[] = [];
let testingHistoryLoaded = TESTING_HISTORY_PATH === null;

function readBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function resolveTestingHistoryPath(): string | null {
  if (process.env.NODE_ENV === "test") return null;
  const configuredFile = process.env.TESTING_HISTORY_FILE?.trim();
  if (configuredFile) return configuredFile;
  const configuredDir = process.env.TESTING_HISTORY_DIR?.trim();
  if (configuredDir?.toLowerCase() === "off") return null;
  const directory = configuredDir || path.join(os.homedir(), ".horizon-helmet-testing");
  return path.join(directory, "sessions.jsonl");
}

function cleanText(value: string): string {
  return value
    .normalize("NFKC")
    .split("")
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTesterId(value: unknown, ipAddress?: string): string {
  if (typeof value !== "string") return ipAddress && ipAddress !== UNKNOWN_IP ? `ip:${ipAddress}` : UNKNOWN_TESTER_ID;
  const withoutControls = cleanText(value);
  if (withoutControls) return withoutControls.slice(0, 80);
  return ipAddress && ipAddress !== UNKNOWN_IP ? `ip:${ipAddress}` : UNKNOWN_TESTER_ID;
}

function normalizeIpAddress(value: unknown): string {
  if (typeof value !== "string") return UNKNOWN_IP;
  const ip = cleanText(value)
    .replace(/^::ffff:/, "")
    .replace(/^\[(.*)]$/, "$1")
    .slice(0, 96);
  return ip || UNKNOWN_IP;
}

function ipRegion(ipAddress: string): string {
  if (ipAddress === UNKNOWN_IP) return "unknown";
  if (ipAddress === "::1" || ipAddress === "127.0.0.1" || ipAddress === "localhost") return "local";
  const [a = 0, b = 0] = ipAddress.split(".").map((part) => Number(part));
  if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) {
    return "private network";
  }
  return "public IP";
}

function normalizeRegion(value: unknown, ipAddress: string): string {
  if (typeof value === "string") {
    const region = cleanText(value).slice(0, 96);
    if (region) return region;
  }
  return ipRegion(ipAddress);
}

function normalizeTesterIdentity(input: TesterIdentity | unknown) {
  const profile = isRecord(input) ? input : { testerId: input };
  const ipAddress = normalizeIpAddress(profile.ipAddress);
  const testerId = normalizeTesterId(profile.testerId, ipAddress);
  const region = normalizeRegion(profile.region, ipAddress);
  return {
    testerKey: `${testerId}@${ipAddress}`,
    testerId,
    ipAddress,
    region
  };
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

function getTester(identity: ReturnType<typeof normalizeTesterIdentity>, now: number): MutableTesterStats {
  let tester = testers.get(identity.testerKey);
  if (!tester) {
    tester = {
      testerKey: identity.testerKey,
      testerId: identity.testerId,
      ipAddress: identity.ipAddress,
      region: identity.region,
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
      latencyMs: [],
      recentTurns: []
    };
    testers.set(identity.testerKey, tester);
    trimInactiveTesters();
  }
  tester.ipAddress = identity.ipAddress;
  tester.region = identity.region;
  tester.lastSeenAt = now;
  return tester;
}

function trimInactiveTesters() {
  if (testers.size <= MAX_TESTERS) return;
  const inactive = [...testers.values()]
    .filter((tester) => tester.activeSessions === 0)
    .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
  while (testers.size > MAX_TESTERS && inactive.length) {
    testers.delete(inactive.shift()!.testerKey);
  }
}

function activeSession(
  sessionId: string,
  now: number
): { session: ActiveTestingSession; tester: MutableTesterStats } | null {
  const session = testingSessions.get(sessionId);
  if (!session) return null;
  const tester = testers.get(session.testerKey);
  if (tester) {
    tester.lastSeenAt = now;
    return { session, tester };
  }
  return null;
}

function recordLatency(tester: MutableTesterStats, session: ActiveTestingSession, latencyMs: number, now: number) {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  const rounded = Math.round(latencyMs);
  tester.latencyMs.push(rounded);
  if (tester.latencyMs.length > MAX_LATENCY_SAMPLES_PER_TESTER) tester.latencyMs.shift();
  session.latencyMs.push(rounded);
  const bucket = currentBucket(now);
  bucket.latencySamples += 1;
  bucket.latencyTotalMs += rounded;
}

function normalizeTranscriptSpeaker(value: unknown): TesterTranscriptTurn["speaker"] | null {
  return value === "rider" || value === "agent" ? value : null;
}

function mergeTranscriptTurn(turns: TesterTranscriptTurn[], turn: TesterTranscriptTurn, maxTurns: number) {
  const lastTurn = turns[turns.length - 1];

  if (lastTurn && lastTurn.sessionId === turn.sessionId && lastTurn.speaker === turn.speaker && !lastTurn.final) {
    lastTurn.at = turn.at;
    lastTurn.text = turn.text;
    lastTurn.final = turn.final;
    return;
  }

  turns.push(turn);
  if (turns.length > maxTurns) {
    turns.splice(0, turns.length - maxTurns);
  }
}

function recordTranscriptTurn(
  tester: MutableTesterStats,
  session: ActiveTestingSession,
  payload: Record<string, unknown>,
  now: number
) {
  if (payload.type !== "transcript") return;
  const speaker = normalizeTranscriptSpeaker(payload.speaker);
  if (!speaker || typeof payload.text !== "string") return;
  const text = cleanText(payload.text).slice(0, 2_000);
  if (!text) return;
  const final = payload.final !== false;
  const turn = { sessionId: session.sessionId, at: now, speaker, text, final };
  mergeTranscriptTurn(tester.recentTurns, { ...turn }, MAX_TRANSCRIPT_TURNS_PER_TESTER);
  mergeTranscriptTurn(session.turns, turn, MAX_TRANSCRIPT_TURNS_PER_SESSION);
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

function scoreSession(session: ActiveTestingSession): { quality: TestingQuality; flags: string[] } {
  const flags: string[] = [];
  const p95LatencyMs = percentile(session.latencyMs, 95);
  if (session.errorEvents > 0) flags.push("errors");
  if (session.ttsFallbacks > 0) flags.push("tts-fallback");
  if (p95LatencyMs > 800) flags.push("p95-latency-critical");
  else if (p95LatencyMs > 320) flags.push("p95-latency-watch");
  if (session.micFrames === 0) flags.push("no-mic-audio");
  if (!session.turns.length) flags.push("no-transcript");

  const quality: TestingQuality =
    session.errorEvents > 0 || p95LatencyMs > 800 ? "fail" : flags.length > 0 ? "watch" : "pass";
  return { quality, flags };
}

function completedSessionSummary(
  session: ActiveTestingSession,
  tester: MutableTesterStats,
  endedAt: number
): TesterSessionSummary {
  const { quality, flags } = scoreSession(session);
  return {
    sessionId: session.sessionId,
    testerKey: tester.testerKey,
    testerId: tester.testerId,
    ipAddress: tester.ipAddress,
    region: tester.region,
    startedAt: session.startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - session.startedAt),
    audioUpBytes: session.audioUpBytes,
    audioDownBytes: session.audioDownBytes,
    controlDownBytes: session.controlDownBytes,
    micFrames: session.micFrames,
    serverEvents: session.serverEvents,
    latencySamples: session.latencyMs.length,
    avgLatencyMs: average(session.latencyMs),
    p95LatencyMs: percentile(session.latencyMs, 95),
    errorEvents: session.errorEvents,
    ttsFallbacks: session.ttsFallbacks,
    quality,
    flags,
    notes: "",
    turns: session.turns.map((turn) => ({ ...turn }))
  };
}

function normalizeQuality(value: unknown): TestingQuality {
  return value === "pass" || value === "watch" || value === "fail" ? value : "watch";
}

function normalizeTranscriptTurn(value: unknown): TesterTranscriptTurn | null {
  if (!isRecord(value)) return null;
  const speaker = normalizeTranscriptSpeaker(value.speaker);
  if (!speaker || typeof value.text !== "string") return null;
  const sessionId = typeof value.sessionId === "string" ? cleanText(value.sessionId).slice(0, 120) : "";
  const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0;
  const text = cleanText(value.text).slice(0, 2_000);
  if (!sessionId || !at || !text) return null;
  return { sessionId, at, speaker, text, final: value.final !== false };
}

function normalizeCompletedSession(value: unknown): TesterSessionSummary | null {
  if (!isRecord(value)) return null;
  const sessionId = typeof value.sessionId === "string" ? cleanText(value.sessionId).slice(0, 120) : "";
  const ipAddress = normalizeIpAddress(value.ipAddress);
  const testerId = normalizeTesterId(value.testerId, ipAddress);
  const testerKey =
    typeof value.testerKey === "string" && cleanText(value.testerKey)
      ? cleanText(value.testerKey).slice(0, 180)
      : `${testerId}@${ipAddress}`;
  const region = normalizeRegion(value.region, ipAddress);
  const startedAt = typeof value.startedAt === "number" && Number.isFinite(value.startedAt) ? value.startedAt : 0;
  const endedAt = typeof value.endedAt === "number" && Number.isFinite(value.endedAt) ? value.endedAt : startedAt;
  if (!sessionId || !startedAt) return null;
  const numberField = (key: string) => {
    const field = value[key];
    return typeof field === "number" && Number.isFinite(field) ? Math.max(0, Math.round(field)) : 0;
  };
  const turns = Array.isArray(value.turns)
    ? value.turns.map(normalizeTranscriptTurn).filter((turn): turn is TesterTranscriptTurn => Boolean(turn))
    : [];

  return {
    sessionId,
    testerKey,
    testerId,
    ipAddress,
    region,
    startedAt,
    endedAt,
    durationMs: numberField("durationMs") || Math.max(0, endedAt - startedAt),
    audioUpBytes: numberField("audioUpBytes"),
    audioDownBytes: numberField("audioDownBytes"),
    controlDownBytes: numberField("controlDownBytes"),
    micFrames: numberField("micFrames"),
    serverEvents: numberField("serverEvents"),
    latencySamples: numberField("latencySamples"),
    avgLatencyMs: numberField("avgLatencyMs"),
    p95LatencyMs: numberField("p95LatencyMs"),
    errorEvents: numberField("errorEvents"),
    ttsFallbacks: numberField("ttsFallbacks"),
    quality: normalizeQuality(value.quality),
    flags: Array.isArray(value.flags)
      ? value.flags
          .filter((flag): flag is string => typeof flag === "string")
          .map((flag) => cleanText(flag).slice(0, 80))
      : [],
    notes: typeof value.notes === "string" ? cleanText(value.notes).slice(0, 1_000) : "",
    turns: turns.slice(-MAX_TRANSCRIPT_TURNS_PER_SESSION)
  };
}

function testerFromCompletedSession(session: TesterSessionSummary): MutableTesterStats {
  let tester = testers.get(session.testerKey);
  if (!tester) {
    tester = {
      testerKey: session.testerKey,
      testerId: session.testerId,
      ipAddress: session.ipAddress,
      region: session.region,
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
      lastSeenAt: session.endedAt,
      latencyMs: [],
      recentTurns: []
    };
    testers.set(session.testerKey, tester);
  }
  return tester;
}

function applyCompletedSessionToTester(session: TesterSessionSummary) {
  const tester = testerFromCompletedSession(session);
  tester.testerId = session.testerId;
  tester.ipAddress = session.ipAddress;
  tester.region = session.region;
  tester.totalSessions += 1;
  tester.totalSessionMs += session.durationMs;
  tester.audioUpBytes += session.audioUpBytes;
  tester.audioDownBytes += session.audioDownBytes;
  tester.controlDownBytes += session.controlDownBytes;
  tester.micFrames += session.micFrames;
  tester.serverEvents += session.serverEvents;
  tester.errorEvents += session.errorEvents;
  tester.ttsFallbacks += session.ttsFallbacks;
  tester.lastSeenAt = Math.max(tester.lastSeenAt, session.endedAt);
  if (session.latencySamples > 0 && session.avgLatencyMs > 0) {
    tester.latencyMs.push(...Array.from({ length: Math.min(4, session.latencySamples) }, () => session.avgLatencyMs));
    while (tester.latencyMs.length > MAX_LATENCY_SAMPLES_PER_TESTER) tester.latencyMs.shift();
  }
  for (const turn of session.turns) {
    mergeTranscriptTurn(tester.recentTurns, { ...turn }, MAX_TRANSCRIPT_TURNS_PER_TESTER);
  }
}

function trimCompletedSessions() {
  completedSessions.sort((a, b) => b.endedAt - a.endedAt);
  if (completedSessions.length > MAX_COMPLETED_SESSIONS) {
    completedSessions.length = MAX_COMPLETED_SESSIONS;
  }
}

function ensureTestingHistoryLoaded() {
  if (testingHistoryLoaded) return;
  testingHistoryLoaded = true;
  if (!TESTING_HISTORY_PATH) return;
  try {
    const raw = fs.readFileSync(TESTING_HISTORY_PATH, "utf8");
    for (const line of raw.split("\n").slice(-MAX_COMPLETED_SESSIONS)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const session = normalizeCompletedSession(JSON.parse(trimmed));
      if (session) {
        completedSessions.push(session);
        applyCompletedSessionToTester(session);
      }
    }
    trimCompletedSessions();
    trimInactiveTesters();
  } catch {
    // History is best-effort. Missing or unreadable files must not break /health.
  }
}

function persistCompletedSession(session: TesterSessionSummary) {
  if (!TESTING_HISTORY_PATH) return;
  try {
    fs.mkdirSync(path.dirname(TESTING_HISTORY_PATH), { recursive: true });
    fs.appendFileSync(TESTING_HISTORY_PATH, `${JSON.stringify(session)}\n`);
  } catch {
    // Persistence failure should not interrupt a live voice session.
  }
}

function rememberCompletedSession(session: TesterSessionSummary) {
  ensureTestingHistoryLoaded();
  completedSessions.unshift(session);
  trimCompletedSessions();
  persistCompletedSession(session);
}

function testerSnapshot(tester: MutableTesterStats): TesterStats {
  return {
    testerId: tester.testerId,
    testerKey: tester.testerKey,
    ipAddress: tester.ipAddress,
    region: tester.region,
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
    lastSeenAt: tester.lastSeenAt,
    recentTurns: tester.recentTurns.map((turn) => ({ ...turn }))
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

export function beginTesterSession(sessionId: string, identityInput: TesterIdentity | unknown, now = Date.now()) {
  if (testingSessions.has(sessionId)) return;
  const identity = normalizeTesterIdentity(identityInput);
  const tester = getTester(identity, now);
  tester.activeSessions += 1;
  tester.totalSessions += 1;
  tester.lastSeenAt = now;
  testingSessions.set(sessionId, {
    sessionId,
    testerKey: identity.testerKey,
    startedAt: now,
    audioUpBytes: 0,
    audioDownBytes: 0,
    controlDownBytes: 0,
    micFrames: 0,
    serverEvents: 0,
    errorEvents: 0,
    ttsFallbacks: 0,
    latencyMs: [],
    turns: []
  });
  currentBucket(now).sessionsStarted += 1;
}

export function endTesterSession(sessionId: string, now = Date.now()) {
  const session = testingSessions.get(sessionId);
  if (!session) return;
  const tester = testers.get(session.testerKey);
  if (!tester) return;
  tester.activeSessions = Math.max(0, tester.activeSessions - 1);
  tester.totalSessionMs += Math.max(0, now - session.startedAt);
  tester.lastSeenAt = now;
  testingSessions.delete(sessionId);
  rememberCompletedSession(completedSessionSummary(session, tester, now));
}

export function recordTesterClientAudio(sessionId: string, bytes: number, now = Date.now()) {
  const active = activeSession(sessionId, now);
  if (!active) return;
  const { session, tester } = active;
  const safeBytes = Math.max(0, bytes);
  tester.audioUpBytes += safeBytes;
  tester.micFrames += 1;
  tester.lastSeenAt = now;
  session.audioUpBytes += safeBytes;
  session.micFrames += 1;
  currentBucket(now).audioUpBytes += safeBytes;
}

export function recordTesterServerAudio(sessionId: string, bytes: number, now = Date.now()) {
  const active = activeSession(sessionId, now);
  if (!active) return;
  const { session, tester } = active;
  const safeBytes = Math.max(0, bytes);
  tester.audioDownBytes += safeBytes;
  tester.lastSeenAt = now;
  session.audioDownBytes += safeBytes;
  currentBucket(now).audioDownBytes += safeBytes;
}

export function recordTesterServerEvent(sessionId: string, payload: unknown, bytes: number, now = Date.now()) {
  const active = activeSession(sessionId, now);
  if (!active) return;
  const { session, tester } = active;
  const safeBytes = Math.max(0, bytes);
  tester.controlDownBytes += safeBytes;
  tester.serverEvents += 1;
  tester.lastSeenAt = now;
  session.controlDownBytes += safeBytes;
  session.serverEvents += 1;
  const bucket = currentBucket(now);
  bucket.controlDownBytes += safeBytes;

  if (!isRecord(payload) || typeof payload.type !== "string") return;
  if (payload.type === "error") {
    tester.errorEvents += 1;
    session.errorEvents += 1;
    bucket.errorEvents += 1;
  }
  if (payload.type === "metric" && typeof payload.latencyMs === "number") {
    recordLatency(tester, session, payload.latencyMs, now);
  }
  recordTranscriptTurn(tester, session, payload, now);
}

export function recordTesterTtsFallback(sessionId: string, now = Date.now()) {
  const active = activeSession(sessionId, now);
  if (!active) return;
  const { session, tester } = active;
  tester.ttsFallbacks += 1;
  tester.lastSeenAt = now;
  session.ttsFallbacks += 1;
}

export function testingSnapshot(now = Date.now()): TestingStats {
  ensureTestingHistoryLoaded();
  const users = [...testers.values()].map(testerSnapshot).sort((a, b) => {
    if (b.activeSessions !== a.activeSessions) return b.activeSessions - a.activeSessions;
    if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
    return b.totalSessions - a.totalSessions;
  });
  const latency = users.flatMap((user) => {
    const tester = testers.get(user.testerKey);
    return tester?.latencyMs ?? [];
  });
  return {
    windowMinutes: TESTING_WINDOW_MINUTES,
    history: {
      persistent: Boolean(TESTING_HISTORY_PATH),
      maxSessions: MAX_COMPLETED_SESSIONS,
      maxTranscriptTurnsPerTester: MAX_TRANSCRIPT_TURNS_PER_TESTER,
      maxTranscriptTurnsPerSession: MAX_TRANSCRIPT_TURNS_PER_SESSION
    },
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
    sessions: completedSessions.map((session) => ({
      ...session,
      flags: [...session.flags],
      turns: session.turns.map((turn) => ({ ...turn }))
    })),
    timeline: timelineSnapshot(now)
  };
}
