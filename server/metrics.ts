import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  TesterSessionSummary,
  TestingStats,
  TestingTimelineBucket,
  TesterStats,
  TesterTranscriptTurn
} from "../shared/agent";
import {
  TESTING_TEST_CASES,
  findTestingCampaign,
  findTestingTestCase,
  testingCatalog,
  type TestingBuildSummary,
  type TestingEvaluationSummary,
  type TestingInvalidReason,
  type TestingQuality,
  type TestingRegressionFinding,
  type TestingRegressionSummary,
  type TestingReleaseGate,
  type TestingReleaseGateCase,
  type TestingValiditySummary
} from "../shared/testing";
import { buildInfo } from "./build-info";
import { evaluateTestingSession } from "./testing-evaluator";

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
const MIN_VALID_SESSION_MS = 1_500;
const RELEASE_GATE_REQUIRED_TEST_CASE_IDS = TESTING_TEST_CASES.map((testCase) => testCase.id);
const RELEASE_GATE_CRITERIA = {
  minValidSessionsPerRequiredCase: 1,
  maxFailSessions: 0,
  maxWatchSessions: 2,
  maxInvalidSessions: 3,
  maxP95LatencyMs: 1_400
};

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
  // Identity is denormalized onto the session so a completed-session summary
  // can still be written when the tester record was evicted mid-session.
  testerId: string;
  ipAddress: string;
  region: string;
  campaignId: string;
  campaignName: string;
  testCaseId: string;
  testCaseName: string;
  appVersion: string;
  gitCommit: string;
  deviceLabel: string;
  browserLanguage: string;
  networkType: string;
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
  testingCampaignId?: unknown;
  testingTestCaseId?: unknown;
  appVersion?: unknown;
  gitCommit?: unknown;
  deviceLabel?: unknown;
  browserLanguage?: unknown;
  networkType?: unknown;
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

function normalizeMetaString(value: unknown, fallback: string, maxLength = 120): string {
  if (typeof value !== "string") return fallback;
  const text = cleanText(value).slice(0, maxLength);
  return text || fallback;
}

function normalizeSessionMeta(input: TesterIdentity) {
  const campaign = findTestingCampaign(normalizeMetaString(input.testingCampaignId, "", 80));
  const testCase = findTestingTestCase(normalizeMetaString(input.testingTestCaseId, "", 80));
  const campaignForCase = findTestingCampaign(testCase.campaignId);
  const resolvedCampaign = campaign.id === testCase.campaignId ? campaign : campaignForCase;
  return {
    campaignId: resolvedCampaign.id,
    campaignName: resolvedCampaign.name,
    testCaseId: testCase.id,
    testCaseName: testCase.name,
    appVersion: normalizeMetaString(input.appVersion, buildInfo.appVersion, 40),
    gitCommit: normalizeMetaString(input.gitCommit, buildInfo.gitCommit, 80),
    deviceLabel: normalizeMetaString(input.deviceLabel, "unknown device", 120),
    browserLanguage: normalizeMetaString(input.browserLanguage, "unknown language", 40),
    networkType: normalizeMetaString(input.networkType, "unknown network", 40)
  };
}

