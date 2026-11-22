import type { WebSocket } from "ws";
import type { Logger } from "../logger";
import { resolveVoiceProviderId, voiceCapabilities, voiceProvider, type VoiceProviderId } from "./catalog";
import { createDoubaoProvider } from "./doubao";
import { createGeminiLiveEngine } from "./live/gemini-live";
import { createRealtimeEngine, grokDialect, localRealtimeDialect, openAiDialect } from "./live/openai-realtime";
import { createMaxSpeechEngine } from "./live/max-speech";
import { createPipelineEngine, localPipelineSettings } from "./live/pipeline";
import { createLiveProvider, type LiveBackend } from "./live/session";
import { createMockProvider } from "./mock";
import { createAppDemoProvider } from "./app-demo";
import { assistant, type AssistantProfile } from "../assistant";
import type { ToolDefinition } from "../tools";
import type { AgentProvider, ProviderTelemetry, SessionStartEvent } from "./types";

function liveBackend(id: VoiceProviderId, createEngine: LiveBackend["createEngine"]): LiveBackend {
  const entry = voiceProvider(id);
  return { id, label: entry.label, capabilities: voiceCapabilities(id), createEngine };
}

/** What one session runs with instead of the relay's own settings: a Max
 *  Cloud project's model key, persona and (no) tools. */
export type ProviderOverrides = {
  apiKey?: string;
  profile?: AssistantProfile;
  serverTools?: () => readonly ToolDefinition[];
  /** A voice name for the backend, instead of the gender-based default. */
  voice?: string;
};

/** Builds the provider for one backend id. */
export function createVoiceProvider(
  id: VoiceProviderId,
  client: WebSocket,
  log: Logger,
  telemetry: ProviderTelemetry,
  overrides: ProviderOverrides = {}
): AgentProvider {
  const sessionOptions = {
    ...(overrides.profile ? { profile: overrides.profile } : {}),
    ...(overrides.serverTools ? { serverTools: overrides.serverTools } : {})
  };
  switch (id) {
    case "doubao":
      return createDoubaoProvider(client, log, telemetry);
    case "openai":
      return createLiveProvider(
        client,
        liveBackend(id, (engineLog) =>
          createRealtimeEngine(openAiDialect(overrides.apiKey, overrides.voice), engineLog)
        ),
        log,
        telemetry,
        sessionOptions
      );
    case "grok":
      return createLiveProvider(
        client,
        liveBackend(id, (engineLog) => createRealtimeEngine(grokDialect(overrides.apiKey, overrides.voice), engineLog)),
        log,
        telemetry,
        sessionOptions
      );
    case "gemini":
      return createLiveProvider(
        client,
        liveBackend(id, (engineLog) => createGeminiLiveEngine(engineLog, undefined, overrides.apiKey, overrides.voice)),
        log,
        telemetry,
        sessionOptions
      );
    case "pipeline":
      return createLiveProvider(
        client,
        liveBackend(id, (engineLog) => createPipelineEngine(engineLog)),
        log,
        telemetry
      );
    case "local":
      return createLiveProvider(
        client,
        liveBackend(id, (engineLog) => createPipelineEngine(engineLog, localPipelineSettings())),
        log,
        telemetry
      );
    case "local-realtime":
      return createLiveProvider(
        client,
        liveBackend(id, (engineLog) => createRealtimeEngine(localRealtimeDialect(), engineLog)),
        log,
        telemetry
      );
    case "max-speech":
      return createLiveProvider(
        client,
        liveBackend(id, (engineLog) => createMaxSpeechEngine(engineLog)),
        log,
        telemetry
      );
    case "mock":
      // A software assistant gets a demo of its own: the scripted ride makes
      // no sense on a website.
      return assistant().preset.general
        ? createAppDemoProvider(client, log, telemetry)
        : createMockProvider(client, telemetry);
  }
}

/**
 * Which backend a session gets. A client may ask for one, and gets it only
 * when switching is allowed and the relay holds that backend's credentials —
 * a client can never make the relay attempt a backend its owner has not set up.
 */
export function chooseVoiceProvider(
  requested: string | undefined,
  options: { fallback: VoiceProviderId; switching: boolean }
): VoiceProviderId {
  if (!options.switching) return options.fallback;
  const id = resolveVoiceProviderId(requested);
  if (!id || !voiceProvider(id).configured()) return options.fallback;
  return id;
}

/**
 * The session controller creates its provider when the socket opens, before
 * `session.start` says which backend the client wants. This stands in until
 * then and becomes the chosen backend at `start`.
 */
export function createSelectableProvider(create: (requested: string | undefined) => AgentProvider): AgentProvider {
  let chosen: AgentProvider | undefined;
  return {
    async start(event: SessionStartEvent, context) {
      chosen = create(event.voiceProvider);
      await chosen.start(event, context);
    },
    startAudio: async () => chosen?.startAudio(),
    sendAudio: async (chunk) => chosen?.sendAudio(chunk),
    stopAudio: async () => chosen?.stopAudio(),
    close: async () => chosen?.close(),
    upstreamUsable: () => chosen?.upstreamUsable?.(),
    setGuidedDemo: async (enabled) => chosen?.setGuidedDemo?.(enabled),
    updateLocation: async (lat, lon, speedKmh) => chosen?.updateLocation?.(lat, lon, speedKmh),
    deviceResult: async (event) => chosen?.deviceResult?.(event),
    hazardReport: async (event) => chosen?.hazardReport?.(event),
    cameraFrame: async (event) => chosen?.cameraFrame?.(event),
    visionFrames: async (event) => chosen?.visionFrames?.(event),
    attachNavOkSpeech: (speech) => chosen?.attachNavOkSpeech?.(speech),
    speakNavLine: (text) => chosen?.speakNavLine?.(text),
    speakNavPrompt: (speech) => chosen?.speakNavPrompt?.(speech),
    textInput: async (text) => (chosen?.textInput ? chosen.textInput(text) : false),
    imageInput: async (image, text) => (chosen?.imageInput ? chosen.imageInput(image, text) : false),
    toolResult: async (event) => chosen?.toolResult?.(event)
  };
}
