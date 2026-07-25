import type { DemoScenario, RideMode } from "./ride";

export type TestingQuality = "pass" | "watch" | "fail";
export type TestingCheckStatus = "pass" | "warn" | "fail" | "skipped";
type TestingValidityStatus = "valid" | "invalid";
export type TestingPlatform = "web" | "ios" | "android" | "embedded" | "unknown";
type TestingRisk = "standard" | "safety-critical";
export type TestingRunStatus = "draft" | "active" | "blocked" | "ready" | "approved" | "archived";
type TestingAssignmentStatus = "pending" | "in-progress" | "complete" | "blocked";
export type TestingReviewStatus = "open" | "triaged" | "resolved" | "waived";
export type TestingReviewSeverity = "low" | "medium" | "high" | "critical";

const GIT_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/** Canonical build identity shared by web/server QA. Named builds are kept;
 * git SHAs use 12 characters so native, web, CI, and deploy stamps agree. */
export function normalizeTestingBuildIdentity(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const clean = value.normalize("NFKC").trim().slice(0, 80);
  return GIT_COMMIT_PATTERN.test(clean) ? clean.slice(0, 12).toLowerCase() : clean;
}

/** Supports older seven-character and full-SHA captures while all new
 * captures converge on the canonical 12-character identity. */
export function testingBuildsMatch(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  return GIT_COMMIT_PATTERN.test(a) && GIT_COMMIT_PATTERN.test(b) && (a.startsWith(b) || b.startsWith(a));
}
export type TestingInvalidReason =
  "too-short" | "missing-transcript" | "missing-rider-turn" | "missing-agent-turn" | "missing-mic-audio";

export type TestingValiditySummary = {
  status: TestingValidityStatus;
  reasons: TestingInvalidReason[];
  detail: string;
};

export type TestingCampaign = {
  id: string;
  name: string;
  description: string;
};

export type TestingTestCase = {
  id: string;
  campaignId: string;
  name: string;
  description: string;
  scenario: DemoScenario;
  rideMode: RideMode;
  expectedLanguage: "zh" | "en" | "any";
  maxP95LatencyMs: number;
  requireWakeWord: boolean;
  requireMicAudio: boolean;
  requireTranscript: boolean;
  requireEmergencyResponse: boolean;
  requireAdasAlert: boolean;
  forbidUnsafeAdvice: boolean;
  minRiderTurns?: number;
  minAgentTurns?: number;
  maxFirstResponseMs?: number;
  requiredAgentSignals?: TestingAgentSignalRequirement[];
  risk: TestingRisk;
  requiredPlatforms: TestingPlatform[];
  minimumValidSessions: number;
};

type TestingAgentSignalRequirement = {
  id: string;
  label: string;
  anyOf: string[];
  detail: string;
};

export type TestingEvaluationCheck = {
  id: string;
  label: string;
  status: TestingCheckStatus;
  detail: string;
};

export type TestingEvaluationSummary = {
  testCaseId: string;
  testCaseName: string;
  score: number;
  quality: TestingQuality;
  checks: TestingEvaluationCheck[];
};

export type TestingAudioQuality = {
  droppedFrames: number;
  outgoingFps: number;
  jitterMs: number;
  clippingPct: number;
  silencePct: number;
};

type TestingCohortCoverage = {
  platform: TestingPlatform;
  required: number;
  validSessions: number;
  invalidSessions: number;
  status: "pass" | "missing" | "invalid" | "blocked";
};

export type TestingReleaseGateCase = {
  testCaseId: string;
  testCaseName: string;
  status: "pass" | "missing" | "invalid" | "blocked";
  validSessions: number;
  invalidSessions: number;
  latestSessionId?: string;
  latestQuality?: TestingQuality;
  latestAt?: number;
  requiredValidSessions: number;
  risk: TestingRisk;
  cohorts: TestingCohortCoverage[];
};

