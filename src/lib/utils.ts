// Stateless helpers shared by the agent hook and the HUD components.

import type { AgentHealth } from "../../shared/agent";
import type { TurnState } from "../components/HelmetVisual";
import type { AudioProcessingState, RiderLocation, TranscriptItem } from "../types";
import { AUDIO_PROCESSING_LABELS } from "./constants";
import { relayAuthToken } from "./persistence";

export function createAgentSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const token = relayAuthToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return new WebSocket(`${protocol}://${window.location.host}/agent${query}`);
}

export async function fetchAgentHealth(): Promise<AgentHealth | null> {
  try {
    const response = await fetch("/health");
    if (!response.ok) return null;
    return (await response.json()) as AgentHealth;
  } catch {
    return null;
  }
}

// Best-effort rider geolocation for live weather. Resolves null when the rider
// declines, the API is missing, or the lookup times out — weather is optional.
export function getRiderLocation(): Promise<RiderLocation | null> {
  if (!("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
      () => resolve(null),
      { timeout: 6000, maximumAge: 300000 }
    );
  });
}

export function audioProcessingLabel(value: AudioProcessingState["echoCancellation"]) {
  return AUDIO_PROCESSING_LABELS[String(value) as "true" | "false" | "unknown"];
}

export function readAudioProcessingSettings(track: MediaStreamTrack): AudioProcessingState {
  const settings = track.getSettings() as MediaTrackSettings & {
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  };

  return {
    echoCancellation: settings.echoCancellation ?? "unknown",
    noiseSuppression: settings.noiseSuppression ?? "unknown",
    autoGainControl: settings.autoGainControl ?? "unknown",
    sampleRate: settings.sampleRate,
    channelCount: settings.channelCount
  };
}

export function formatClockTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(timestamp);
}

export function normalizeTranscriptText(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\p{Script=Han}]+/gu, "");
}

export function exportTranscriptLog(items: TranscriptItem[]) {
  const payload = {
    exportedAt: new Date().toISOString(),
    turns: items.map((item) => ({
      id: item.id,
      at: new Date(item.at).toISOString(),
      speaker: item.speaker,
      language: item.language,
      final: item.final,
      text: item.text
    }))
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `max-session-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

// Folds a server status event into the conversational turn state. Unknown
// states leave the turn state unchanged.
export function mapTurnState(state: string, previous: TurnState): TurnState {
  switch (state) {
    case "listening":
    case "ready":
      return "listening";
    case "hearing":
    case "asr":
      return "hearing";
    case "thinking":
      return "thinking";
    case "speaking":
      return "speaking";
    case "closed":
      return "idle";
    default:
      return previous;
  }
}
