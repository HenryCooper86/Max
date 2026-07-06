import type { DemoScenario, RideMode } from "./ride";

export type TestingQuality = "pass" | "watch" | "fail";
export type TestingCheckStatus = "pass" | "warn" | "fail" | "skipped";

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
};

export type TestingAgentSignalRequirement = {
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

export type TestingCatalog = {
  campaigns: TestingCampaign[];
  testCases: TestingTestCase[];
  goldenReplays: TestingGoldenReplay[];
};

export type TestingGoldenReplayTurn = {
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

export const TESTING_CAMPAIGNS: TestingCampaign[] = [
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

export const TESTING_TEST_CASES: TestingTestCase[] = [
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
    maxFirstResponseMs: 8_000
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
    maxFirstResponseMs: 8_000
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
    maxFirstResponseMs: 9_000
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
    minAgentTurns: 1
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
