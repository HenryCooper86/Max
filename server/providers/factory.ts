import type { WebSocket } from "ws";
import type { Logger } from "../logger";
import { resolveVoiceProviderId, voiceProvider, type VoiceProviderId } from "./catalog";
import { createDoubaoProvider } from "./doubao";
import { createGeminiLiveEngine } from "./live/gemini-live";
import { createRealtimeEngine, grokDialect, localRealtimeDialect, openAiDialect } from "./live/openai-realtime";
import { createPipelineEngine, localPipelineSettings } from "./live/pipeline";
import { createLiveProvider, type LiveBackend } from "./live/session";
import { createMockProvider } from "./mock";
import type { AgentProvider, ProviderTelemetry, SessionStartEvent } from "./types";

function liveBackend(id: VoiceProviderId, createEngine: LiveBackend["createEngine"]): LiveBackend {
  const entry = voiceProvider(id);
  return { id, label: entry.label, capabilities: entry.capabilities, createEngine };
}

/** Builds the provider for one backend id. */
export function createVoiceProvider(
  id: VoiceProviderId,
  client: WebSocket,
  log: Logger,
  telemetry: ProviderTelemetry
): AgentProvider {
  switch (id) {
    case "doubao":
      return createDoubaoProvider(client, log, telemetry);
    case "openai":
      return createLiveProvider(
        client,
        liveBackend(id, (engineLog) => createRealtimeEngine(openAiDialect(), engineLog)),
        log,
        telemetry
      );
    case "grok":
      return createLiveProvider(
        client,
        liveBackend(id, (engineLog) => createRealtimeEngine(grokDialect(), engineLog)),
        log,
        telemetry
      );
    case "gemini":
      return createLiveProvider(
        client,
        liveBackend(id, (engineLog) => createGeminiLiveEngine(engineLog)),
        log,
        telemetry
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
    case "mock":
      return createMockProvider(client, telemetry);
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
    setGuidedDemo: async (enabled) => chosen?.setGuidedDemo?.(enabled),
    updateLocation: async (lat, lon) => chosen?.updateLocation?.(lat, lon),
    deviceResult: async (event) => chosen?.deviceResult?.(event),
    hazardReport: async (event) => chosen?.hazardReport?.(event),
    cameraFrame: async (event) => chosen?.cameraFrame?.(event),
    visionFrames: async (event) => chosen?.visionFrames?.(event),
    attachNavOkSpeech: (speech) => chosen?.attachNavOkSpeech?.(speech),
    speakNavLine: (text) => chosen?.speakNavLine?.(text),
    speakNavPrompt: (speech) => chosen?.speakNavPrompt?.(speech)
  };
}
