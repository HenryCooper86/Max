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

/**
 * Version of the wire protocol. It goes up only for a change that is not
 * backwards compatible; new optional fields and new message types leave it
 * alone, because both sides ignore what they do not know. A client sends its
 * version in `session.start`, the relay answers with its own in
 * `session.started`, and each side warns when the other is ahead.
 */
export const PROTOCOL_VERSION = 1;

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
  /** The backend can call tools (server tools and client tools). Absent on
   *  relays older than tool support. */
  tools?: boolean;
  /** The session accepts typed turns (`text.input`). */
  textInput?: boolean;
  /** The session accepts pictures (`image.input`) and the model can see them.
   *  Chat-model backends turn this on with a setting, because the relay cannot
   *  tell whether a model is multimodal. */
  imageInput?: boolean;
  /** The session takes live video (`video.frame`): what a camera or a shared
   *  screen shows, which the model sees with what the user says. On wherever
   *  pictures are. */
  videoInput?: boolean;
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

/**
 * What a device's own hardware and firmware already do to the microphone
 * signal, declared in `session.start` so the relay does not do the same job
 * twice or work against it. Every field is optional; leaving one out means
 * "unknown", and the relay then behaves as it always has.
 * docs/audio/contract.md is the builder's guide to this.
 */
export type DeviceAudio = {
  /** The device removes its own speaker from the microphone signal. */
  echoCancellation?: boolean;
  /** The device removes steady background noise (ENC, beamforming, a DSP). */
  noiseSuppression?: boolean;
  /** The device levels the microphone gain itself. */
  autoGainControl?: boolean;
  /** The device stops sending audio while nobody is speaking. */
  voiceGate?: boolean;
  /** The device spots the wake word itself and sends only speech meant for
   *  the assistant. */
  wakeWord?: boolean;
  /** Microphones feeding the signal (1–16). */
  microphones?: number;
  /** How the assistant's voice reaches the wearer: sealed in or over the ear,
   *  open near the ear, bone conduction, or a loudspeaker. */
  speaker?: "sealed" | "open" | "bone" | "loudspeaker";
};

/** What the relay decided for a session from the device's declaration. */
export type AudioPlan = {
  /** Who checks that the wearer said the assistant's name: the relay, the
   *  device, or nobody (the relay has the wake word turned off). */
  wakeGate: "relay" | "device" | "off";
  /** The relay supplies the silence a voice-gated device leaves out. */
  silenceFill: boolean;
  /** "confirm": before cutting the assistant's reply on a `hearing` status,
   *  the device should check that its own microphone hears the wearer. */
  bargeIn: "relay" | "confirm";
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
  /** The wire protocol the client speaks ({@link PROTOCOL_VERSION}); absent
   *  from clients older than the version handshake. */
  protocol?: number;
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
  /** Voice backend the client asks for (an id from AgentHealth.voice.providers).
   *  Honored only when the relay allows switching and that backend has
   *  credentials; otherwise the relay's default backend is used. */
  voiceProvider?: string;
  /** The language the wearer's app is set to ("en", "zh", …). The assistant
   *  answers in it for this session when it is one of the languages the
   *  assistant speaks; otherwise the assistant's own default applies. */
  language?: string;
  /** Equaliser for the assistant's voice this session. Honored only when the
   *  relay reports `voice.equalizer.adjustable`. */
  equalizer?: VoiceEqualizer;
  /** What the device already does to its microphone signal. */
  audio?: DeviceAudio;
  rideMode?: RideMode;
  scenario?: DemoScenario;
  lat?: number;
  lon?: number;
  memory?: SessionMemorySnapshot;
  /** Tools this client runs itself. The relay offers them to the model and
   *  sends `tool.call` when the model uses one. */
  tools?: ClientToolSpec[];
  /** Facts from the host app the assistant should know this session
   *  ("the user is on the pricing page"). Treated as untrusted context. */
  context?: string;
  /** The `resume` id of an earlier `session.started`, sent when reconnecting
   *  so the conversation carries on where it stopped. Unknown or expired ids
   *  are ignored and the session starts fresh. */
  resume?: string;
};