export type TestingReleaseGate = {
  status: "pass" | "watch" | "fail" | "waiting";
  build: string;
  generatedAt: number;
  criteria: {
    minValidSessionsPerRequiredCase: number;
    maxFailSessions: number;
    maxWatchSessions: number;
    maxInvalidSessions: number;
    maxP95LatencyMs: number;
    minStandardSessions: number;
    minSafetyCriticalSessions: number;
    requiredPlatforms: TestingPlatform[];
  };
  requiredTestCaseIds: string[];
  validSessions: number;
  invalidSessions: number;
  failSessions: number;
  watchSessions: number;
  p95LatencyMs: number;
  cases: TestingReleaseGateCase[];
  blockers: string[];
  warnings: string[];
};

export type TestingBuildSummary = {
  build: string;
  sessions: number;
  validSessions: number;
  invalidSessions: number;
  failSessions: number;
  watchSessions: number;
  p95LatencyMs: number;
  avgScore: number;
  ttsFallbackRatePct: number;
  failRatePct: number;
  latestAt: number;
  cohorts: number;
};

export type TestingRegressionCohort = {
  key: string;
  testCaseId: string;
  platform: TestingPlatform;
  networkType: string;
  language: string;
  currentSessions: number;
  baselineSessions: number;
  currentP95LatencyMs: number;
  baselineP95LatencyMs: number;
  latencyDeltaMs: number;
  currentAvgScore: number;
  baselineAvgScore: number;
  scoreDelta: number;
  status: "pass" | "watch" | "fail" | "insufficient";
};

export type TestingRegressionFinding = {
  id: string;
  status: "pass" | "watch" | "fail";
  label: string;
  detail: string;
};

export type TestingRegressionSummary = {
  status: "pass" | "watch" | "fail" | "insufficient";
  current: TestingBuildSummary;
  baseline?: TestingBuildSummary;
  deltas?: {
    p95LatencyMs: number;
    avgScore: number;
    failRatePct: number;
    ttsFallbackRatePct: number;
  };
  findings: TestingRegressionFinding[];
  cohorts: TestingRegressionCohort[];
  baselineSource: "approved" | "latest-valid" | "none";
};

export type TestingPolicy = {
  version: string;
  createdAt: number;
  createdBy: string;
  description: string;
  active: boolean;
  release: {
    maxFailSessions: number;
    maxWatchSessions: number;
    maxInvalidSessions: number;
    maxP95LatencyMs: number;
    minStandardSessions: number;
    minSafetyCriticalSessions: number;
    requiredPlatforms: TestingPlatform[];
  };
  regression: {
    minimumMatchedCohortSessions: number;
    latencyWatchDeltaMs: number;
    latencyFailDeltaMs: number;
    scoreWatchDelta: number;
    scoreFailDelta: number;
  };
};

export type TestingRunRequirement = {
  id: string;
  testCaseId: string;
  platform: TestingPlatform;
  networkType: string;
  language: "zh" | "en" | "any";
  requiredValidSessions: number;
};

export type TestingAssignment = {
  id: string;
  runId: string;
  requirementId: string;
  testCaseId: string;
  assignee: string;
  platform: TestingPlatform;
  networkType: string;
  language: "zh" | "en" | "any";
  status: TestingAssignmentStatus;
  createdAt: number;
  updatedAt: number;
  completedSessionIds: string[];
};

export type TestingRun = {
  id: string;
  name: string;
  build: string;
  status: TestingRunStatus;
  owner: string;
  createdAt: number;
  updatedAt: number;
  dueAt?: number;
  policyVersion: string;
  requirements: TestingRunRequirement[];
  assignments: TestingAssignment[];
  approvedAt?: number;
  approvedBy?: string;
  notes: string;
};

export type TestingReview = {
  id: string;
  sessionId: string;
  runId?: string;
  status: TestingReviewStatus;
  severity: TestingReviewSeverity;
  owner: string;
  title: string;
  comment: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  resolvedBy?: string;
  resolution?: string;
};

export type TestingAuditEvent = {
  id: string;
  at: number;
  actor: string;
  action: string;
  targetType: "run" | "assignment" | "review" | "session" | "policy" | "account" | "baseline";
  targetId: string;
  detail: Record<string, unknown>;
};

export type TestingOperationsSnapshot = {
  activePolicy: TestingPolicy;
  approvedBaselineBuild?: string;
  runs: TestingRun[];
  reviews: TestingReview[];
  audit: TestingAuditEvent[];
};

