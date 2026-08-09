import type { AdasDirection, AdasSeverity, AdasThreat } from "./adas";
// Type-only: device-action types originate in server/device-actions.ts and flow
// outward. The import is erased at build time, so this adds no runtime coupling.
import type { DeviceActionName, DeviceActionStatus, DeviceActionTier } from "../server/device-actions";
import type { DemoScenario, RideIntelligence, RideMode } from "./ride";
import type {
  TestingAudioQuality,
  TestingCatalog,
  TestingEvaluationSummary,
  TestingOperationsSnapshot,
  TestingPlatform,
  TestingQuality,
  TestingRegressionSummary,
  TestingReleaseGate,
  TestingValiditySummary
} from "./testing";

export type VoiceGender = "female" | "male";
export type VoicePersonality = "concise" | "friendly" | "technical" | "rally";
export type ConnectionState = "offline" | "connecting" | "relay" | "provider" | "ready" | "degraded";
type ProviderMode = "mock" | "live";
type NetworkState = "online" | "degraded" | "offline";
export type HazardLevel = RideIntelligence["hazardLevel"];

/** Truthful outcome of relay-side crash escalation. "unconfigured" covers
 *  both "no SMS channel" and "rider didn't opt in" — nobody was texted. */
export type CrashAckStatus = "notified" | "failed" | "unconfigured";

export type TesterTranscriptTurn = {
  sessionId: string;
  /** Stable relay-issued identity for one logical rider/agent turn. */
  turnId?: string;
  /** Stable identity for the corresponding speech delivery. */
  deliveryId?: string;
  at: number;
  speaker: "rider" | "agent";
  text: string;
  final: boolean;
  /** Tester-reported problem with this turn (e.g. 回答不对) — set via the
   *  `turn.feedback` client event, surfaced in the admin session replay. */
  feedback?: string;
};

export type TesterSessionSummary = {
  sessionId: string;
  testerKey: string;
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
  endedAt: number;
  durationMs: number;
  audioUpBytes: number;
  audioDownBytes: number;
  controlDownBytes: number;
  micFrames: number;
  serverEvents: number;
  latencySamples: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  /**
   * Bounded raw per-turn latency samples, kept so build/gate/cohort p95 can be a
   * TRUE pooled percentile instead of a percentile-of-per-session-p95s (which, at
   * QA sample sizes, collapses to the single worst session). Optional: sessions
   * captured before this field fall back to their p95LatencyMs.
   */
  latencyMsSamples?: number[];
  errorEvents: number;
  ttsFallbacks: number;
  quality: TestingQuality;
  validity: TestingValiditySummary;
  flags: string[];
  notes: string;
  policyVersion: string;
  evidenceHash: string;
  evidenceIntegrity: "verified" | "legacy" | "mismatch";
  capturedEvaluation: TestingEvaluationSummary;
  capturedValidity: TestingValiditySummary;
  audioQuality: TestingAudioQuality;
  evaluation: TestingEvaluationSummary;
  turns: TesterTranscriptTurn[];
};

export type ProviderCapabilities = {
  serverVad: boolean;
  synthesizedAudio: boolean;
  transcriptEvents: boolean;
  bargeIn: boolean;
  voiceSelection: boolean;
  weatherContext: boolean;
  sessionMemory: boolean;
  emergencyMode: boolean;
};

export type TesterStats = {
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
  latencySamples: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  errorEvents: number;
  ttsFallbacks: number;
  /**
   * Server-aggregated pass/watch/fail counts across ALL of this tester's graded
   * sessions. The admin table must read these, not re-derive them from the
   * paginated session page (which under-counts and disagrees with totalSessions).
   */
  qualityCounts: Record<TestingQuality, number>;
  lastSeenAt: number;
  recentTurns: TesterTranscriptTurn[];
};

export type TestingTimelineBucket = {
  at: number;
  sessionsStarted: number;
  audioUpBytes: number;
  audioDownBytes: number;
  controlDownBytes: number;
  latencySamples: number;
  avgLatencyMs: number;
  errorEvents: number;
};

