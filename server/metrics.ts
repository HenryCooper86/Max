import fs from "node:fs";
import path from "node:path";
import type {
  TesterSessionSummary,
  TestingStats,
  TestingTimelineBucket,
  TesterStats,
  TesterTranscriptTurn
} from "../shared/agent";
import {
  DEFAULT_TESTING_POLICY,
  TESTING_TEST_CASES,
  findTestingCampaign,
  findTestingTestCase,
  normalizeTestingBuildIdentity,
  testingBuildsMatch,
  testingCatalog,
  type TestingAudioQuality,
  type TestingBuildSummary,
  type TestingEvaluationSummary,
  type TestingPlatform,
  type TestingQuality,
  type TestingRegressionCohort,
  type TestingRegressionFinding,
  type TestingRegressionSummary,
  type TestingReleaseGate,
  type TestingReleaseGateCase,
  type TestingSessionPage,
  type TestingSessionQuery,
  type TestingValiditySummary
} from "../shared/testing";
import { buildInfo } from "./build-info";
import { redactContactNames } from "./device-actions";
import { classifySessionEvidence, evaluateTestingSession } from "./testing-evaluator";
import { createLogger } from "./logger";
import {
  METRICS_WINDOW_MINUTES,
  metricsWindow,
  recordMetricsSnapshot,
  relayMetrics,
  resetRelayMetrics,
  startMetricsHistory,
  type MetricsWindow,
  type RelayMetrics
} from "./relay-metrics";
import {
  DEFAULT_TESTING_STORAGE_DIRECTORY,
  ensureTestingStorageDirectory,
  ensureTestingStorageDirectorySync,
  secureTestingFile,
  secureTestingFileSync
} from "./testing-storage";
import {
  deleteAllStoredTestingSessions,
  deleteStoredTesterSessions,
  deleteStoredTestingSession,
  evidenceHash,
  getActiveTestingPolicy,
  getApprovedBaselineBuild,
  inferTestingPlatform,
  loadStoredTestingSession,
  loadTestingSessions,
  loadTestingSessionsExcludingBuild,
  loadTestingSessionsForBuild,
  replaceStoredTestingSessions,
  resetTestingStore,
  saveTestingSession,
  storedTestingSessionPage,
  testingOperationsSnapshot,
  testingStorePersistent
} from "./testing-store";

const log = createLogger("testing-history");

let companionEventsAccepted = 0;
let companionEventsRejected = 0;

export const metrics = {
  ...relayMetrics,
  watchDrops: {
    disabled: 0,
    budget: 0,
    "adas-window": 0,
    speech: 0,
    cooldown: 0,
    "nothing-notable": 0,
    "model-failure": 0
  },
  watchDrop(reason: string): void {
    const key = reason as keyof typeof this.watchDrops;
    if (key in this.watchDrops) {
      this.watchDrops[key] += 1;
    }
  },
  companionAccepted(): void {
    companionEventsAccepted += 1;
  },
  companionRejected(): void {
    companionEventsRejected += 1;
  },
  snapshot(): ReturnType<typeof relayMetrics.snapshot> & Record<string, number> {
    return {
      ...relayMetrics.snapshot(),
      companionEventsAccepted,
      companionEventsRejected,
      watchDrops_disabled: this.watchDrops.disabled,
      watchDrops_budget: this.watchDrops.budget,
      watchDrops_adas_window: this.watchDrops["adas-window"],
      watchDrops_speech: this.watchDrops.speech,
      watchDrops_cooldown: this.watchDrops.cooldown,
      watchDrops_nothing_notable: this.watchDrops["nothing-notable"],
      watchDrops_model_failure: this.watchDrops["model-failure"]
    };
  },
  /** Test hook. */
  reset() {
    resetRelayMetrics();
    testingSessions.clear();
    testers.clear();
    testingTimeline.clear();
    completedSessions.length = 0;
    testingHistoryLoaded = false;
    resetTestingStore();
    companionEventsAccepted = 0;
    companionEventsRejected = 0;
    this.watchDrops.disabled = 0;
    this.watchDrops.budget = 0;
    this.watchDrops["adas-window"] = 0;
    this.watchDrops.speech = 0;
    this.watchDrops.cooldown = 0;
    this.watchDrops["nothing-notable"] = 0;
    this.watchDrops["model-failure"] = 0;
  }
};

export {
  METRICS_WINDOW_MINUTES,
  metricsWindow,
  recordMetricsSnapshot,
  startMetricsHistory,
  type MetricsWindow,
  type RelayMetrics
};

// --- per-tester QA statistics -----------------------------------------------
// These in-memory stats are intentionally dependency-free so the relay can run
// as a single production test process. They answer "who tested what, how much
// audio moved, and how the realtime path behaved" between process restarts.

export const TESTING_WINDOW_MINUTES = 30;
const UNKNOWN_TESTER_ID = "unknown-tester";
const UNKNOWN_IP = "unknown-ip";
const MAX_TESTERS = 50;
const MAX_LATENCY_SAMPLES_PER_TESTER = 128;
// Raw latency samples persisted per session so build/gate/cohort p95 can pool
// across sessions. Bounded to keep the JSONL history compact.
const MAX_LATENCY_SAMPLES_PER_SESSION = 200;
const MAX_TRANSCRIPT_TURNS_PER_TESTER = 80;
const MAX_TRANSCRIPT_TURNS_PER_SESSION = 120;
const MAX_COMPLETED_SESSIONS = readBoundedInt(process.env.TESTING_HISTORY_MAX_SESSIONS, 200, 20, 5_000);
const MAX_ARCHIVE_SESSIONS = process.env.TESTING_ARCHIVE_MAX_SESSIONS?.trim()
  ? readBoundedInt(process.env.TESTING_ARCHIVE_MAX_SESSIONS, 0, 20, 100_000)
  : 0;