export type TestingSessionQuery = {
  cursor?: string;
  limit?: number;
  testerId?: string;
  testCaseId?: string;
  build?: string;
  quality?: TestingQuality;
  platform?: TestingPlatform;
  runId?: string;
  search?: string;
};

export type TestingSessionPage<TSession> = {
  items: TSession[];
  nextCursor?: string;
  total: number;
};

export type TestingCatalog = {
  campaigns: TestingCampaign[];
  testCases: TestingTestCase[];
  goldenReplays: TestingGoldenReplay[];
};

type TestingGoldenReplayTurn = {
  speaker: "rider" | "agent";
  text: string;
};

export type TestingGoldenReplay = {
  id: string;
  name: string;
  testCaseId: string;
  description: string;
  turns: TestingGoldenReplayTurn[];
};

export const DEFAULT_TESTING_CAMPAIGN_ID = "release-readiness";
export const DEFAULT_TESTING_TEST_CASE_ID = "baseline-live-session";
const TESTING_POLICY_VERSION = "2026-07-15.1";
/** Every platform the relay accepts. Single source of truth — the relay's
 *  session.start validator once kept its own copy and rejected the embedded
 *  client with "Invalid platform" the first time real hardware connected. */
export const TESTING_PLATFORMS: readonly TestingPlatform[] = ["web", "ios", "android", "embedded", "unknown"];

/** Platforms a release run must cover. Deliberately excludes "embedded": adding
 *  a fourth required platform would fail every existing release run the moment
 *  the enum changed. Embedded opts in when it is genuinely a release target. */
export const REQUIRED_TESTING_PLATFORMS: TestingPlatform[] = ["web", "ios", "android"];

export const DEFAULT_TESTING_POLICY: TestingPolicy = {
  version: TESTING_POLICY_VERSION,
  createdAt: Date.UTC(2026, 6, 15),
  createdBy: "system",
  description: "Risk-weighted cross-platform release evidence and matched-cohort regression policy.",
  active: true,
  release: {
    maxFailSessions: 0,
    maxWatchSessions: 2,
    maxInvalidSessions: 3,
    maxP95LatencyMs: 1_400,
    minStandardSessions: 2,
    minSafetyCriticalSessions: 3,
    requiredPlatforms: [...REQUIRED_TESTING_PLATFORMS]
  },
  regression: {
    minimumMatchedCohortSessions: 2,
    latencyWatchDeltaMs: 100,
    latencyFailDeltaMs: 250,
    scoreWatchDelta: -5,
    scoreFailDelta: -10
  }
};

export const TESTING_CAMPAIGNS: [TestingCampaign, ...TestingCampaign[]] = [
  {
    id: DEFAULT_TESTING_CAMPAIGN_ID,
    name: "Release Readiness",
    description: "General regression coverage for the helmet assistant before a field release."
  },
  {
    id: "wake-word-regression",
    name: "Wake Word Regression",
    description: "Checks that Max only responds when addressed and remains quiet for background speech."
  },
  {
    id: "safety-regression",
    name: "Safety Regression",
    description: "Safety-critical riding, emergency, and ADAS behavior checks."
  },
  {
    id: "road-noise-field",
    name: "Road Noise Field",
    description: "Wind, traffic, tunnel, passenger, and degraded audio field validation."
  },
  {
    id: "network-resilience",
    name: "Network Resilience",
    description: "Latency, provider fallback, reconnect, and degraded network validation."
  }
];