export type TestingStats = {
  windowMinutes: number;
  catalog: TestingCatalog;
  history: {
    persistent: boolean;
    maxSessions: number;
    maxTranscriptTurnsPerTester: number;
    maxTranscriptTurnsPerSession: number;
  };
  totals: {
    activeTestSessions: number;
    totalTestSessions: number;
    audioUpBytes: number;
    audioDownBytes: number;
    controlDownBytes: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    errorEvents: number;
    ttsFallbacks: number;
    validTestSessions: number;
    invalidTestSessions: number;
  };
  releaseGate: TestingReleaseGate;
  regression: TestingRegressionSummary;
  users: TesterStats[];
  sessions: TesterSessionSummary[];
  timeline: TestingTimelineBucket[];
  operations?: TestingOperationsSnapshot;
};

/**
 * Session-memory snapshot a client may echo back in `session.start` — the
 * fields of the last `session.memory` event it received. Settings changes
 * (voice, personality, mode) restart the relay session; without this the
 * agent's short-term memory (destination, intent, language preference) would
 * reset with every toggle.
 */
export type SessionMemorySnapshot = {
  language?: "zh" | "en";
  destination?: string;
  lastIntent?: string;
  responseMode?: "concise" | "normal" | "emergency";
};

export type SessionStartEvent = {
  type: "session.start";
  sampleRate: number;
  channels: number;
  /** Canonical identity of an RDK helmet, when this is an embedded session. */
  deviceId?: string;
  /** Human-readable tester/workstation identifier for QA statistics. */
  testerId?: string;
  /** Client-reported region/time zone label for QA attribution. */
  testerRegion?: string;
  /** QA campaign selected by the tester. */
  testingCampaignId?: string;
  /** QA test case selected by the tester. */
  testingTestCaseId?: string;
  /** Release-run assignment supplied by the QA control plane. */
  testingRunId?: string;
  testingAssignmentId?: string;
  /** Build metadata for release comparison. */
  appVersion?: string;
  gitCommit?: string;
  /** Browser/device metadata for issue reports. */
  deviceLabel?: string;
  browserLanguage?: string;
  networkType?: string;
  platform?: TestingPlatform;
  voiceGender?: VoiceGender;
  voicePersonality?: VoicePersonality;
  rideMode?: RideMode;
  scenario?: DemoScenario;
  lat?: number;
  lon?: number;
  memory?: SessionMemorySnapshot;
};

/** Client → server: the outcome of one device command. Exactly one of these
 *  follows every command; the relay treats silence past its timeout as failure. */
export type DeviceResultEvent = {
  type: "device.result";
  commandId: string;
  status: DeviceActionStatus;
  reason?: string;
  detail?: string;
};

export type ClientEvent =
  | SessionStartEvent
  | DeviceResultEvent
  // A hazard the embedded board detected and already announced. Upward only:
  // the board plays the audio itself from a local clip, so the relay must never
  // echo this back as `hazard.alert` — Max would speak the warning a second
  // time, seconds late, over a rider who is already braking.
  //
  // `ttcSeconds` is measured rather than catalogued and `handoverMs` is
  // hazard-event to playback-handover; the audible alert finishes later
  // (pacing meters it out at 80 ms a cycle), so this is a plumbing metric,
  // not time-to-audible. The simulated `hazard.alert` carries neither,
  // because a simulation has neither.
  | {
      type: "hazard.report";
      threat: string;
      direction: string;
      severity: AdasSeverity;
      label: string;
      message: string;
      advice: string;
      ttcSeconds?: number;
      handoverMs?: number;
    }
  | { type: "audio.start" }
  | { type: "audio.stop" }
  // Guided demo ride: the mock provider auto-advances through the scenario
  // catalog so a hands-off demo shows every capability. Live provider ignores it.
  | { type: "demo.guided"; enabled: boolean }
  // Mid-ride rider position update. The session-start coordinates go stale
  // fast on a moving motorcycle; this keeps the live weather (and any future
  // location-aware context) tracking the rider. Clients throttle sends.
  | { type: "location.update"; lat: number; lon: number }
  // Client-side audio-pipeline quality. This is aggregate telemetry only; raw
  // microphone audio remains opt-in and is never retained by this event.
  | {
      type: "testing.metric";
      droppedFrames?: number;
      outgoingFps?: number;
      jitterMs?: number;
      clippingPct?: number;
      silencePct?: number;
    }
  // Tester flags a transcript turn as problematic. The relay-issued turnId
  // selects the exact server-side turn; speaker/text remain useful evidence.
  | { type: "turn.feedback"; turnId: string; speaker: "rider" | "agent"; text: string; reason: string }
  // One frame the rider asked Max to look at, in response to a `camera.look`
  // device command. `image` is base64 JPEG, size-capped in validation — the
  // control plane is not a bulk media channel.
  | { type: "camera.frame"; commandId: string; image: string }
  | {
      // Client → server: the phone's crash detector escalated. lat/lon are
      // present only when a GPS fix existed; contactNumber only when the
      // rider opted in to relay escalation (the one privacy carve-out).
      type: "crash.alert";
      incidentId: string;
      lat?: number;
      lon?: number;
      speedKmhRecent?: number;
      contactNumber?: string;
      contactOptIn: boolean;
      detectedAt?: number;
    }
  | {
      // Client → server: the rider cancelled after escalation — the relay
      // sends the false-alarm follow-up so the contact stops worrying.
      type: "crash.cancel";
      incidentId: string;
    }
  | NavRequestEvent
  | NavPromptEvent
  | VisionFramesEvent;