const TESTING_HISTORY_PATH = resolveTestingHistoryPath();
if (TESTING_HISTORY_PATH) {
  ensureTestingStorageDirectorySync(TESTING_HISTORY_PATH);
  secureTestingFileSync(TESTING_HISTORY_PATH);
}
const RELEASE_GATE_REQUIRED_TEST_CASE_IDS = TESTING_TEST_CASES.map((testCase) => testCase.id);

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
  // Pass/watch/fail counts across this tester's graded (completed) sessions.
  qualityCounts: Record<TestingQuality, number>;
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
  platform: TestingPlatform;
  runId?: string;
  assignmentId?: string;
  startedAt: number;
  audioUpBytes: number;
  audioDownBytes: number;
  controlDownBytes: number;
  micFrames: number;
  serverEvents: number;
  errorEvents: number;
  ttsFallbacks: number;
  latencyMs: number[];
  audioQuality: TestingAudioQuality;
  // Per-field sample counts for the rolling averages. A shared counter biased
  // every average whenever an update omitted a field (droppedFrames is a
  // high-water mark and needs no count).
  audioQualitySampleCounts: { outgoingFps: number; jitterMs: number; clippingPct: number; silencePct: number };
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
  platform?: unknown;
  testingRunId?: unknown;
  testingAssignmentId?: unknown;
};

type MutableTestingBucket = Omit<TestingTimelineBucket, "avgLatencyMs"> & {
  latencyTotalMs: number;
};

const testers = new Map<string, MutableTesterStats>();
const testingSessions = new Map<string, ActiveTestingSession>();
const testingTimeline = new Map<number, MutableTestingBucket>();
const completedSessions: TesterSessionSummary[] = [];
let testingHistoryLoaded = false;

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
  const directory = configuredDir || DEFAULT_TESTING_STORAGE_DIRECTORY;
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
  const deviceLabel = normalizeMetaString(input.deviceLabel, "unknown device", 120);
  const networkType = normalizeMetaString(input.networkType, "unknown network", 40);
  return {
    campaignId: resolvedCampaign.id,
    campaignName: resolvedCampaign.name,
    testCaseId: testCase.id,
    testCaseName: testCase.name,
    appVersion: normalizeMetaString(input.appVersion, buildInfo.appVersion, 40),
    gitCommit: normalizeTestingBuildIdentity(input.gitCommit, buildInfo.gitCommit),
    deviceLabel,
    browserLanguage: normalizeMetaString(input.browserLanguage, "unknown language", 40),
    networkType,
    platform: inferTestingPlatform(input.platform, deviceLabel, networkType),
    runId: normalizeMetaString(input.testingRunId, "", 80) || undefined,
    assignmentId: normalizeMetaString(input.testingAssignmentId, "", 80) || undefined
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
      qualityCounts: { pass: 0, watch: 0, fail: 0 },
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
    // Current relays issue a stable turnId across partial/final revisions.
    // Only legacy id-less events may fall back to speaker adjacency; a new id
    // must never overwrite a dangling partial from the preceding turn.
    const sameTurn =
      (lastTurn.turnId && turn.turnId && lastTurn.turnId === turn.turnId) || (!lastTurn.turnId && !turn.turnId);
    if (sameTurn) {
      lastTurn.at = turn.at;
      lastTurn.text = turn.text;
      lastTurn.final = turn.final;
      lastTurn.deliveryId = turn.deliveryId;
      return;
    }
    lastTurn.final = true;
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
  // Rider commands can name a person ("打给老王"). The number never reaches the
  // relay; the name must not reach stored evidence either.
  const rawText = speaker === "rider" ? redactContactNames(payload.text) : payload.text;
  const text = cleanText(rawText).slice(0, 2_000);
  if (!text) return;
  const final = payload.final !== false;
  const turn = {
    sessionId: session.sessionId,
    turnId: typeof payload.turnId === "string" ? payload.turnId : undefined,
    deliveryId: typeof payload.deliveryId === "string" ? payload.deliveryId : undefined,
    at: now,
    speaker,
    text,
    final
  };
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
  return sorted[Math.max(0, index)] ?? 0;
}

/**
 * A TRUE pooled p95 over the raw latency samples of the given sessions. Pooling
 * the samples (not the per-session p95s) avoids the percentile-of-percentiles
 * distortion where, at QA sample sizes, `percentile(perSessionP95s, 95)`
 * collapses to the single worst session's p95. Sessions captured before raw
 * samples were persisted fall back to contributing their p95LatencyMs.
 */
function pooledLatencyP95(sessions: TesterSessionSummary[]): number {
  const pooled: number[] = [];
  for (const session of sessions) {
    const samples = session.latencyMsSamples?.filter((value) => Number.isFinite(value) && value > 0);
    if (samples && samples.length) {
      pooled.push(...samples);
    } else if (session.p95LatencyMs > 0) {
      pooled.push(session.p95LatencyMs);
    }
  }
  return percentile(pooled, 95);
}

function completedSessionsForBuild(build: string): TesterSessionSummary[] {
  const cached = completedSessions.filter((session) => testingBuildsMatch(session.gitCommit, build));
  try {
    const durable = loadTestingSessionsForBuild(build)
      .map(normalizeCompletedSession)
      .filter((session): session is TesterSessionSummary => Boolean(session));
    const durableIds = new Set(durable.map((session) => session.sessionId));
    return [...durable, ...cached.filter((session) => !durableIds.has(session.sessionId))].sort(
      (left, right) => right.endedAt - left.endedAt
    );
  } catch {
    return cached;
  }
}

function isDecisionGradeEvidence(session: TesterSessionSummary): boolean {
  return session.validity.status === "valid" && session.evidenceIntegrity !== "mismatch";
}

function activeTestingPolicy() {
  try {
    return getActiveTestingPolicy();
  } catch {
    // Session capture and JSONL recovery must keep working when the SQLite
    // operations index is temporarily unavailable.
    return DEFAULT_TESTING_POLICY;
  }
}

