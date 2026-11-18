import type { ProviderCapabilities, VoiceProviderKind, VoiceProviderSummary } from "../../shared/agent";
import { DOUBAO_CAPABILITIES, LIVE_CAPABILITIES, MOCK_CAPABILITIES } from "../../shared/agent";
import { env } from "./live/engine";
import { geminiConfigured } from "./live/gemini-live";
import { localRealtimeEnabled } from "./live/openai-realtime";
import { localPipelineEnabled, pipelineConfigured } from "./live/pipeline";

/**
 * Every voice backend the relay knows, with what it needs to run.
 *
 * Deliberately free of provider implementations: configuration, health and the
 * setup wizard read this without loading a single upstream client. The
 * factories live in server/index.ts.
 */
export type VoiceProviderId =
  "mock" | "doubao" | "openai" | "grok" | "gemini" | "pipeline" | "local" | "local-realtime";

export type VoiceProviderEntry = {
  id: VoiceProviderId;
  label: string;
  kind: VoiceProviderKind;
  description: string;
  capabilities: ProviderCapabilities;
  /** True when the relay has what this backend needs. */
  configured(): boolean;
  /** What to set when it is not. */
  requires: string;
  /** Runs on the owner's own hardware with open-weight models. */
  local?: boolean;
};

function doubaoConfigured(): boolean {
  return Boolean(env("DOUBAO_API_KEY") || (env("DOUBAO_APP_ID") && env("DOUBAO_APP_KEY") && env("DOUBAO_ACCESS_KEY")));
}

export const VOICE_PROVIDERS: readonly VoiceProviderEntry[] = [
  {
    id: "mock",
    label: "Demo",
    kind: "demo",
    description: "Scripted conversation, no account or key needed.",
    capabilities: MOCK_CAPABILITIES,
    configured: () => true,
    requires: ""
  },
  {
    id: "doubao",
    label: "Doubao Realtime",
    kind: "live",
    description: "ByteDance Doubao live voice. Strongest in Chinese.",
    capabilities: DOUBAO_CAPABILITIES,
    configured: doubaoConfigured,
    requires: "DOUBAO_API_KEY"
  },
  {
    id: "openai",
    label: "OpenAI Realtime",
    kind: "live",
    description: "ChatGPT-style live speech-to-speech.",
    capabilities: LIVE_CAPABILITIES,
    configured: () => Boolean(env("OPENAI_API_KEY")),
    requires: "OPENAI_API_KEY"
  },
  {
    id: "grok",
    label: "Grok Voice",
    kind: "live",
    description: "xAI Grok live voice.",
    capabilities: LIVE_CAPABILITIES,
    configured: () => Boolean(env("XAI_API_KEY", "GROK_API_KEY")),
    requires: "XAI_API_KEY"
  },
  {
    id: "gemini",
    label: "Gemini Live",
    kind: "live",
    description: "Google Gemini live voice.",
    capabilities: LIVE_CAPABILITIES,
    configured: geminiConfigured,
    requires: "GEMINI_API_KEY"
  },
  {
    id: "pipeline",
    label: "Whisper pipeline",
    kind: "pipeline",
    description: "Whisper speech-to-text, any chat model, any text-to-speech. Works with local models.",
    capabilities: LIVE_CAPABILITIES,
    configured: () => pipelineConfigured(),
    requires: "PIPELINE_API_KEY or OPENAI_API_KEY (none for local endpoints)"
  },
  {
    id: "local",
    label: "Local models",
    kind: "pipeline",
    description: "Open-weight models on your own hardware: Whisper, an Ollama chat model, Kokoro speech.",
    capabilities: LIVE_CAPABILITIES,
    configured: localPipelineEnabled,
    requires: "LOCAL_VOICE=on (see docs/local-models.md)",
    local: true
  },
  {
    id: "local-realtime",
    label: "Local realtime",
    kind: "live",
    description: "A self-hosted server that speaks the OpenAI Realtime protocol.",
    capabilities: LIVE_CAPABILITIES,
    configured: localRealtimeEnabled,
    requires: "LOCAL_REALTIME_URL",
    local: true
  }
];

const ALIASES: Record<string, VoiceProviderId> = {
  demo: "mock",
  xai: "grok",
  "grok-voice": "grok",
  "openai-realtime": "openai",
  chatgpt: "openai",
  "gemini-live": "gemini",
  google: "gemini",
  whisper: "pipeline",
  cascade: "pipeline",
  offline: "local",
  ollama: "local",
  "local-pipeline": "local",
  "open-weight": "local"
};

/** Resolves an id or a friendly alias; undefined when it names nothing. */
export function resolveVoiceProviderId(value: string | undefined): VoiceProviderId | undefined {
  const key = value?.trim().toLowerCase();
  if (!key) return undefined;
  const id = ALIASES[key] ?? key;
  return VOICE_PROVIDERS.some((entry) => entry.id === id) ? (id as VoiceProviderId) : undefined;
}

export function voiceProvider(id: VoiceProviderId): VoiceProviderEntry {
  const entry = VOICE_PROVIDERS.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown voice provider ${id}`);
  return entry;
}

export function voiceProviderSummaries(): VoiceProviderSummary[] {
  return VOICE_PROVIDERS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    kind: entry.kind,
    configured: entry.configured(),
    description: entry.description,
    ...(entry.local ? { local: true } : {})
  }));
}