export type NavManeuver = { instruction: string; lat: number; lon: number; alongRouteMeters: number };

/** Client → server: ask the relay to route the rider. `origin` and, when
 *  present, `destination` are GCJ-02, like every nav.* coordinate. */
export type NavRequestEvent = {
  type: "nav.request";
  commandId: string;
  reason: "start" | "reroute";
  /** GCJ-02, like every nav.* coordinate. */
  origin: { lat: number; lon: number };
  /** reason "start": the spoken destination phrase. */
  query?: string;
  /** reason "reroute": the destination nav.route previously announced. */
  destination?: { lat: number; lon: number };
  destinationName?: string;
};

/** Client → server: a deterministic navigation prompt selected by the helmet.
 *  The relay accepts no arbitrary speech through this event. */
export type NavPromptEvent =
  | {
      type: "nav.prompt";
      promptId: string;
      routeCommandId: string;
      kind: "maneuver";
      maneuverIndex: number;
      threshold: "far" | "near" | "now";
      distanceMeters: number;
    }
  | {
      type: "nav.prompt";
      promptId: string;
      routeCommandId: string;
      kind: "offRoute" | "rerouteFailed" | "arrived" | "locationLost";
    };

/** Client → server: one chunk of a multi-frame gallery understanding request,
 *  or one unsolicited scene-watching frame. Gallery frames carry the
 *  `commandId` of the `gallery.describe` they answer, with `total` frames
 *  arriving as separate `vision.frames` events sharing that `commandId`,
 *  `index` order 0..total-1, and `question` only on the chunk that carries
 *  the rider's spoken prompt. Watch frames are unsolicited and carry none of
 *  that: no `commandId`, no `question`, always a single frame
 *  (`index: 0, total: 1`). */
export type VisionFramesEvent = {
  type: "vision.frames";
  /** Present for "gallery", absent for "watch". */
  commandId?: string;
  reason: "gallery" | "watch";
  index: number;
  total: number;
  image: string;
  question?: string;
};

/** Server → client: the relay resolved a `nav.request` into a route.
 *  Every coordinate here is GCJ-02, like every nav.* coordinate. */
export type NavRouteEvent = {
  type: "nav.route";
  commandId: string;
  destinationName: string;
  destination: { lat: number; lon: number };
  distanceMeters: number;
  etaSeconds: number;
  polyline: Array<{ lat: number; lon: number }>;
  steps: NavManeuver[];
};

/** Server → client: the relay could not resolve or route a `nav.request`. */
export type NavErrorEvent = {
  type: "nav.error";
  commandId: string;
  code: "destination.notFound" | "route.unavailable";
};

export type CompanionPairingEvent = {
  type: "companion.pairing";
  code: string;
  expiresAt: number;
  paired: boolean;
};

export type PhoneLocationEvent = {
  type: "phone.location";
  sequence: number;
  lat: number;
  lon: number;
  horizontalAccuracyMeters: number;
  timestamp: number;
  courseDegrees?: number;
  speedMps?: number;
};

export type PhoneLocationStatusEvent = {
  type: "phone.location.status";
  state: "connected" | "sharing" | "stopped" | "stale" | "unpaired";
};