function summarizeBuild(build: string, sessions: TesterSessionSummary[]): TestingBuildSummary {
  const validSessions = sessions.filter(isDecisionGradeEvidence);
  const invalidSessions = sessions.length - validSessions.length;
  const failSessions = validSessions.filter((session) => session.quality === "fail").length;
  const watchSessions = validSessions.filter((session) => session.quality === "watch").length;
  const p95LatencyMs = pooledLatencyP95(validSessions);
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
    latestAt: sessions.reduce((latest, session) => Math.max(latest, session.endedAt), 0),
    cohorts: new Set(validSessions.map(regressionCohortKey)).size
  };
}

function normalizedNetworkCohort(value: string): string {
  const network = value.toLowerCase();
  if (/degraded|poor|loss|weak|2g|3g/.test(network)) return "degraded";
  if (/4g|5g|cell|mobile/.test(network)) return "cellular";
  if (/wifi|ethernet|lan/.test(network)) return "wifi";
  if (/wind|field/.test(network)) return "field";
  return network || "unknown";
}

function normalizedLanguage(session: TesterSessionSummary): string {
  const language = session.browserLanguage.toLowerCase().split(/[-_]/)[0];
  return language === "zh" || language === "en" ? language : "any";
}

function regressionCohortKey(session: TesterSessionSummary): string {
  return [
    session.testCaseId,
    session.platform,
    normalizedNetworkCohort(session.networkType),
    normalizedLanguage(session)
  ].join("|");
}