/** A tool the client declares in `session.start` and executes itself. */
type ClientToolSpec = {
  /** /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/ */
  name: string;
  /** What it does and when to use it, for the model. */
  description: string;
  /** JSON Schema for the arguments (an object schema). Omitted → no arguments. */
  parameters?: Record<string, unknown>;
  /** The conversation does not wait for this tool: the model is told at once
   *  that it has started, and its result is reported when it arrives (within
   *  two minutes). */
  background?: boolean;
};

/** Client → server: the answer to one `tool.call`. Exactly one per call. */
export type ToolResultEvent = {
  type: "tool.result";
  callId: string;
  /** Any JSON value or text. Ignored when `error` is set. */
  output?: unknown;
  /** Why the tool failed, for the model. */
  error?: string;
};

/** Client → server: a turn the user typed instead of spoke. */
type TextInputEvent = { type: "text.input"; text: string };

/** Client → server: a picture for the conversation's model, with optional words.
 *  `image` is base64 without a `data:` prefix, JPEG or PNG, at most
 *  `MAX_IMAGE_BASE64_CHARS` characters. Without `text` the picture waits for the
 *  user's next turn instead of starting one. */
type ImageInputEvent = {
  type: "image.input";
  image: string;
  mimeType: "image/jpeg" | "image/png";
  text?: string;
};

/** Client → server: one frame of live video, from a camera or a shared screen.
 *  A picture by the rules of `image.input`, without words. The relay keeps the
 *  newest frame only: the model sees it with the user's next turn (or, where
 *  the backend takes video itself, as it arrives). Frames that come faster
 *  than `MIN_VIDEO_FRAME_INTERVAL_MS` apart are dropped without an error. */
type VideoFrameEvent = { type: "video.frame"; image: string; mimeType: "image/jpeg" | "image/png" };

/** Client → server: the video has stopped. The relay forgets the last frame. */
type VideoStopEvent = { type: "video.stop" };

/** Shortest time between two video frames the relay takes. */
export const MIN_VIDEO_FRAME_INTERVAL_MS = 500;
/** A frame older than this is not what the user is showing any more. */
export const VIDEO_FRAME_FRESH_MS = 10_000;

/** Longest `image.input` picture, in base64 characters. Keeps the whole JSON
 *  message under the relay's 256 KiB limit, which the WebRTC data channel shares. */
export const MAX_IMAGE_BASE64_CHARS = 240_000;
/** At most this many pictures in one session. */
export const MAX_IMAGES_PER_SESSION = 50;
/** Shortest time between two pictures; Gemini Live takes at most one frame a second. */
export const MIN_IMAGE_INTERVAL_MS = 1_000;

