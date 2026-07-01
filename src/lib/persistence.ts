// Local persistence for the HUD: recent transcript, voice settings, and the
// relay auth token. Everything is best-effort — storage being unavailable
// (private browsing, quota) must never break the voice session.

import type { VoicePersonality } from "../../shared/agent";
import type { TranscriptItem, VoiceGender } from "../types";

const TRANSCRIPT_KEY = "max.transcript.v1";
const SETTINGS_KEY = "max.settings.v1";
const TOKEN_KEY = "max.relayToken";
const VOICE_GENDERS = new Set<VoiceGender>(["female", "male"]);
const VOICE_PERSONALITIES = new Set<VoicePersonality>(["concise", "friendly", "technical", "rally"]);

/** Keep the stored conversation bounded so years of rides can't fill the quota. */
const TRANSCRIPT_CAP = 200;

type StoredSettings = {
  voiceGender?: VoiceGender;
  voicePersonality?: VoicePersonality;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeStoredSettings(value: unknown): StoredSettings {
  if (!isRecord(value)) return {};

  const settings: StoredSettings = {};
  if (typeof value.voiceGender === "string" && VOICE_GENDERS.has(value.voiceGender as VoiceGender)) {
    settings.voiceGender = value.voiceGender as VoiceGender;
  }
  if (
    typeof value.voicePersonality === "string" &&
    VOICE_PERSONALITIES.has(value.voicePersonality as VoicePersonality)
  ) {
    settings.voicePersonality = value.voicePersonality as VoicePersonality;
  }
  return settings;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full — persistence is best-effort */
  }
}

export function loadStoredTranscript(): TranscriptItem[] {
  const items = readJson<TranscriptItem[]>(TRANSCRIPT_KEY);
  if (!Array.isArray(items)) return [];
  return (
    items
      .filter(
        (item) =>
          item &&
          typeof item.id === "number" &&
          typeof item.at === "number" &&
          typeof item.text === "string" &&
          (item.speaker === "rider" || item.speaker === "agent")
      )
      // Anything restored is by definition a finished turn.
      .map((item) => ({ ...item, final: true }))
      .slice(-TRANSCRIPT_CAP)
  );
}

export function saveStoredTranscript(items: TranscriptItem[]) {
  writeJson(TRANSCRIPT_KEY, items.slice(-TRANSCRIPT_CAP));
}

export function clearStoredTranscript() {
  try {
    window.localStorage.removeItem(TRANSCRIPT_KEY);
  } catch {
    /* best-effort */
  }
}

export function loadStoredSettings(): StoredSettings {
  return normalizeStoredSettings(readJson<unknown>(SETTINGS_KEY));
}

export function saveStoredSettings(settings: StoredSettings) {
  writeJson(SETTINGS_KEY, normalizeStoredSettings(settings));
}

/**
 * The shared relay token (RELAY_AUTH_TOKEN on the server). Accepted once via
 * the page URL (?token=…) and then remembered, so a rider can be onboarded by
 * opening a single link.
 */
export function relayAuthToken(): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("token");
    if (fromUrl) {
      window.localStorage.setItem(TOKEN_KEY, fromUrl);
      const url = new URL(window.location.href);
      url.searchParams.delete("token");
      window.history.replaceState(window.history.state, document.title, `${url.pathname}${url.search}${url.hash}`);
      return fromUrl;
    }
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}