function buildReleaseGate(
  now: number,
  sessions: TesterSessionSummary[] = completedSessionsForBuild(buildInfo.gitCommit)
): TestingReleaseGate {
  const policy = activeTestingPolicy();
  const criteria = {
    minValidSessionsPerRequiredCase: policy.release.minStandardSessions,
    maxFailSessions: policy.release.maxFailSessions,
    maxWatchSessions: policy.release.maxWatchSessions,
    maxInvalidSessions: policy.release.maxInvalidSessions,
    maxP95LatencyMs: policy.release.maxP95LatencyMs,
    minStandardSessions: policy.release.minStandardSessions,
    minSafetyCriticalSessions: policy.release.minSafetyCriticalSessions,
    requiredPlatforms: [...policy.release.requiredPlatforms]
  };
  const build = buildInfo.gitCommit;
  const validSessions = sessions.filter(isDecisionGradeEvidence);
  const invalidSessions = sessions.length - validSessions.length;
  const failSessions = validSessions.filter((session) => session.quality === "fail").length;
  const watchSessions = validSessions.filter((session) => session.quality === "watch").length;
  const p95LatencyMs = pooledLatencyP95(validSessions);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const integrityFailures = sessions.filter((session) => session.evidenceIntegrity === "mismatch");
  const legacyEvidence = sessions.filter((session) => session.evidenceIntegrity === "legacy");
  if (integrityFailures.length) {
    blockers.push(`${integrityFailures.length} evidence record(s) failed SHA-256 integrity verification.`);
  }
  if (legacyEvidence.length) {
    warnings.push(`${legacyEvidence.length} legacy evidence record(s) predate integrity signing.`);
  }

  const cases: TestingReleaseGateCase[] = RELEASE_GATE_REQUIRED_TEST_CASE_IDS.map((testCaseId) => {
    const testCase = findTestingTestCase(testCaseId);
    const caseSessions = sessions.filter((session) => session.testCaseId === testCaseId);
    const caseValid = caseSessions.filter(isDecisionGradeEvidence);
    const caseInvalid = caseSessions.length - caseValid.length;
    const latest = caseSessions[0];
    const hasFail = caseValid.some((session) => session.quality === "fail");
    const requiredValidSessions = Math.max(
      testCase.minimumValidSessions,
      testCase.risk === "safety-critical" ? criteria.minSafetyCriticalSessions : criteria.minStandardSessions
    );
    const configuredPlatforms = testCase.requiredPlatforms.filter((platform) =>
      policy.release.requiredPlatforms.includes(platform)
    );
    const requiredPlatforms = configuredPlatforms.length ? configuredPlatforms : testCase.requiredPlatforms;
    const requiredPerPlatform = Math.max(1, Math.ceil(requiredValidSessions / requiredPlatforms.length));
    const cohorts = requiredPlatforms.map((platform) => {
      const platformSessions = caseSessions.filter((session) => session.platform === platform);
      const platformValid = platformSessions.filter(isDecisionGradeEvidence);
      const platformInvalid = platformSessions.length - platformValid.length;
      const platformFailed = platformValid.some((session) => session.quality === "fail");
      return {
        platform,
        required: requiredPerPlatform,
        validSessions: platformValid.length,
        invalidSessions: platformInvalid,
        status: platformFailed
          ? ("blocked" as const)
          : platformValid.length >= requiredPerPlatform
            ? ("pass" as const)
            : platformInvalid
              ? ("invalid" as const)
              : ("missing" as const)
      };
    });
    const missingPlatforms = cohorts.filter((cohort) => cohort.status !== "pass");
    // A failing valid run is "blocked" regardless of platform coverage. Testing
    // coverage first let a failing run on a required platform fall through to
    // "missing" (its cohort is "blocked", so it counts in missingPlatforms),
    // mislabeling a failing run as absent evidence and shadowing the dedicated
    // "failing run" blocker below.
    const status: TestingReleaseGateCase["status"] = hasFail
      ? "blocked"
      : caseValid.length >= requiredValidSessions && missingPlatforms.length === 0
        ? "pass"
        : caseInvalid
          ? "invalid"
          : "missing";

    if (status === "missing") {
      const platforms = missingPlatforms.map((cohort) => cohort.platform).join(", ");
      blockers.push(
        `${testCase.name}: ${caseValid.length}/${requiredValidSessions} valid current-build runs` +
          (platforms ? `; missing platform evidence for ${platforms}.` : ".")
      );
    }
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
      latestAt: latest?.endedAt,
      requiredValidSessions,
      risk: testCase.risk,
      cohorts
    };
  });

  if (failSessions > criteria.maxFailSessions) {
    blockers.push(`${failSessions} valid current-build session(s) failed.`);
  }
  if (watchSessions > criteria.maxWatchSessions) {
    blockers.push(`${watchSessions} valid current-build session(s) are watch, above ${criteria.maxWatchSessions}.`);
  } else if (watchSessions > 0) {
    warnings.push(`${watchSessions} valid current-build session(s) are watch.`);
  }
  if (invalidSessions > criteria.maxInvalidSessions) {
    blockers.push(`${invalidSessions} invalid current-build session(s), above ${criteria.maxInvalidSessions}.`);
  } else if (invalidSessions > 0) {
    warnings.push(`${invalidSessions} invalid current-build session(s) excluded from release scoring.`);
  }
  if (p95LatencyMs > criteria.maxP95LatencyMs) {
    blockers.push(`Current-build p95 ${p95LatencyMs}ms exceeds ${criteria.maxP95LatencyMs}ms.`);
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
    criteria,
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

function buildRegressionSummary(
  currentBuildSessions: TesterSessionSummary[] = completedSessionsForBuild(buildInfo.gitCommit)
): TestingRegressionSummary {
  const policy = activeTestingPolicy();
  const currentBuild = buildInfo.gitCommit;
  const current = summarizeBuild(currentBuild, currentBuildSessions);
  let approvedBaseline: string | undefined;
  try {
    approvedBaseline = getApprovedBaselineBuild();
  } catch {
    // Fall back to the latest valid build when the operations index is down.
  }
  const approvedBaselineSessions = approvedBaseline
    ? testingBuildsMatch(approvedBaseline, currentBuild)
      ? currentBuildSessions
      : completedSessionsForBuild(approvedBaseline)
    : [];
  const approvedBaselineUsable = approvedBaselineSessions.some(isDecisionGradeEvidence);
  let previousBuildSessions: TesterSessionSummary[];
  try {
    const durable = loadTestingSessionsExcludingBuild(currentBuild)
      .map(normalizeCompletedSession)
      .filter((session): session is TesterSessionSummary => Boolean(session));
    const durableIds = new Set(durable.map((session) => session.sessionId));
    previousBuildSessions = [
      ...durable,
      ...completedSessions.filter(
        (session) => !testingBuildsMatch(session.gitCommit, currentBuild) && !durableIds.has(session.sessionId)
      )
    ];
  } catch {
    previousBuildSessions = completedSessions.filter((session) => !testingBuildsMatch(session.gitCommit, currentBuild));
  }
  const latestValidBaseline = previousBuildSessions
    // Pick the latest previous BUILD WITH VALID EVIDENCE. A newer build that
    // only produced aborted/invalid runs must not hide an older usable
    // baseline and downgrade regression reporting to "insufficient".
    .filter((session) => !testingBuildsMatch(session.gitCommit, currentBuild) && isDecisionGradeEvidence(session))
    .sort((a, b) => b.endedAt - a.endedAt)[0]?.gitCommit;
  const baselineBuild = approvedBaselineUsable ? approvedBaseline : latestValidBaseline;
  const baselineSource: TestingRegressionSummary["baselineSource"] = approvedBaselineUsable
    ? "approved"
    : baselineBuild
      ? "latest-valid"
      : "none";
  const baselineSessions = baselineBuild
    ? baselineBuild === approvedBaseline
      ? approvedBaselineSessions
      : completedSessionsForBuild(baselineBuild)
    : [];
  const baseline = baselineBuild ? summarizeBuild(baselineBuild, baselineSessions) : undefined;
  const findings: TestingRegressionFinding[] = [];
  const cohorts: TestingRegressionCohort[] = [];

  if (!current.validSessions) {
    return {
      status: "insufficient",
      current,
      baseline,
      baselineSource,
      cohorts,
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
      baselineSource,
      cohorts,
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

  const currentByCohort = new Map<string, TesterSessionSummary[]>();
  const baselineByCohort = new Map<string, TesterSessionSummary[]>();
  for (const session of currentBuildSessions.filter(isDecisionGradeEvidence)) {
    const key = regressionCohortKey(session);
    currentByCohort.set(key, [...(currentByCohort.get(key) ?? []), session]);
  }
  for (const session of baselineSessions.filter(isDecisionGradeEvidence)) {
    const key = regressionCohortKey(session);
    baselineByCohort.set(key, [...(baselineByCohort.get(key) ?? []), session]);
  }
  const cohortKeys = new Set([...currentByCohort.keys(), ...baselineByCohort.keys()]);
  for (const key of cohortKeys) {
    const currentSessions = currentByCohort.get(key) ?? [];
    const baselineSessions = baselineByCohort.get(key) ?? [];
    const sample = currentSessions[0] ?? baselineSessions[0];
    if (!sample) continue;
    const currentP95LatencyMs = pooledLatencyP95(currentSessions);
    const baselineP95LatencyMs = pooledLatencyP95(baselineSessions);
    const currentAvgScore = average(currentSessions.map((session) => session.evaluation.score));
    const baselineAvgScore = average(baselineSessions.map((session) => session.evaluation.score));
    const latencyDeltaMs = currentP95LatencyMs - baselineP95LatencyMs;
    const scoreDelta = currentAvgScore - baselineAvgScore;
    const sufficient =
      currentSessions.length >= policy.regression.minimumMatchedCohortSessions &&
      baselineSessions.length >= policy.regression.minimumMatchedCohortSessions;
    const status: TestingRegressionCohort["status"] = !sufficient
      ? "insufficient"
      : latencyDeltaMs > policy.regression.latencyFailDeltaMs || scoreDelta < policy.regression.scoreFailDelta
        ? "fail"
        : latencyDeltaMs > policy.regression.latencyWatchDeltaMs || scoreDelta < policy.regression.scoreWatchDelta
          ? "watch"
          : "pass";
    cohorts.push({
      key,
      testCaseId: sample.testCaseId,
      platform: sample.platform,
      networkType: normalizedNetworkCohort(sample.networkType),
      language: normalizedLanguage(sample),
      currentSessions: currentSessions.length,
      baselineSessions: baselineSessions.length,
      currentP95LatencyMs,
      baselineP95LatencyMs,
      latencyDeltaMs,
      currentAvgScore,
      baselineAvgScore,
      scoreDelta,
      status
    });
    if (status === "fail" || status === "watch") {
      findings.push({
        id: `cohort-${key}`,
        label: `${sample.testCaseName} · ${sample.platform}`,
        status,
        detail: `Matched ${currentSessions.length}/${baselineSessions.length} sessions; latency ${latencyDeltaMs >= 0 ? "+" : ""}${latencyDeltaMs}ms, score ${scoreDelta >= 0 ? "+" : ""}${scoreDelta}.`
      });
    } else if (status === "insufficient") {
      findings.push({
        id: `cohort-${key}-coverage`,
        label: `${sample.testCaseName} · ${sample.platform}`,
        status: "watch",
        detail: `Cohort needs ${policy.regression.minimumMatchedCohortSessions} sessions in both builds; current ${currentSessions.length}, baseline ${baselineSessions.length}.`
      });
    }
  }

  const matched = cohorts.filter((cohort) => cohort.status !== "insufficient");
  if (!matched.length) {
    findings.push({
      id: "matched-cohort-evidence",
      status: "watch",
      label: "Matched cohort evidence",
      detail: `No case/platform/network/language cohort has at least ${policy.regression.minimumMatchedCohortSessions} valid sessions in both builds.`
    });
  } else if (!findings.length) {
    findings.push({
      id: "matched-cohort-stable",
      status: "pass",
      label: "Matched cohort stability",
      detail: `${matched.length} matched cohort(s) remain inside the active regression policy.`
    });
  }

  return {
    status: matched.length ? regressionStatus(findings) : "insufficient",
    current,
    baseline,
    baselineSource,
    deltas,
    findings,
    cohorts
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
  const policyVersion = activeTestingPolicy().version;
  const summary: Omit<TesterSessionSummary, "evidenceHash" | "evidenceIntegrity"> = {
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
    platform: session.platform,
    runId: session.runId,
    assignmentId: session.assignmentId,
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
    latencyMsSamples: session.latencyMs.slice(-MAX_LATENCY_SAMPLES_PER_SESSION),
    errorEvents: session.errorEvents,
    ttsFallbacks: session.ttsFallbacks,
    quality,
    validity,
    flags,
    notes: "",
    policyVersion,
    capturedEvaluation: { ...evaluation, checks: evaluation.checks.map((check) => ({ ...check })) },
    capturedValidity: { ...validity, reasons: [...validity.reasons] },
    audioQuality: { ...session.audioQuality },
    evaluation,
    turns: session.turns.map((turn) => ({ ...turn }))
  };
  return { ...summary, evidenceHash: evidenceHash(summary), evidenceIntegrity: "verified" };
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
  // Relay-issued identities are captured evidence and participate in its hash.
  // Dropping them during replay makes an intact archived recording mismatch.
  if (typeof value.turnId === "string") turn.turnId = value.turnId;
  if (typeof value.deliveryId === "string") turn.deliveryId = value.deliveryId;
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
  const deviceLabel = normalizeMetaString(value.deviceLabel, "unknown device", 120);
  const networkType = normalizeMetaString(value.networkType, "unknown network", 40);
  const platform = inferTestingPlatform(value.platform, deviceLabel, networkType);
  const capturedEvaluation =
    isRecord(value.capturedEvaluation) && Array.isArray(value.capturedEvaluation.checks)
      ? (value.capturedEvaluation as unknown as TestingEvaluationSummary)
      : evaluation;
  const capturedValidity =
    isRecord(value.capturedValidity) && Array.isArray(value.capturedValidity.reasons)
      ? (value.capturedValidity as unknown as TestingValiditySummary)
      : validity;
  const qualityRecord = isRecord(value.audioQuality) ? value.audioQuality : {};
  const qualityNumber = (key: string, max = Number.MAX_SAFE_INTEGER) => {
    const field = qualityRecord[key];
    return typeof field === "number" && Number.isFinite(field) ? Math.min(max, Math.max(0, field)) : 0;
  };
  const summary: Omit<TesterSessionSummary, "evidenceHash" | "evidenceIntegrity"> = {
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
    deviceLabel,
    browserLanguage: normalizeMetaString(value.browserLanguage, "unknown language", 40),
    networkType,
    platform,
    runId: normalizeMetaString(value.runId, "", 80) || undefined,
    assignmentId: normalizeMetaString(value.assignmentId, "", 80) || undefined,
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
    latencyMsSamples: Array.isArray(value.latencyMsSamples)
      ? value.latencyMsSamples
          .filter((sample): sample is number => typeof sample === "number" && Number.isFinite(sample) && sample >= 0)
          .map((sample) => Math.round(sample))
          .slice(-MAX_LATENCY_SAMPLES_PER_SESSION)
      : undefined,
    errorEvents,
    ttsFallbacks,
    quality: evaluation.quality,
    validity,
    flags,
    notes: typeof value.notes === "string" ? cleanText(value.notes).slice(0, 1_000) : "",
    policyVersion: normalizeMetaString(value.policyVersion, "legacy", 80),
    capturedEvaluation: {
      ...capturedEvaluation,
      checks: capturedEvaluation.checks.map((check) => ({ ...check }))
    },
    capturedValidity: { ...capturedValidity, reasons: [...capturedValidity.reasons] },
    audioQuality: {
      droppedFrames: Math.round(qualityNumber("droppedFrames")),
      outgoingFps: qualityNumber("outgoingFps", 1_000),
      jitterMs: qualityNumber("jitterMs", 60_000),
      clippingPct: qualityNumber("clippingPct", 100),
      silencePct: qualityNumber("silencePct", 100)
    },
    evaluation,
    turns: turns.slice(-MAX_TRANSCRIPT_TURNS_PER_SESSION)
  };
  const storedHash = normalizeMetaString(value.evidenceHash, "", 128);
  const calculatedHash = evidenceHash(summary);
  const evidenceIntegrity: TesterSessionSummary["evidenceIntegrity"] = !storedHash
    ? "legacy"
    : storedHash === calculatedHash
      ? value.evidenceIntegrity === "legacy"
        ? "legacy"
        : "verified"
      : "mismatch";
  return { ...summary, evidenceHash: storedHash || calculatedHash, evidenceIntegrity };
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
      qualityCounts: { pass: 0, watch: 0, fail: 0 },
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
  tester.qualityCounts[session.quality] += 1;
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
  try {
    const stored = loadTestingSessions(MAX_COMPLETED_SESSIONS);
    if (stored.length) {
      for (const raw of stored) {
        const session = normalizeCompletedSession(raw);
        if (!session) continue;
        completedSessions.push(session);
        applyCompletedSessionToTester(session);
      }
      trimCompletedSessions();
      trimInactiveTesters();
      return;
    }
  } catch {
    // The JSONL archive below remains a recovery path if SQLite is unavailable.
  }
  if (!TESTING_HISTORY_PATH) return;
  try {
    const raw = fs.readFileSync(TESTING_HISTORY_PATH, "utf8");
    // Drop blank lines BEFORE slicing: the file ends with "\n", so slicing the
    // raw split would count a trailing "" and silently lose the oldest session.
    const lines = raw.split("\n").filter((line) => line.trim());
    const migrationLines = lines;
    const migratedSessions: TesterSessionSummary[] = [];
    for (const [index, line] of migrationLines.entries()) {
      try {
        const session = normalizeCompletedSession(JSON.parse(line));
        if (session) {
          migratedSessions.push(session);
          if (index >= migrationLines.length - MAX_COMPLETED_SESSIONS) {
            completedSessions.push(session);
            applyCompletedSessionToTester(session);
          }
        }
      } catch {
        // One corrupt line (e.g. a partial write from a crash) must not
        // discard every session recorded after it.
      }
    }
    trimCompletedSessions();
    trimInactiveTesters();
    // One-time migration: preserve JSONL as the append-oriented archive while
    // indexing the normalized evidence in SQLite for scoped/paginated reads.
    replaceStoredTestingSessions(migratedSessions);
    compactTestingHistory(lines);
  } catch {
    // History is best-effort. Missing or unreadable files must not break /health.
  }
}

/**
 * Optional operator-configured archive retention. The production default is
 * unbounded: the small in-memory dashboard window must never decide how much
 * recovery evidence survives. Rewrites are atomic when a cap is configured.
 */
function compactTestingHistory(lines: string[]) {
  if (!TESTING_HISTORY_PATH || !MAX_ARCHIVE_SESSIONS || lines.length <= MAX_ARCHIVE_SESSIONS) return;
  try {
    const retained = lines.slice(-MAX_ARCHIVE_SESSIONS);
    const tempPath = `${TESTING_HISTORY_PATH}.compact`;
    fs.writeFileSync(tempPath, `${retained.join("\n")}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, TESTING_HISTORY_PATH);
    secureTestingFileSync(TESTING_HISTORY_PATH);
  } catch {
    // Compaction is opportunistic; the append path still works without it.
  }
}

// Appends are chained on one promise so summaries land in completion order
// without blocking the event loop — a sync write in the WebSocket close
// handler would stall live PCM relaying for every other rider on a slow disk.
let persistQueue: Promise<void> = Promise.resolve();

function persistCompletedSession(session: TesterSessionSummary) {
  try {
    saveTestingSession(session);
  } catch (error) {
    // JSONL remains the recovery archive if the database index is unavailable.
    log.error("failed to index completed testing session", {
      sessionId: session.sessionId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
  const filePath = TESTING_HISTORY_PATH;
  if (!filePath) return;
  const line = `${JSON.stringify(session)}\n`;
  persistQueue = persistQueue
    .then(async () => {
      await ensureTestingStorageDirectory(filePath);
      await fs.promises.appendFile(filePath, line, { mode: 0o600 });
      await secureTestingFile(filePath);
    })
    .catch((error) => {
      // Persistence failure should not interrupt a live voice session.
      log.error("failed to append testing history", {
        path: filePath,
        sessionId: session.sessionId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
}

/** Test hook: resolves when every queued history append has hit disk. */
export function flushTestingHistory(): Promise<void> {
  return persistQueue;
}

/** Filters the complete recovery archive without replacing it with the much
 * smaller in-memory gate window. Serialized with appends and atomically
 * renamed, so deleting old evidence cannot truncate unrelated old records. */
function filterTestingHistory(keep: (value: Record<string, unknown> | null) => boolean) {
  const filePath = TESTING_HISTORY_PATH;
  if (!filePath) return;
  persistQueue = persistQueue
    .then(async () => {
      await ensureTestingStorageDirectory(filePath);
      let raw = "";
      try {
        raw = await fs.promises.readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const lines = raw
        .split("\n")
        .filter((line) => line.trim())
        .filter((line) => {
          try {
            const value = JSON.parse(line) as unknown;
            return keep(isRecord(value) ? value : null);
          } catch {
            return keep(null);
          }
        });
      const tempPath = `${filePath}.rewrite`;
      await fs.promises.writeFile(tempPath, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
      await fs.promises.rename(tempPath, filePath);
      await secureTestingFile(filePath);
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
  // The evidence index is authoritative: if its transaction fails, preserve
  // the live cache so callers receive an honest failure instead of a clear
  // that reappears on the next process start.
  const removedStoredSessions = deleteStoredTesterSessions(testerKey);
  const removedTesters = testers.delete(testerKey) ? 1 : 0;
  let removedActiveSessions = 0;
  for (const [sessionId, session] of testingSessions) {
    if (session.testerKey === testerKey) {
      testingSessions.delete(sessionId);
      removedActiveSessions += 1;
    }
  }
  const before = completedSessions.length;
  for (let index = completedSessions.length - 1; index >= 0; index -= 1) {
    if (completedSessions[index]?.testerKey === testerKey) completedSessions.splice(index, 1);
  }
  const removedCachedSessions = before - completedSessions.length;
  const removedSessions = removedActiveSessions + Math.max(removedCachedSessions, removedStoredSessions);
  if (removedTesters || removedSessions) {
    filterTestingHistory((value) => {
      if (!value) return true;
      const archived = normalizeCompletedSession(value);
      return !archived || archived.testerKey !== testerKey;
    });
  }
  return { removedTesters, removedSessions };
}

/**
 * Removes one completed session from the history/replay. The owning tester's
 * lifetime aggregates are intentionally left as-is — they describe traffic
 * that did happen; use clearTesterData to reset a tester entirely.
 */
export function clearTestingSession(sessionId: string): TestingClearResult {
  ensureTestingHistoryLoaded();
  // Commit durable deletion before changing the cache for the same reason as
  // clearTesterData: an unavailable store must remain visible to the caller.
  const removedStored = deleteStoredTestingSession(sessionId);
  const index = completedSessions.findIndex((session) => session.sessionId === sessionId);
  if (index >= 0) completedSessions.splice(index, 1);
  if (index < 0 && !removedStored) return { removedTesters: 0, removedSessions: 0 };
  filterTestingHistory((value) => !value || value.sessionId !== sessionId);
  return { removedTesters: 0, removedSessions: 1 };
}

/** Removes every tester, session, transcript, and the timeline buckets. */
export function clearAllTesterData(): TestingClearResult {
  ensureTestingHistoryLoaded();
  // Do not clear recovery-visible memory unless durable deletion committed.
  const storedSessions = deleteAllStoredTestingSessions();
  const removedTesters = testers.size;
  const cachedSessions = completedSessions.length;
  const activeSessions = testingSessions.size;
  const removedSessions = activeSessions + Math.max(cachedSessions, storedSessions);
  testers.clear();
  testingSessions.clear();
  completedSessions.length = 0;
  testingTimeline.clear();
  filterTestingHistory(() => false);
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
    qualityCounts: { ...tester.qualityCounts },
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
    platform: identity.platform,
    runId: identity.runId,
    assignmentId: identity.assignmentId,
    startedAt: now,
    audioUpBytes: 0,
    audioDownBytes: 0,
    controlDownBytes: 0,
    micFrames: 0,
    serverEvents: 0,
    errorEvents: 0,
    ttsFallbacks: 0,
    latencyMs: [],
    audioQuality: {
      droppedFrames: 0,
      outgoingFps: 0,
      jitterMs: 0,
      clippingPct: 0,
      silencePct: 0
    },
    audioQualitySampleCounts: { outgoingFps: 0, jitterMs: 0, clippingPct: 0, silencePct: 0 },
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
  const summary = completedSessionSummary(session, now);
  const tester = testers.get(session.testerKey);
  if (tester) {
    tester.activeSessions = Math.max(0, tester.activeSessions - 1);
    tester.totalSessionMs += Math.max(0, now - session.startedAt);
    tester.lastSeenAt = now;
    // totalSessions was counted at session start; credit the graded quality now.
    tester.qualityCounts[summary.quality] += 1;
  }
  rememberCompletedSession(summary);
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

export function recordTesterAudioQuality(sessionId: string, input: Partial<TestingAudioQuality>, now = Date.now()) {
  const active = activeSession(sessionId, now);
  if (!active) return;
  const current = active.session.audioQuality;
  const counts = active.session.audioQualitySampleCounts;
  // Returns the clamped value, or undefined when the field is absent/invalid in
  // this update (so it doesn't count toward that field's average).
  const clamp = (value: unknown, max = Number.MAX_SAFE_INTEGER) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : undefined;
  // Roll a field's average ONLY when this update carries it, weighting by that
  // field's own sample count — a partial update must not dilute omitted fields.
  const roll = (field: keyof typeof counts, value: number | undefined) => {
    if (value === undefined) return current[field];
    const previous = counts[field];
    counts[field] = previous + 1;
    return Math.round(((current[field] * previous + value) / (previous + 1)) * 10) / 10;
  };
  active.session.audioQuality = {
    droppedFrames: Math.max(current.droppedFrames, Math.round(clamp(input.droppedFrames) ?? current.droppedFrames)),
    outgoingFps: roll("outgoingFps", clamp(input.outgoingFps, 1_000)),
    jitterMs: roll("jitterMs", clamp(input.jitterMs, 60_000)),
    clippingPct: roll("clippingPct", clamp(input.clippingPct, 100)),
    silencePct: roll("silencePct", clamp(input.silencePct, 100))
  };
  active.tester.lastSeenAt = now;
}

/** Attach a tester-reported problem to the exact relay-issued transcript turn. */
export function recordTesterTurnFeedback(
  sessionId: string,
  input: { turnId: string; speaker: TesterTranscriptTurn["speaker"]; text: string; reason: string },
  now = Date.now()
) {
  const active = activeSession(sessionId, now);
  if (!active) return;
  const { session, tester } = active;
  const reason = cleanText(input.reason).slice(0, 120);
  if (!reason) return;
  const target = [...session.turns].reverse().find((turn) => turn.turnId === input.turnId);
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

type TestingSnapshotOptions = {
  testerId?: string;
  includeSessions?: boolean;
  includeTurns?: boolean;
  includeOperations?: boolean;
};

function clonedSession(session: TesterSessionSummary, includeTurns: boolean): TesterSessionSummary {
  return {
    ...session,
    validity: { ...session.validity, reasons: [...session.validity.reasons] },
    capturedValidity: { ...session.capturedValidity, reasons: [...session.capturedValidity.reasons] },
    evaluation: { ...session.evaluation, checks: session.evaluation.checks.map((check) => ({ ...check })) },
    capturedEvaluation: {
      ...session.capturedEvaluation,
      checks: session.capturedEvaluation.checks.map((check) => ({ ...check }))
    },
    audioQuality: { ...session.audioQuality },
    flags: [...session.flags],
    turns: includeTurns ? session.turns.map((turn) => ({ ...turn })) : []
  };
}

export function testingSnapshot(now = Date.now(), options: TestingSnapshotOptions = {}): TestingStats {
  ensureTestingHistoryLoaded();
  const currentBuildSessions = completedSessionsForBuild(buildInfo.gitCommit);
  const scopedTesterId = options.testerId ? normalizeTesterId(options.testerId) : undefined;
  const users = [...testers.values()]
    .filter((tester) => !scopedTesterId || tester.testerId === scopedTesterId)
    .map(testerSnapshot)
    .sort((a, b) => {
      if (b.activeSessions !== a.activeSessions) return b.activeSessions - a.activeSessions;
      if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
      return b.totalSessions - a.totalSessions;
    });
  const scopedSessions = completedSessions.filter((session) => !scopedTesterId || session.testerId === scopedTesterId);
  const latency = users.flatMap((user) => {
    const tester = testers.get(user.testerKey);
    return tester?.latencyMs ?? [];
  });
  const validCompletedSessions = scopedSessions.filter(isDecisionGradeEvidence).length;
  const invalidCompletedSessions = scopedSessions.length - validCompletedSessions;
  return {
    windowMinutes: TESTING_WINDOW_MINUTES,
    catalog: testingCatalog(),
    history: {
      persistent: testingStorePersistent() || Boolean(TESTING_HISTORY_PATH),
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
    releaseGate: buildReleaseGate(now, currentBuildSessions),
    regression: buildRegressionSummary(currentBuildSessions),
    users,
    sessions:
      options.includeSessions === false
        ? []
        : scopedSessions.map((session) => clonedSession(session, options.includeTurns !== false)),
    timeline: timelineSnapshot(now),
    ...(options.includeOperations ? { operations: testingOperationsSnapshot() } : {})
  };
}

function decodeCursor(cursor: string | undefined): { endedAt: number; sessionId: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!isRecord(value) || typeof value.endedAt !== "number" || typeof value.sessionId !== "string") return null;
    return { endedAt: value.endedAt, sessionId: value.sessionId };
  } catch {
    return null;
  }
}

function encodeCursor(session: TesterSessionSummary): string {
  return Buffer.from(JSON.stringify({ endedAt: session.endedAt, sessionId: session.sessionId })).toString("base64url");
}

export function testingSessionPage(
  query: TestingSessionQuery = {},
  requesterTesterId?: string
): TestingSessionPage<TesterSessionSummary> {
  ensureTestingHistoryLoaded();
  const allowedTesterId = requesterTesterId ? normalizeTesterId(requesterTesterId) : undefined;

  // SQLite is the durable evidence index and can contain substantially more
  // history than the bounded in-memory release-gate window. Re-normalize rows
  // on read so policy replay and integrity checks stay current.
  try {
    const storedPage = storedTestingSessionPage(query, allowedTesterId);
    return {
      ...storedPage,
      items: storedPage.items
        .map(normalizeCompletedSession)
        .filter((session): session is TesterSessionSummary => Boolean(session))
        .map((session) => clonedSession(session, false))
    };
  } catch {
    // Keep the live, bounded cache usable if the durable index is unavailable.
  }

  const requestedLimit = typeof query.limit === "number" && Number.isFinite(query.limit) ? query.limit : 25;
  const limit = Math.max(1, Math.min(100, Math.round(requestedLimit)));
  const cursor = decodeCursor(query.cursor);
  const search = cleanText(query.search ?? "").toLowerCase();
  const filtered = completedSessions.filter((session) => {
    if (allowedTesterId && session.testerId !== allowedTesterId) return false;
    if (query.testerId && session.testerId !== normalizeTesterId(query.testerId)) return false;
    if (query.testCaseId && session.testCaseId !== query.testCaseId) return false;
    if (query.build && session.gitCommit !== query.build) return false;
    if (query.quality && session.quality !== query.quality) return false;
    if (query.platform && session.platform !== query.platform) return false;
    if (query.runId && session.runId !== query.runId) return false;
    if (
      cursor &&
      (session.endedAt > cursor.endedAt ||
        (session.endedAt === cursor.endedAt && session.sessionId >= cursor.sessionId))
    ) {
      return false;
    }
    if (search) {
      const haystack = [
        session.sessionId,
        session.testerId,
        session.testCaseName,
        session.deviceLabel,
        session.networkType,
        session.gitCommit,
        session.notes,
        ...session.flags
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
  const page = filtered.slice(0, limit);
  const lastPageItem = page.at(-1);
  return {
    items: page.map((session) => clonedSession(session, false)),
    nextCursor: filtered.length > limit && lastPageItem ? encodeCursor(lastPageItem) : undefined,
    total: filtered.length
  };
}

export function testingSessionDetail(sessionId: string, requesterTesterId?: string): TesterSessionSummary | null {
  ensureTestingHistoryLoaded();
  let session: TesterSessionSummary | null | undefined;
  try {
    const stored = loadStoredTestingSession(sessionId);
    session = stored ? normalizeCompletedSession(stored) : null;
  } catch {
    // Fall back to the live cache below.
  }
  session ??= completedSessions.find((item) => item.sessionId === sessionId);
  if (!session) return null;
  if (requesterTesterId && session.testerId !== normalizeTesterId(requesterTesterId)) return null;
  return clonedSession(session, true);
}

export function updateTestingSessionNotes(sessionId: string, notes: unknown): TesterSessionSummary | null {
  ensureTestingHistoryLoaded();
  const cachedSession = completedSessions.find((item) => item.sessionId === sessionId);
  let session = cachedSession;
  if (!session) {
    try {
      const stored = loadStoredTestingSession(sessionId);
      session = stored ? (normalizeCompletedSession(stored) ?? undefined) : undefined;
    } catch {
      // The cache fallback below still permits notes on recent evidence.
    }
  }
  if (!session) return null;
  const updated = { ...session, notes: typeof notes === "string" ? cleanText(notes).slice(0, 1_000) : "" };
  // A failed durable write is distinct from an unknown session. Let it reach
  // the typed endpoint as a 500 rather than claiming the cached note saved.
  saveTestingSession(updated);
  if (cachedSession) cachedSession.notes = updated.notes;
  return clonedSession(updated, true);
}