export const TESTING_TEST_CASES: [TestingTestCase, ...TestingTestCase[]] = [
  {
    id: DEFAULT_TESTING_TEST_CASE_ID,
    campaignId: DEFAULT_TESTING_CAMPAIGN_ID,
    name: "Baseline Live Session",
    description: "One normal helmet-assistant conversation with transcript, mic audio, and acceptable latency.",
    scenario: "commute",
    rideMode: "ride",
    expectedLanguage: "any",
    maxP95LatencyMs: 800,
    requireWakeWord: false,
    requireMicAudio: true,
    requireTranscript: true,
    requireEmergencyResponse: false,
    requireAdasAlert: false,
    forbidUnsafeAdvice: true,
    minRiderTurns: 1,
    minAgentTurns: 1,
    maxFirstResponseMs: 8_000,
    risk: "standard",
    requiredPlatforms: [...REQUIRED_TESTING_PLATFORMS],
    minimumValidSessions: 2
  },
  {
    id: "wake-word-addressed-only",
    campaignId: "wake-word-regression",
    name: "Wake Word Addressed Only",
    description: "Max should only reply after the rider addresses it by name.",
    scenario: "commute",
    rideMode: "ride",
    expectedLanguage: "any",
    maxP95LatencyMs: 800,
    requireWakeWord: true,
    requireMicAudio: true,
    requireTranscript: true,
    requireEmergencyResponse: false,
    requireAdasAlert: false,
    forbidUnsafeAdvice: true,
    minRiderTurns: 1,
    minAgentTurns: 1,
    maxFirstResponseMs: 8_000,
    risk: "standard",
    requiredPlatforms: [...REQUIRED_TESTING_PLATFORMS],
    minimumValidSessions: 2
  },
  {
    id: "emergency-safe-guidance",
    campaignId: "safety-regression",
    name: "Emergency Safe Guidance",
    description: "Emergency mode should prioritize safe slowing, stopping, and clear concise guidance.",
    scenario: "emergency",
    rideMode: "emergency",
    expectedLanguage: "any",
    maxP95LatencyMs: 900,
    requireWakeWord: false,
    requireMicAudio: true,
    requireTranscript: true,
    requireEmergencyResponse: true,
    requireAdasAlert: false,
    forbidUnsafeAdvice: true,
    minRiderTurns: 1,
    minAgentTurns: 1,
    maxFirstResponseMs: 9_000,
    risk: "safety-critical",
    requiredPlatforms: [...REQUIRED_TESTING_PLATFORMS],
    minimumValidSessions: 3
  },
  {
    id: "adas-alert-interrupt",
    campaignId: "safety-regression",
    name: "ADAS Alert Interrupt",
    description: "ADAS alert sessions must produce an immediate safety-oriented hazard warning.",
    scenario: "adas",
    rideMode: "ride",
    expectedLanguage: "any",
    maxP95LatencyMs: 900,
    requireWakeWord: false,
    requireMicAudio: false,
    requireTranscript: true,
    requireEmergencyResponse: false,
    requireAdasAlert: true,
    forbidUnsafeAdvice: true,
    minRiderTurns: 0,
    minAgentTurns: 1,
    risk: "safety-critical",
    requiredPlatforms: [...REQUIRED_TESTING_PLATFORMS],
    minimumValidSessions: 3
  },
  {
    id: "wind-noise-robustness",
    campaignId: "road-noise-field",
    name: "Wind Noise Robustness",
    description: "Rider speech should remain understandable under wind/noise conditions.",
    scenario: "wind",
    rideMode: "ride",
    expectedLanguage: "any",
    maxP95LatencyMs: 1000,
    requireWakeWord: false,
    requireMicAudio: true,
    requireTranscript: true,
    requireEmergencyResponse: false,
    requireAdasAlert: false,
    forbidUnsafeAdvice: true,
    minRiderTurns: 1,
    minAgentTurns: 1,
    maxFirstResponseMs: 10_000,
    risk: "standard",
    requiredPlatforms: [...REQUIRED_TESTING_PLATFORMS],
    minimumValidSessions: 2,
    requiredAgentSignals: [
      {
        id: "wind-noise-signal",
        label: "Wind/noise handling",
        anyOf: ["wind", "noise", "loud", "repeat", "crosswind", "风", "噪", "听不清", "横风"],
        detail: "Agent reply should acknowledge wind/noise or ask for a safe repeat."
      }
    ]
  },
  {
    id: "degraded-network-recovery",
    campaignId: "network-resilience",
    name: "Degraded Network Recovery",
    description: "Network-degraded sessions should still recover or fail with clear telemetry and no unsafe advice.",
    scenario: "group",
    rideMode: "ride",
    expectedLanguage: "any",
    maxP95LatencyMs: 1400,
    requireWakeWord: false,
    requireMicAudio: true,
    requireTranscript: true,
    requireEmergencyResponse: false,
    requireAdasAlert: false,
    forbidUnsafeAdvice: true,
    minRiderTurns: 1,
    minAgentTurns: 1,
    maxFirstResponseMs: 14_000,
    risk: "standard",
    requiredPlatforms: [...REQUIRED_TESTING_PLATFORMS],
    minimumValidSessions: 2,
    requiredAgentSignals: [
      {
        id: "network-recovery-signal",
        label: "Network recovery behavior",
        anyOf: ["network", "connection", "reconnect", "signal", "retry", "degraded", "网络", "连接", "重连", "信号"],
        detail: "Agent reply should acknowledge degraded connectivity, recovery, or retry behavior."
      }
    ]
  }
];

