// Stateless helpers shared by the agent hook and the HUD components.

import type { AgentHealth, DeviceAudio, TesterSessionSummary, TestingStats } from "../../shared/agent";
import type { TurnState } from "../components/VisorVisual";
import type { AudioProcessingState, RiderLocation, TranscriptItem } from "../types";
import type { Language } from "./i18n";
import { authToken } from "./auth";
import { requestJson } from "./api-client";
import { AUDIO_PROCESSING_LABELS } from "./constants";
import { relayAuthToken } from "./persistence";

/**
 * The ONE credential this client presents everywhere (WebSocket and HTTP):
 * the login session first, the operator relay token as fallback. A dead
 * session token is cleared by the periodic /auth/me revalidation, after which
 * this naturally falls back to the relay token — so the precedence never
 * strands a working credential behind a stale one.
 */
export function credentialToken(): string {
  return authToken() || relayAuthToken();
}

export function createAgentSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const token = credentialToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return new WebSocket(`${protocol}://${window.location.host}/agent${query}`);
}

export async function fetchAgentHealth(): Promise<AgentHealth | null> {
  try {
    // The token unlocks the per-tester QA block on protected relays; /health
    // itself never requires it.
    const token = credentialToken();
    const response = await requestJson<AgentHealth>("/health", {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined
    });
    if (!response.ok) return null;
    return response.data;
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

export function audioProcessingLabel(value: AudioProcessingState["echoCancellation"], language: Language = "zh-CN") {
  if (language === "en-US") return value === true ? "On" : value === false ? "Off" : "Unknown";
  return AUDIO_PROCESSING_LABELS[String(value) as "true" | "false" | "unknown"];
}

/** The `audio` part of session.start: what the browser reports it is doing
 *  to the microphone. Settings it has not reported are left out, so the relay
 *  treats them as unknown; with nothing known, the whole field is left out. */
export function deviceAudioDeclaration(state: AudioProcessingState): { audio?: DeviceAudio } {
  const audio: DeviceAudio = {};
  if (typeof state.echoCancellation === "boolean") audio.echoCancellation = state.echoCancellation;
  if (typeof state.noiseSuppression === "boolean") audio.noiseSuppression = state.noiseSuppression;
  if (typeof state.autoGainControl === "boolean") audio.autoGainControl = state.autoGainControl;
  return Object.keys(audio).length ? { audio } : {};
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
    sampleRate: settings.sampleRate
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

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

export function formatRelativeTime(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  const elapsedMs = Date.now() - timestamp;
  if (elapsedMs < 60_000) return "just now";
  if (elapsedMs < 3_600_000) return `${Math.round(elapsedMs / 60_000)}m ago`;
  if (elapsedMs < 86_400_000) return `${Math.round(elapsedMs / 3_600_000)}h ago`;
  return `${Math.round(elapsedMs / 86_400_000)}d ago`;
}

/** The server-side stats row for this browser's tester id, if any. */
function currentTesterSnapshot(health: AgentHealth | null, testerId: string) {
  return health?.testing?.users
    .filter((user) => user.testerId === testerId)
    .sort((a, b) => Number(b.activeSessions) - Number(a.activeSessions) || b.lastSeenAt - a.lastSeenAt)[0];
}

export function exportTranscriptLog(
  items: TranscriptItem[],
  health: AgentHealth | null,
  testerId: string,
  testerRegion: string
) {
  const tester = currentTesterSnapshot(health, testerId);
  const payload = {
    exportedAt: new Date().toISOString(),
    tester: {
      testerId,
      testerKey: tester?.testerKey,
      ipAddress: tester?.ipAddress ?? "pending",
      region: tester?.region ?? testerRegion,
      lastSeenAt: tester ? new Date(tester.lastSeenAt).toISOString() : undefined
    },
    provider: health?.provider,
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
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Defer revocation: some browsers (e.g. Firefox) cancel the download if the
  // blob URL is revoked synchronously before the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportTestingReport(
  health: AgentHealth | null,
  testerId: string,
  testerRegion: string,
  testingOverride?: TestingStats | null
) {
  const testing = testingOverride ?? health?.testing;
  const tester = testing?.users.find((user) => user.testerId === testerId);
  const payload = {
    exportedAt: new Date().toISOString(),
    tester: {
      testerId,
      testerKey: tester?.testerKey,
      ipAddress: tester?.ipAddress ?? "pending",
      region: tester?.region ?? testerRegion,
      lastSeenAt: tester ? new Date(tester.lastSeenAt).toISOString() : undefined
    },
    provider: health?.provider,
    uptimeSec: health?.uptimeSec,
    metrics: health?.metrics,
    metricsWindow: health?.metricsWindow,
    testing
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `max-testing-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportTestingSession(session: TesterSessionSummary) {
  const payload = {
    exportedAt: new Date().toISOString(),
    session: {
      ...session,
      startedAtIso: new Date(session.startedAt).toISOString(),
      endedAtIso: new Date(session.endedAt).toISOString(),
      turns: session.turns.map((turn) => ({
        ...turn,
        atIso: new Date(turn.at).toISOString()
      }))
    }
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `max-test-session-${session.sessionId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
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