function normalizeTesterIdentity(input: TesterIdentity | unknown) {
  const profile = isRecord(input) ? input : { testerId: input };
  const ipAddress = normalizeIpAddress(profile.ipAddress);
  const testerId = normalizeTesterId(profile.testerId, ipAddress);
  const region = normalizeRegion(profile.region, ipAddress);
  const meta = normalizeSessionMeta(profile);
  return {
    testerKey: `${testerId}@${ipAddress}`,
    testerId,
    ipAddress,
    region,
    ...meta
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

function validityDetail(reasons: TestingInvalidReason[]): string {
  if (!reasons.length) return "Valid release evidence.";
  const labels: Record<TestingInvalidReason, string> = {
    "too-short": "session ended too quickly",
    "missing-transcript": "required transcript missing",
    "missing-rider-turn": "required rider turn missing",
    "missing-agent-turn": "required agent reply missing",
    "missing-mic-audio": "required mic audio missing"
  };
  return `Invalid release evidence: ${reasons.map((reason) => labels[reason]).join(", ")}.`;
}

function classifySessionEvidence(input: {
  testCaseId: string;
  durationMs: number;
  micFrames: number;
  turns: TesterTranscriptTurn[];
}): TestingValiditySummary {
  const testCase = findTestingTestCase(input.testCaseId);
  const minRiderTurns = testCase.minRiderTurns ?? (testCase.requireTranscript && !testCase.requireAdasAlert ? 1 : 0);
  const minAgentTurns = testCase.minAgentTurns ?? (testCase.requireTranscript ? 1 : 0);
  const riderTurns = input.turns.filter((turn) => turn.speaker === "rider").length;
  const agentTurns = input.turns.filter((turn) => turn.speaker === "agent").length;
  const reasons: TestingInvalidReason[] = [];

  if (input.durationMs < MIN_VALID_SESSION_MS) reasons.push("too-short");
  if (testCase.requireTranscript && input.turns.length === 0) reasons.push("missing-transcript");
  if (riderTurns < minRiderTurns) reasons.push("missing-rider-turn");
  if (agentTurns < minAgentTurns) reasons.push("missing-agent-turn");
  if (testCase.requireMicAudio && input.micFrames <= 0) reasons.push("missing-mic-audio");

  return {
    status: reasons.length ? "invalid" : "valid",
    reasons,
    detail: validityDetail(reasons)
  };
}

function completedSessionsForBuild(build: string): TesterSessionSummary[] {
  return completedSessions.filter((session) => session.gitCommit === build);
}

function summarizeBuild(build: string, sessions: TesterSessionSummary[]): TestingBuildSummary {
  const validSessions = sessions.filter((session) => session.validity.status === "valid");
  const invalidSessions = sessions.length - validSessions.length;
  const failSessions = validSessions.filter((session) => session.quality === "fail").length;
  const watchSessions = validSessions.filter((session) => session.quality === "watch").length;
  const p95LatencyMs = percentile(
    validSessions.filter((session) => session.p95LatencyMs > 0).map((session) => session.p95LatencyMs),
    95
  );
  const avgScore = validSessions.length
    ? Math.round(validSessions.reduce((sum, session) => sum + session.evaluation.score, 0) / validSessions.length)
    : 0;
  const rate = (count: number) => (validSessions.length ? Math.round((count / validSessions.length) * 100) : 0);
  return {
    build,
    sessions: sessions.length,
    validSessions: validSessions.length,
    invalidSessions,
    failSessions,
    watchSessions,
    p95LatencyMs,
    avgScore,
    ttsFallbackRatePct: rate(validSessions.filter((session) => session.ttsFallbacks > 0).length),
    failRatePct: rate(failSessions),
    latestAt: sessions.reduce((latest, session) => Math.max(latest, session.endedAt), 0)
  };
}

function buildReleaseGate(now: number): TestingReleaseGate {
  const build = buildInfo.gitCommit;
  const sessions = completedSessionsForBuild(build);
  const validSessions = sessions.filter((session) => session.validity.status === "valid");
  const invalidSessions = sessions.length - validSessions.length;
  const failSessions = validSessions.filter((session) => session.quality === "fail").length;
  const watchSessions = validSessions.filter((session) => session.quality === "watch").length;
  const p95LatencyMs = percentile(
    validSessions.filter((session) => session.p95LatencyMs > 0).map((session) => session.p95LatencyMs),
    95
  );
  const blockers: string[] = [];
  const warnings: string[] = [];

  const cases: TestingReleaseGateCase[] = RELEASE_GATE_REQUIRED_TEST_CASE_IDS.map((testCaseId) => {
    const testCase = findTestingTestCase(testCaseId);
    const caseSessions = sessions.filter((session) => session.testCaseId === testCaseId);
    const caseValid = caseSessions.filter((session) => session.validity.status === "valid");
    const caseInvalid = caseSessions.length - caseValid.length;
    const latest = caseSessions[0];
    const hasFail = caseValid.some((session) => session.quality === "fail");
    const status: TestingReleaseGateCase["status"] =
      caseValid.length >= RELEASE_GATE_CRITERIA.minValidSessionsPerRequiredCase
        ? hasFail
          ? "blocked"
          : "pass"
        : caseInvalid
          ? "invalid"
          : "missing";

    if (status === "missing") blockers.push(`${testCase.name}: missing a valid current-build run.`);
    if (status === "invalid") blockers.push(`${testCase.name}: only invalid current-build evidence is available.`);
    if (status === "blocked") blockers.push(`${testCase.name}: latest valid evidence includes a failing run.`);

    return {
      testCaseId: testCase.id,
      testCaseName: testCase.name,
      status,
      validSessions: caseValid.length,
      invalidSessions: caseInvalid,
      latestSessionId: latest?.sessionId,
      latestQuality: latest?.quality,
      latestAt: latest?.endedAt
    };
  });

  if (failSessions > RELEASE_GATE_CRITERIA.maxFailSessions) {
    blockers.push(`${failSessions} valid current-build session(s) failed.`);
  }
  if (watchSessions > RELEASE_GATE_CRITERIA.maxWatchSessions) {
    blockers.push(
      `${watchSessions} valid current-build session(s) are watch, above ${RELEASE_GATE_CRITERIA.maxWatchSessions}.`
    );
  } else if (watchSessions > 0) {
    warnings.push(`${watchSessions} valid current-build session(s) are watch.`);
  }
  if (invalidSessions > RELEASE_GATE_CRITERIA.maxInvalidSessions) {
    blockers.push(
      `${invalidSessions} invalid current-build session(s), above ${RELEASE_GATE_CRITERIA.maxInvalidSessions}.`
    );
  } else if (invalidSessions > 0) {
    warnings.push(`${invalidSessions} invalid current-build session(s) excluded from release scoring.`);
  }
  if (p95LatencyMs > RELEASE_GATE_CRITERIA.maxP95LatencyMs) {
    blockers.push(`Current-build p95 ${p95LatencyMs}ms exceeds ${RELEASE_GATE_CRITERIA.maxP95LatencyMs}ms.`);
  }

  const status: TestingReleaseGate["status"] = !sessions.length
    ? "waiting"
    : blockers.length
      ? "fail"
      : warnings.length
        ? "watch"
        : "pass";

  return {
    status,
    build,
    generatedAt: now,
    criteria: { ...RELEASE_GATE_CRITERIA },
    requiredTestCaseIds: [...RELEASE_GATE_REQUIRED_TEST_CASE_IDS],
    validSessions: validSessions.length,
    invalidSessions,
    failSessions,
    watchSessions,
    p95LatencyMs,
    cases,
    blockers,
    warnings
  };
}

function regressionStatus(findings: TestingRegressionFinding[]): TestingRegressionSummary["status"] {
  if (findings.some((finding) => finding.status === "fail")) return "fail";
  if (findings.some((finding) => finding.status === "watch")) return "watch";
  return "pass";
}

function buildRegressionSummary(): TestingRegressionSummary {
  const currentBuild = buildInfo.gitCommit;
  const current = summarizeBuild(currentBuild, completedSessionsForBuild(currentBuild));
  const baselineBuild = [...completedSessions]
    // Pick the latest previous BUILD WITH VALID EVIDENCE. A newer build that
    // only produced aborted/invalid runs must not hide an older usable
    // baseline and downgrade regression reporting to "insufficient".
    .filter((session) => session.gitCommit !== currentBuild && session.validity.status === "valid")
    .sort((a, b) => b.endedAt - a.endedAt)[0]?.gitCommit;
  const baseline = baselineBuild ? summarizeBuild(baselineBuild, completedSessionsForBuild(baselineBuild)) : undefined;
  const findings: TestingRegressionFinding[] = [];

  if (!current.validSessions) {
    return {
      status: "insufficient",
      current,
      baseline,
      findings: [
        {
          id: "current-build-evidence",
          status: "watch",
          label: "Current build evidence",
          detail: "No valid current-build sessions are available for regression comparison."
        }
      ]
    };
  }

  if (!baseline || !baseline.validSessions) {
    return {
      status: "insufficient",
      current,
      baseline,
      findings: [
        {
          id: "baseline-evidence",
          status: "watch",
          label: "Baseline evidence",
          detail: "No valid previous-build sessions are available for regression comparison."
        }
      ]
    };
  }

  const deltas = {
    p95LatencyMs: current.p95LatencyMs - baseline.p95LatencyMs,
    avgScore: current.avgScore - baseline.avgScore,
    failRatePct: current.failRatePct - baseline.failRatePct,
    ttsFallbackRatePct: current.ttsFallbackRatePct - baseline.ttsFallbackRatePct
  };

  findings.push({
    id: "p95-latency-drift",
    label: "P95 latency drift",
    status: deltas.p95LatencyMs > 250 ? "fail" : deltas.p95LatencyMs > 100 ? "watch" : "pass",
    detail: `Current p95 ${current.p95LatencyMs}ms vs baseline ${baseline.p95LatencyMs}ms (${deltas.p95LatencyMs >= 0 ? "+" : ""}${deltas.p95LatencyMs}ms).`
  });
  findings.push({
    id: "score-drift",
    label: "Evaluation score drift",
    status: deltas.avgScore < -10 ? "fail" : deltas.avgScore < -5 ? "watch" : "pass",
    detail: `Current avg score ${current.avgScore} vs baseline ${baseline.avgScore} (${deltas.avgScore >= 0 ? "+" : ""}${deltas.avgScore}).`
  });
  findings.push({
    id: "fail-rate-drift",
    label: "Fail-rate drift",
    status: deltas.failRatePct > 10 ? "fail" : deltas.failRatePct > 0 ? "watch" : "pass",
    detail: `Current fail rate ${current.failRatePct}% vs baseline ${baseline.failRatePct}% (${deltas.failRatePct >= 0 ? "+" : ""}${deltas.failRatePct}%).`
  });
  findings.push({
    id: "fallback-rate-drift",
    label: "Fallback-rate drift",
    status: deltas.ttsFallbackRatePct > 25 ? "fail" : deltas.ttsFallbackRatePct > 10 ? "watch" : "pass",
    detail: `Current fallback rate ${current.ttsFallbackRatePct}% vs baseline ${baseline.ttsFallbackRatePct}% (${deltas.ttsFallbackRatePct >= 0 ? "+" : ""}${deltas.ttsFallbackRatePct}%).`
  });

  return {
    status: regressionStatus(findings),
    current,
    baseline,
    deltas,
    findings
  };
}

function scoreSession(session: ActiveTestingSession): {
  quality: TestingQuality;
  flags: string[];
  evaluation: TestingEvaluationSummary;
} {
  const evaluation = evaluateTestingSession({
    testCaseId: session.testCaseId,
    p95LatencyMs: percentile(session.latencyMs, 95),
    micFrames: session.micFrames,
    errorEvents: session.errorEvents,
    ttsFallbacks: session.ttsFallbacks,
    turns: session.turns
  });
  const flags = evaluation.checks
    .filter((check) => check.status === "fail" || check.status === "warn")
    .map((check) => check.id);
  return { quality: evaluation.quality, flags, evaluation };
}

function completedSessionSummary(session: ActiveTestingSession, endedAt: number): TesterSessionSummary {
  const { quality, flags, evaluation } = scoreSession(session);
  const durationMs = Math.max(0, endedAt - session.startedAt);
  const validity = classifySessionEvidence({
    testCaseId: session.testCaseId,
    durationMs,
    micFrames: session.micFrames,
    turns: session.turns
  });
  return {
    sessionId: session.sessionId,
    testerKey: session.testerKey,
    testerId: session.testerId,
    ipAddress: session.ipAddress,
    region: session.region,
    campaignId: session.campaignId,
    campaignName: session.campaignName,
    testCaseId: session.testCaseId,
    testCaseName: session.testCaseName,
    appVersion: session.appVersion,
    gitCommit: session.gitCommit,
    deviceLabel: session.deviceLabel,
    browserLanguage: session.browserLanguage,
    networkType: session.networkType,
    startedAt: session.startedAt,
    endedAt,
    durationMs,
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
    validity,
    flags,
    notes: "",
    evaluation,
    turns: session.turns.map((turn) => ({ ...turn }))
  };
}

function normalizeTranscriptTurn(value: unknown): TesterTranscriptTurn | null {
  if (!isRecord(value)) return null;
  const speaker = normalizeTranscriptSpeaker(value.speaker);
  if (!speaker || typeof value.text !== "string") return null;
  const sessionId = typeof value.sessionId === "string" ? cleanText(value.sessionId).slice(0, 120) : "";
  const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0;
  const text = cleanText(value.text).slice(0, 2_000);
  if (!sessionId || !at || !text) return null;
  const turn: TesterTranscriptTurn = { sessionId, at, speaker, text, final: value.final !== false };
  if (typeof value.feedback === "string") {
    const feedback = cleanText(value.feedback).slice(0, 120);
    if (feedback) turn.feedback = feedback;
  }
  return turn;
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
  const testCase = findTestingTestCase(normalizeMetaString(value.testCaseId, "", 80));
  const campaign = findTestingCampaign(normalizeMetaString(value.campaignId, testCase.campaignId, 80));
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
  const p95LatencyMs = numberField("p95LatencyMs");
  const micFrames = numberField("micFrames");
  const errorEvents = numberField("errorEvents");
  const ttsFallbacks = numberField("ttsFallbacks");
  const durationMs = numberField("durationMs") || Math.max(0, endedAt - startedAt);
  // Evaluation and validity are DERIVED evidence, not historical authority.
  // Re-run the current deterministic policy whenever JSONL history loads so
  // a policy fix cannot leave old persisted "pass"/"valid" fields feeding the
  // release gate indefinitely.
  const evaluation = evaluateTestingSession({
    testCaseId: testCase.id,
    p95LatencyMs,
    micFrames,
    errorEvents,
    ttsFallbacks,
    turns
  });
  const flags = evaluation.checks
    .filter((check) => check.status === "fail" || check.status === "warn")
    .map((check) => check.id);
  const validity = classifySessionEvidence({
    testCaseId: testCase.id,
    durationMs,
    micFrames,
    turns
  });

  return {
    sessionId,
    testerKey,
    testerId,
    ipAddress,
    region,
    campaignId: campaign.id,
    campaignName: campaign.name,
    testCaseId: testCase.id,
    testCaseName: testCase.name,
    appVersion: normalizeMetaString(value.appVersion, "unknown", 40),
    gitCommit: normalizeMetaString(value.gitCommit, "unknown", 80),
    deviceLabel: normalizeMetaString(value.deviceLabel, "unknown device", 120),
    browserLanguage: normalizeMetaString(value.browserLanguage, "unknown language", 40),
    networkType: normalizeMetaString(value.networkType, "unknown network", 40),
    startedAt,
    endedAt,
    durationMs,
    audioUpBytes: numberField("audioUpBytes"),
    audioDownBytes: numberField("audioDownBytes"),
    controlDownBytes: numberField("controlDownBytes"),
    micFrames,
    serverEvents: numberField("serverEvents"),
    latencySamples: numberField("latencySamples"),
    avgLatencyMs: numberField("avgLatencyMs"),
    p95LatencyMs,
    errorEvents,
    ttsFallbacks,
    quality: evaluation.quality,
    validity,
    flags,
    notes: typeof value.notes === "string" ? cleanText(value.notes).slice(0, 1_000) : "",
    evaluation,
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
    // Drop blank lines BEFORE slicing: the file ends with "\n", so slicing the
    // raw split would count a trailing "" and silently lose the oldest session.
    const lines = raw.split("\n").filter((line) => line.trim());
    for (const line of lines.slice(-MAX_COMPLETED_SESSIONS)) {
      try {
        const session = normalizeCompletedSession(JSON.parse(line));
        if (session) {
          completedSessions.push(session);
          applyCompletedSessionToTester(session);
        }
      } catch {
        // One corrupt line (e.g. a partial write from a crash) must not
        // discard every session recorded after it.
      }
    }
    trimCompletedSessions();
    trimInactiveTesters();
    compactTestingHistory(lines);
  } catch {
    // History is best-effort. Missing or unreadable files must not break /health.
  }
}

/**
 * The history file is append-only, but only the newest MAX_COMPLETED_SESSIONS
 * lines are ever used. Once startup finds the file has grown well past that,
 * rewrite it (write-then-rename, so a crash never truncates the original) to
 * bound disk usage and future startup reads.
 */
function compactTestingHistory(lines: string[]) {
  if (!TESTING_HISTORY_PATH || lines.length <= MAX_COMPLETED_SESSIONS * 4) return;
  try {
    const retained = lines.slice(-MAX_COMPLETED_SESSIONS);
    const tempPath = `${TESTING_HISTORY_PATH}.compact`;
    fs.writeFileSync(tempPath, `${retained.join("\n")}\n`);
    fs.renameSync(tempPath, TESTING_HISTORY_PATH);
  } catch {
    // Compaction is opportunistic; the append path still works without it.
  }
}

// Appends are chained on one promise so summaries land in completion order
// without blocking the event loop — a sync write in the WebSocket close
// handler would stall live PCM relaying for every other rider on a slow disk.
let persistQueue: Promise<void> = Promise.resolve();

function persistCompletedSession(session: TesterSessionSummary) {
  const filePath = TESTING_HISTORY_PATH;
  if (!filePath) return;
  const line = `${JSON.stringify(session)}\n`;
  persistQueue = persistQueue
    .then(async () => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.appendFile(filePath, line);
    })
    .catch(() => {
      // Persistence failure should not interrupt a live voice session.
    });
}

/** Test hook: resolves when every queued history append has hit disk. */
export function flushTestingHistory(): Promise<void> {
  return persistQueue;
}

/**
 * Rewrites the on-disk history to mirror the in-memory completed sessions.
 * Serialized on the same queue as appends so a clear can't interleave with a
 * session summary landing, and write-then-rename so a crash never truncates.
 */
function rewriteTestingHistory() {
  const filePath = TESTING_HISTORY_PATH;
  if (!filePath) return;
  // completedSessions is newest-first; the file is append-order (oldest first).
  const lines = [...completedSessions].reverse().map((session) => JSON.stringify(session));
  persistQueue = persistQueue
    .then(async () => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.rewrite`;
      await fs.promises.writeFile(tempPath, lines.length ? `${lines.join("\n")}\n` : "");
      await fs.promises.rename(tempPath, filePath);
    })
    .catch(() => {
      // Best-effort like the append path; memory already reflects the clear.
    });
}

// --- admin: clearing tester QA data ------------------------------------------
// The stats are append-only during normal operation; these are the explicit
// admin actions behind POST /testing/clear (token-gated when a relay token is
// configured). Clearing removes drilldown data (transcripts, session replays)
// and tester aggregates; live relay connections are unaffected — a cleared
// tester's still-open session simply stops being tracked.

export type TestingClearResult = { removedTesters: number; removedSessions: number };

/** Removes one tester: their aggregates, transcripts, and session history. */
export function clearTesterData(testerKey: string): TestingClearResult {
  ensureTestingHistoryLoaded();
  const removedTesters = testers.delete(testerKey) ? 1 : 0;
  let removedSessions = 0;
  for (const [sessionId, session] of testingSessions) {
    if (session.testerKey === testerKey) {
      testingSessions.delete(sessionId);
      removedSessions += 1;
    }
  }
  const before = completedSessions.length;
  for (let index = completedSessions.length - 1; index >= 0; index -= 1) {
    if (completedSessions[index].testerKey === testerKey) completedSessions.splice(index, 1);
  }
  removedSessions += before - completedSessions.length;
  if (removedTesters || removedSessions) rewriteTestingHistory();
  return { removedTesters, removedSessions };
}

/**
 * Removes one completed session from the history/replay. The owning tester's
 * lifetime aggregates are intentionally left as-is — they describe traffic
 * that did happen; use clearTesterData to reset a tester entirely.
 */
export function clearTestingSession(sessionId: string): TestingClearResult {
  ensureTestingHistoryLoaded();
  const index = completedSessions.findIndex((session) => session.sessionId === sessionId);
  if (index < 0) return { removedTesters: 0, removedSessions: 0 };
  completedSessions.splice(index, 1);
  rewriteTestingHistory();
  return { removedTesters: 0, removedSessions: 1 };
}

/** Removes every tester, session, transcript, and the timeline buckets. */
export function clearAllTesterData(): TestingClearResult {
  ensureTestingHistoryLoaded();
  const removedTesters = testers.size;
  const removedSessions = completedSessions.length + testingSessions.size;
  testers.clear();
  testingSessions.clear();
  completedSessions.length = 0;
  testingTimeline.clear();
  rewriteTestingHistory();
  return { removedTesters, removedSessions };
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
  // Trim only after this tester is marked active — trimming inside getTester
  // could evict the just-created record (it is the only inactive one when the
  // relay is at MAX_TESTERS busy testers), orphaning the session's stats.
  trimInactiveTesters();
  testingSessions.set(sessionId, {
    sessionId,
    testerKey: identity.testerKey,
    testerId: identity.testerId,
    ipAddress: identity.ipAddress,
    region: identity.region,
    campaignId: identity.campaignId,
    campaignName: identity.campaignName,
    testCaseId: identity.testCaseId,
    testCaseName: identity.testCaseName,
    appVersion: identity.appVersion,
    gitCommit: identity.gitCommit,
    deviceLabel: identity.deviceLabel,
    browserLanguage: identity.browserLanguage,
    networkType: identity.networkType,
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
  // Remove the active entry unconditionally — an evicted tester record must
  // not leave the session in the map forever (unbounded growth).
  testingSessions.delete(sessionId);
  const tester = testers.get(session.testerKey);
  if (tester) {
    tester.activeSessions = Math.max(0, tester.activeSessions - 1);
    tester.totalSessionMs += Math.max(0, now - session.startedAt);
    tester.lastSeenAt = now;
  }
  rememberCompletedSession(completedSessionSummary(session, now));
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

/** Attach a tester-reported problem to a transcript turn. Client and server
 *  timestamps differ, so the turn is matched by speaker + cleaned text; if the
 *  exact text is not found (e.g. divergent whitespace normalization), the
 *  feedback falls back to that speaker's most recent final turn. */
export function recordTesterTurnFeedback(
  sessionId: string,
  input: { speaker: TesterTranscriptTurn["speaker"]; text: string; reason: string },
  now = Date.now()
) {
  const active = activeSession(sessionId, now);
  if (!active) return;
  const { session, tester } = active;
  const text = cleanText(input.text).slice(0, 2_000);
  const reason = cleanText(input.reason).slice(0, 120);
  if (!reason) return;
  const target =
    [...session.turns].reverse().find((turn) => turn.speaker === input.speaker && turn.text === text) ??
    [...session.turns].reverse().find((turn) => turn.speaker === input.speaker && turn.final);
  if (!target) return;
  target.feedback = reason;
  tester.lastSeenAt = now;
  // The tester's rolling transcript holds copies of the same turns; mirror the
  // flag so the per-tester conversation history shows it too.
  const mirrored = tester.recentTurns.find(
    (turn) => turn.sessionId === target.sessionId && turn.at === target.at && turn.speaker === target.speaker
  );
  if (mirrored) mirrored.feedback = reason;
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
  const validCompletedSessions = completedSessions.filter((session) => session.validity.status === "valid").length;
  const invalidCompletedSessions = completedSessions.length - validCompletedSessions;
  return {
    windowMinutes: TESTING_WINDOW_MINUTES,
    catalog: testingCatalog(),
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
      ttsFallbacks: users.reduce((sum, user) => sum + user.ttsFallbacks, 0),
      validTestSessions: validCompletedSessions,
      invalidTestSessions: invalidCompletedSessions
    },
    releaseGate: buildReleaseGate(now),
    regression: buildRegressionSummary(),
    users,
    sessions: completedSessions.map((session) => ({
      ...session,
      validity: {
        ...session.validity,
        reasons: [...session.validity.reasons]
      },
      flags: [...session.flags],
      turns: session.turns.map((turn) => ({ ...turn }))
    })),
    timeline: timelineSnapshot(now)
  };
}
