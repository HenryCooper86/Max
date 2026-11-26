// HUD constants: audio parameters, default states, and every label map. Pure
// data — no DOM access — so both hooks and components can import freely.

import type {
  AgentHealth,
  ConnectionState,
  HazardLevel,
  ProviderCapabilities,
  VoicePersonality
} from "../../shared/agent";
import type { DemoScenario, RideMode } from "../../shared/ride";
import type {
  AudioProcessingState,
  PacketStats,
  PermissionStateLabel,
  RideHudContext,
  SessionMemoryState
} from "../types";

export const SAMPLE_RATE = 16000;
export const PLAYBACK_SAMPLE_RATE = 24000;
// Boost agent speech above the raw Doubao level (the relayed PCM is conservative,
// so unity playback sounds quiet even at full device volume). A limiter after the
// gain keeps loud peaks from clipping. Mirrored by PcmPlayer on iOS/Android.
export const PLAYBACK_GAIN = 2.0;
export const MAX_RECONNECT_ATTEMPTS = 6;
// Confirming a barge-in against our own microphone (docs/audio/contract.md,
// "Interruption"): three consecutive 20 ms frames louder than this count as the
// wearer speaking, and stay valid for this long. The figure is the contract's
// reference client's (about -31 dBFS of PCM16).
export const BARGE_IN_MIC_RMS = 900;
export const BARGE_IN_HEARD_WITHIN_MS = 600;

export const DEFAULT_RIDE_CONTEXT: RideHudContext = {
  mode: "navigation",
  modeLabel: "导航",
  scenario: "commute",
  scenarioLabel: "通勤",
  speedKmh: 0,
  routePhase: "等待骑行上下文",
  network: "offline",
  batteryPct: 0,
  hazardLevel: "normal",
  glanceableFocus: "下一步提示"
};

export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  serverVad: false,
  synthesizedAudio: false,
  transcriptEvents: false,
  bargeIn: false,
  voiceSelection: false,
  weatherContext: false,
  sessionMemory: false,
  emergencyMode: false
};

export const DEFAULT_MEMORY: SessionMemoryState = {
  language: "zh",
  responseMode: "concise"
};

export const DEFAULT_PACKET_STATS: PacketStats = {
  outgoingFps: 0,
  droppedFrames: 0,
  jitterMs: 0,
  clippingPct: 0,
  silencePct: 0
};

export const DEFAULT_AUDIO_PROCESSING: AudioProcessingState = {
  echoCancellation: "unknown",
  noiseSuppression: "unknown",
  autoGainControl: "unknown"
};

export const RIDE_MODE_LABELS: Record<RideMode, string> = {
  ride: "骑行",
  stop: "停车",
  navigation: "导航",
  emergency: "紧急"
};
export const RIDE_MODE_LABELS_EN: Record<RideMode, string> = {
  ride: "Ride",
  stop: "Parked",
  navigation: "Navigation",
  emergency: "Emergency"
};

export const SCENARIOS: DemoScenario[] = ["commute", "wind", "fuel", "group", "emergency", "adas", "crash"];
export const RIDE_MODES: RideMode[] = ["ride", "navigation", "stop", "emergency"];
export const SCENARIO_HAZARDS: Record<DemoScenario, HazardLevel> = {
  commute: "normal",
  wind: "caution",
  fuel: "normal",
  group: "normal",
  emergency: "critical",
  adas: "caution",
  crash: "critical"
};

export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  offline: "离线",
  connecting: "连接中",
  relay: "中继在线",
  provider: "代理握手",
  ready: "已就绪",
  degraded: "降级"
};
export const CONNECTION_LABELS_EN: Record<ConnectionState, string> = {
  offline: "Offline",
  connecting: "Connecting",
  relay: "Relay online",
  provider: "Provider handshake",
  ready: "Ready",
  degraded: "Degraded"
};

export const RESPONSE_MODE_LABELS: Record<SessionMemoryState["responseMode"], string> = {
  concise: "极简",
  normal: "正常",
  emergency: "紧急"
};
export const RESPONSE_MODE_LABELS_EN: Record<SessionMemoryState["responseMode"], string> = {
  concise: "Concise",
  normal: "Normal",
  emergency: "Emergency"
};

export const HAZARD_LABELS: Record<HazardLevel, string> = {
  normal: "稳定",
  caution: "注意",
  critical: "高风险"
};
export const HAZARD_LABELS_EN: Record<HazardLevel, string> = {
  normal: "Steady",
  caution: "Caution",
  critical: "High risk"
};

export const HAZARD_ACTIONS: Record<HazardLevel, string> = {
  normal: "保持节奏，专注下一步提示",
  caution: "放缓一点，扩大车距",
  critical: "优先靠边，确认安全"
};
export const HAZARD_ACTIONS_EN: Record<HazardLevel, string> = {
  normal: "Keep your pace and focus on the next prompt",
  caution: "Slow down and increase following distance",
  critical: "Pull over when safe and confirm your surroundings"
};

export const NETWORK_LABELS: Record<RideHudContext["network"], string> = {
  online: "在线",
  degraded: "弱网",
  offline: "离线"
};

export const NETWORK_LABELS_EN: Record<RideHudContext["network"], string> = {
  online: "Online",
  degraded: "Weak connection",
  offline: "Offline"
};

export const PERMISSION_LABELS: Record<PermissionStateLabel, string> = {
  granted: "已授权",
  prompt: "待授权",
  denied: "已拒绝",
  unknown: "未确认"
};
export const PERMISSION_LABELS_EN: Record<PermissionStateLabel, string> = {
  granted: "Granted",
  prompt: "Permission needed",
  denied: "Denied",
  unknown: "Unknown"
};

export const AUDIO_PROCESSING_LABELS: Record<"true" | "false" | "unknown", string> = {
  true: "开启",
  false: "关闭",
  unknown: "未知"
};

export const CREDENTIAL_LABELS: Record<NonNullable<AgentHealth["credentials"]>, string> = {
  configured: "ok",
  missing: "missing",
  "not-required": "mock"
};

export const VOICE_PERSONALITIES: VoicePersonality[] = ["concise", "friendly", "technical", "rally"];
export const PERSONALITY_LABELS: Record<VoicePersonality, string> = {
  concise: "极简",
  friendly: "友好",
  technical: "技术",
  rally: "领航"
};
export const PERSONALITY_LABELS_EN: Record<VoicePersonality, string> = {
  concise: "Concise",
  friendly: "Friendly",
  technical: "Technical",
  rally: "Rally"
};