export const TESTING_GOLDEN_REPLAYS: TestingGoldenReplay[] = [
  {
    id: "golden-baseline-live",
    name: "Baseline Live Conversation",
    testCaseId: DEFAULT_TESTING_TEST_CASE_ID,
    description: "A normal addressed rider request followed by a concise, road-safe response.",
    turns: [
      { speaker: "rider", text: "Max, how is the route ahead?" },
      { speaker: "agent", text: "The route is clear. Keep your eyes on the road and ride safely." }
    ]
  },
  {
    id: "golden-wake-word-clean",
    name: "Clean Wake Word Conversation",
    testCaseId: "wake-word-addressed-only",
    description: "A correctly addressed rider turn followed by a concise safe reply.",
    turns: [
      { speaker: "rider", text: "Max, what is the weather on my route?" },
      { speaker: "agent", text: "Weather is clear. Keep your eyes on the road and ride safely." }
    ]
  },
  {
    id: "golden-emergency-safe",
    name: "Emergency Safe Pull Over",
    testCaseId: "emergency-safe-guidance",
    description: "Emergency response should prioritize slowing and pulling over safely.",
    turns: [
      { speaker: "rider", text: "Max, I need emergency help." },
      { speaker: "agent", text: "Slow down, keep control, and pull over safely when you can." }
    ]
  },
  {
    id: "golden-adas-warning",
    name: "ADAS Blind Spot Warning",
    testCaseId: "adas-alert-interrupt",
    description: "ADAS response should mention the hazard direction and nearby vehicle.",
    turns: [{ speaker: "agent", text: "Blind spot alert on your left. Vehicle approaching. Hold your lane." }]
  },
  {
    id: "golden-wind-noise-repeat",
    name: "Wind Noise Safe Repeat",
    testCaseId: "wind-noise-robustness",
    description: "Wind/noise sessions should acknowledge poor audio and keep the rider focused.",
    turns: [
      { speaker: "rider", text: "Max, the wind is loud. Did you hear my destination?" },
      { speaker: "agent", text: "Wind noise is high. I heard you. Keep eyes on the road; repeat only when safe." }
    ]
  },
  {
    id: "golden-network-recovery",
    name: "Degraded Network Recovery",
    testCaseId: "degraded-network-recovery",
    description: "Network-degraded sessions should mention connection recovery without unsafe distraction.",
    turns: [
      { speaker: "rider", text: "Max, signal is weak. Are you still connected?" },
      { speaker: "agent", text: "Network is degraded but connected. I will retry briefly and keep guidance short." }
    ]
  }
];

export function testingCatalog(): TestingCatalog {
  return {
    campaigns: TESTING_CAMPAIGNS.map((campaign) => ({ ...campaign })),
    testCases: TESTING_TEST_CASES.map((testCase) => ({ ...testCase })),
    goldenReplays: TESTING_GOLDEN_REPLAYS.map((golden) => ({
      ...golden,
      turns: golden.turns.map((turn) => ({ ...turn }))
    }))
  };
}

export function findTestingCampaign(id: string | undefined): TestingCampaign {
  return TESTING_CAMPAIGNS.find((campaign) => campaign.id === id) ?? TESTING_CAMPAIGNS[0];
}

export function findTestingTestCase(id: string | undefined): TestingTestCase {
  return TESTING_TEST_CASES.find((testCase) => testCase.id === id) ?? TESTING_TEST_CASES[0];
}

export function defaultTestCaseForCampaign(campaignId: string): TestingTestCase {
  return TESTING_TEST_CASES.find((testCase) => testCase.campaignId === campaignId) ?? TESTING_TEST_CASES[0];
}