export type AgentEvent =
  | {
      type: "session.started";
      provider: string;
      mode: ProviderMode;
      capabilities: ProviderCapabilities;
    }
  | { type: "connection"; state: ConnectionState; detail: string }
  | { type: "status"; state: string; detail: string }
  | {
      type: "transcript";
      turnId: string;
      deliveryId: string;
      speaker: "rider" | "agent";
      text: string;
      final?: boolean;
      useBrowserSpeech?: boolean;
    }
  | { type: "metric"; latencyMs: number; droppedFrames?: number; outgoingFps?: number }
  | {
      type: "weather";
      description: string;
      temperatureC: number;
      windSpeedKmh: number;
      isDay: boolean;
      riskLevel?: HazardLevel;
      riderAdvice?: string;
    }
  | {
      type: "ride.context";
      mode: RideMode;
      modeLabel: string;
      scenario: DemoScenario;
      scenarioLabel: string;
      speedKmh?: number;
      routePhase?: string;
      network?: NetworkState;
      batteryPct?: number;
      hazardLevel: HazardLevel;
      glanceableFocus: string;
    }
  | {
      type: "session.memory";
      language: "zh" | "en";
      destination?: string;
      lastIntent?: string;
      responseMode: "concise" | "normal" | "emergency";
    }
  | {
      type: "telemetry";
      asrMs: number;
      thinkMs: number;
      firstAudioMs: number;
      totalMs: number;
    }
  | {
      // A proactive ADAS safety alert. `interrupt` tells the client to cut any
      // in-progress agent speech so the warning is heard immediately.
      type: "hazard.alert";
      threat: AdasThreat;
      direction: AdasDirection;
      severity: AdasSeverity;
      label: string;
      message: string;
      advice: string;
      ttcSeconds: number;
      interrupt: boolean;
    }
  | {
      // Server → client: execute one device action. `commandId` is relay-issued
      // and must be echoed back in the matching `device.result`.
      type: "device.command";
      commandId: string;
      action: DeviceActionName;
      args: Record<string, unknown>;
      tier: DeviceActionTier;
    }
  | { type: "error"; message: string }
  | {
      // Server → client: the real outcome of crash escalation. Max only
      // claims the contact was notified when status is "notified".
      type: "crash.ack";
      incidentId: string;
      status: CrashAckStatus;
      detail?: string;
    }
  | {
      // Server → client (mock scenarios only): rehearse the crash flow by
      // promoting the client's detector straight to check-in. The embedded
      // board never receives this (it detects for real).
      type: "crash.simulate";
    }
  | CompanionPairingEvent
  | PhoneLocationEvent
  | PhoneLocationStatusEvent
  | NavRouteEvent
  | NavErrorEvent;

export type AgentHealth = {
  ok: boolean;
  provider: string;
  uptimeSec: number;
  credentials: "configured" | "missing" | "not-required";
  weather: "available";
  capabilities: ProviderCapabilities;
  /** Relay counters since startup (see server/metrics.ts); absent on old relays. */
  metrics?: Record<string, number>;
  /** Counter deltas over the trailing window (server/metrics.ts metricsWindow). */
  metricsWindow?: Record<string, number>;
  /** User-account status: auth turns on once the first user registers. */
  auth?: { enabled: boolean; registrationOpen: boolean };
  /** Relay build identity (deploy stamps build-info.json); absent on old relays. */
  build?: { appVersion: string; gitCommit: string; deployedAt?: string };
  /** Per-tester QA statistics and recent bandwidth/latency graph data. */
  testing?: TestingStats;
};

/**
 * WebSocket close code the relay uses when it closes an idle session (see
 * server/watchdog.ts). Clients must treat it as an intentional close and NOT
 * auto-reconnect — reconnecting would immediately re-open the upstream session
 * the idle timeout just freed. Mirrored by the iOS/Android clients.
 */
export const IDLE_CLOSE_CODE = 4001;

export const MOCK_CAPABILITIES: ProviderCapabilities = {
  serverVad: true,
  synthesizedAudio: false,
  transcriptEvents: true,
  bargeIn: true,
  voiceSelection: true,
  weatherContext: true,
  sessionMemory: true,
  emergencyMode: true
};

export const DOUBAO_CAPABILITIES: ProviderCapabilities = {
  serverVad: true,
  synthesizedAudio: true,
  transcriptEvents: true,
  bargeIn: true,
  voiceSelection: true,
  weatherContext: true,
  sessionMemory: true,
  emergencyMode: true
};

export function providerCapabilities(provider: string): ProviderCapabilities {
  return provider === "doubao" ? DOUBAO_CAPABILITIES : MOCK_CAPABILITIES;
}
