// Stateless helpers shared by the agent hook and the HUD components.

import type { AgentHealth, TesterSessionSummary } from "../../shared/agent";
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

export function normalizeTranscriptText(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\p{Script=Han}]+/gu, "");
}

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

export function exportTestingReport(health: AgentHealth | null, testerId: string, testerRegion: string) {
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
    uptimeSec: health?.uptimeSec,
    metrics: health?.metrics,
    metricsWindow: health?.metricsWindow,
    testing: health?.testing
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