/** Server → client: run one of the client's own tools and answer with `tool.result`. */
export type ToolCallEvent = {
  type: "tool.call";
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

/** Server → client: progress of any tool call, server or client, for UI. */
export type ToolActivityEvent = {
  type: "tool.activity";
  callId: string;
  name: string;
  where: "server" | "client";
  state: "started" | "succeeded" | "failed";
  durationMs?: number;
  error?: string;
};

/** Server → client: the relay is ending the session. The last of the
 *  assistant's speech has been sent; play it out, then expect the close. */
type SessionEndedEvent = {
  type: "session.ended";
  /** `agent`: the assistant ended a finished conversation. `idle`: the user
   *  stayed silent. `max_duration`: the time limit. */
  reason: string;
};

/** Server → client: the conversation moved to another agent. */
type AgentChangedEvent = { type: "agent.changed"; agent: string };

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
  | ToolResultEvent
  | TextInputEvent
  | ImageInputEvent
  | VideoFrameEvent
  | VideoStopEvent
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
  //
  // `speedKmh` is the phone's own GPS speed when it has a fresh one. The relay
  // has no other source of real speed; without it the speed is unknown.
  | { type: "location.update"; lat: number; lon: number; speedKmh?: number }
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

export type NavManeuver = {
  /** The routing service's own wording. Clients may parse it (for the turn
   *  icon, say), so it is never translated in place. */
  instruction: string;
  /** The same instruction in the session's language, when that is not the
   *  routing service's. Show and speak this when present. */
  localizedInstruction?: string;
  lat: number;
  lon: number;
  alongRouteMeters: number;
};

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
      kind: "confirm" | "offRoute" | "rerouteFailed" | "arrived" | "locationLost";
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

/** Server → RDK: the discovery token the board should broadcast, or null to
 *  stop broadcasting (paired, or beacon retired). Carries no secret: the
 *  token's whole purpose is to be public on the air. */
export type CompanionDiscoveryEvent = {
  type: "companion.discovery";
  token: string | null;
  expiresAt?: number;
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
      /** The wire protocol the relay speaks ({@link PROTOCOL_VERSION}); absent
       *  from relays older than the version handshake. */
      protocol?: number;
      /** How the relay treats this session's audio; absent from relays older
       *  than the audio contract. */
      audio?: AudioPlan;
      /** Send this back as `session.start.resume` when reconnecting, to carry
       *  the conversation on. Absent from relays older than resumption. */
      resume?: string;
    }
  | { type: "connection"; state: ConnectionState; detail: string }
  | {
      type: "status";
      state: string;
      detail: string;
      /** On `hearing`: the relay itself cut the reply (a truncation, an
       *  announcement, a guardrail, a typed turn), not the user's voice, so a
       *  client that confirms barge-ins against its own microphone stops at
       *  once. Absent when a speech detector heard the user, and from relays
       *  older than the marker (docs/audio/contract.md). */
      cause?: "relay";
    }
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
  | CompanionDiscoveryEvent
  | PhoneLocationEvent
  | PhoneLocationStatusEvent
  | NavRouteEvent
  | NavErrorEvent
  | ToolCallEvent
  | ToolActivityEvent
  | SessionEndedEvent
  | AgentChangedEvent;

/** What kind of wearable this assistant lives in. Drives copy and artwork only. */
export type AssistantDevice = "helmet" | "glasses" | "other";

/** The public face of the configured assistant (see server/assistant.ts and
 *  assistant.config.json). Everything a client needs to brand itself. */
export type AssistantSummary = {
  /** Display name, e.g. "Max". */
  name: string;
  device: AssistantDevice;
  /** What the wearer says to address the assistant. */
  wakePhrase: string;
  wakeWordEnabled: boolean;
  tagline?: string;
  developer?: string;
  /** Brand accent as #RRGGBB. Clients fall back to their own default. */
  accentColor?: string;
  /** Languages the assistant speaks, most preferred first (BCP-47-ish, e.g. "zh", "en"). */
  languages: string[];
  /** The speech-server voice the owner picked; absent → the backend's default. */
  voiceId?: string;
  /** The specific embodied device this build is for — an id from the relay's
   *  device presets (server/device-presets.ts), e.g. "motorcycle-helmet",
   *  "assistive-glasses", "vr-headset". `device` stays the coarse family. */
  deviceProfile?: string;
  /** Human name of that device in the relay's primary language, e.g. "Bicycle helmet". */
  deviceLabel?: string;
  /** Design template the owner chose (a client template id, e.g. "visor",
   *  "daylight", "beacon"). Clients fall back to their default template. */
  template?: string;
  /** Per-token overrides applied on top of the template: CSS-variable-style
   *  names without the leading dashes ("bg", "surface-1", "accent", "text",
   *  "radius-card", …) mapped to validated values. */
  theme?: Record<string, string>;
  /** False when the owner pinned the template: clients hide their template picker. */
  templateSwitching?: boolean;
  /** Visualiser style the owner chose for the live voice display. Clients
   *  fall back to "wave"; viewers may pick their own unless the template is pinned. */
  visualizer?: VoiceVisualizer;
  /** The owner's own logo, served by the relay (a path on the relay origin,
   *  e.g. "/brand/logo?v=1a2b3c"). SVG or PNG, square. Absent → clients show
   *  their built-in mark. Use it for the in-app mark and the page favicon. */
  logoUrl?: string;
};

/** Centre frequencies of the equaliser's ten bands, in Hz. A graphic
 *  equaliser in the classic ten-slider layout, with the bands placed inside
 *  the 12 kHz that 24 kHz speech audio actually carries. */
export const EQUALIZER_FREQUENCIES = [60, 125, 250, 500, 1000, 2000, 3000, 4000, 6000, 9000] as const;

/**
 * Voice equaliser settings, in decibels (-12…12). Applied by the relay to the
 * assistant's outgoing speech, so it sounds the same on every client and on a
 * board that plays raw PCM. `preset` names one of VoiceEqualizerOptions.presets;
 * `bands` (one gain per EQUALIZER_FREQUENCIES entry) and `preamp` override the
 * preset's when present.
 */
export type VoiceEqualizer = {
  preset?: string;
  /** Ten gains, lowest band first. */
  bands?: number[];
  /** Overall level, applied before the bands. */
  preamp?: number;
};

export type VoiceEqualizerPreset = {
  id: string;
  label: string;
  description?: string;
  bands: number[];
  preamp: number;
};

export type VoiceEqualizerOptions = {
  /** What a session gets when it does not ask for anything. */
  default: VoiceEqualizer;
  presets: VoiceEqualizerPreset[];
  /** Centre frequency of each band, in Hz. */
  frequencies: number[];
  /** Whether clients may send their own settings in session.start.equalizer. */
  adjustable: boolean;
};

/** How the live voice display is drawn. Like a media player's visualiser:
 *  the same signal, a different look. */
export type VoiceVisualizer = "wave" | "bars" | "mirror" | "dots" | "ring";

/** "demo" needs no credentials; "live" is one realtime speech-to-speech
 *  socket; "pipeline" chains speech-to-text → chat model → text-to-speech. */
export type VoiceProviderKind = "demo" | "live" | "pipeline";

export type VoiceProviderSummary = {
  id: string;
  label: string;
  kind: VoiceProviderKind;
  /** True when the relay has the credentials this backend needs. */
  configured: boolean;
  description?: string;
  /** True when the backend runs on the owner's own hardware (open-weight models). */
  local?: boolean;
};

type VoiceOptions = {
  /** Backend used when a session does not ask for one. */
  active: string;
  /** Whether clients may pick a backend per session via session.start.voiceProvider. */
  switching: boolean;
  providers: VoiceProviderSummary[];
  /** Absent on relays without the equaliser. */
  equalizer?: VoiceEqualizerOptions;
};

export type AgentHealth = {
  ok: boolean;
  provider: string;
  /** Configured assistant identity; absent on old relays. */
  assistant?: AssistantSummary;
  /** Available voice backends; absent on old relays. */
  voice?: VoiceOptions;
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

/**
 * WebSocket close code when the session's user has used up their monthly
 * voice minutes (USAGE_MONTHLY_MINUTES, server/usage.ts). Final, like an idle
 * close: reconnecting would only be refused again. An `error` event with the
 * reason comes first.
 */
export const USAGE_LIMIT_CLOSE_CODE = 4003;

export const MOCK_CAPABILITIES: ProviderCapabilities = {
  serverVad: true,
  synthesizedAudio: false,
  transcriptEvents: true,
  bargeIn: true,
  voiceSelection: true,
  weatherContext: true,
  sessionMemory: true,
  emergencyMode: true,
  tools: false,
  // The scripted ride takes no typed turns; the app demo (server/providers/app-demo.ts) does.
  textInput: false,
  imageInput: false
};

/** What every live backend offers: real synthesized audio on top of the demo's
 *  set, tool calls and typed turns. */
export const LIVE_CAPABILITIES: ProviderCapabilities = {
  serverVad: true,
  synthesizedAudio: true,
  transcriptEvents: true,
  bargeIn: true,
  voiceSelection: true,
  weatherContext: true,
  sessionMemory: true,
  emergencyMode: true,
  tools: true,
  textInput: true,
  // Backends turn this on where pictures reach a model that can see them
  // (server/providers/catalog.ts); none does by default.
  imageInput: false
};

/** The keyless demo of a software assistant (server/providers/app-demo.ts):
 *  it runs tools and takes typed turns, and has no weather or emergency mode. */
export const APP_DEMO_CAPABILITIES: ProviderCapabilities = {
  ...MOCK_CAPABILITIES,
  weatherContext: false,
  emergencyMode: false,
  tools: true,
  textInput: true
};

/** Doubao's realtime dialogue has no function calling and no typed turns. */
export const DOUBAO_CAPABILITIES: ProviderCapabilities = { ...LIVE_CAPABILITIES, tools: false, textInput: false };

export function providerCapabilities(provider: string): ProviderCapabilities {
  if (provider === "mock") return MOCK_CAPABILITIES;
  if (provider === "doubao") return DOUBAO_CAPABILITIES;
  return LIVE_CAPABILITIES;
}
