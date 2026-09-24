// Local persistence for the HUD: recent transcript, voice settings, and the
// relay auth token. Everything is best-effort — storage being unavailable
// (private browsing, quota) must never break the voice session.

import type { VoicePersonality } from "../../shared/agent";
import { detectLanguage } from "../../shared/language";
import { DEFAULT_TESTING_CAMPAIGN_ID, DEFAULT_TESTING_TEST_CASE_ID } from "../../shared/testing";
import type { TranscriptItem, VoiceGender } from "../types";

// v1 used one device-global key. That let a second account on a shared
// browser inherit the previous rider's local transcript, even though server
// memory was correctly account-scoped. v2 is keyed by the immutable account
// UUID and deliberately does not migrate the ambiguous v1 data.
const LEGACY_TRANSCRIPT_KEY = "max.transcript.v1";
const TRANSCRIPT_KEY_PREFIX = "max.transcript.v2.";
const SETTINGS_KEY = "max.settings.v1";
const TOKEN_KEY = "max.relayToken";
let sessionRelayToken = "";
const VOICE_GENDERS = new Set<VoiceGender>(["female", "male"]);
const VOICE_PERSONALITIES = new Set<VoicePersonality>(["concise", "friendly", "technical", "rally"]);

/** Keep the stored conversation bounded so years of rides can't fill the quota. */
const TRANSCRIPT_CAP = 200;

type StoredSettings = {
  voiceGender?: VoiceGender;
  voicePersonality?: VoicePersonality;
  testerId?: string;
  testingCampaignId?: string;
  testingTestCaseId?: string;
  testingRunId?: string;
  testingAssignmentId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripControlChars(value: string) {
  return value
    .split("")
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");
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
  if (typeof value.testerId === "string") {
    const testerId = stripControlChars(value.testerId.normalize("NFKC")).replace(/\s+/g, " ").trim().slice(0, 80);
    if (testerId) settings.testerId = testerId;
  }
  if (typeof value.testingCampaignId === "string") {
    const campaignId = stripControlChars(value.testingCampaignId.normalize("NFKC")).trim().slice(0, 80);
    if (campaignId) settings.testingCampaignId = campaignId;
  }
  if (typeof value.testingTestCaseId === "string") {
    const testCaseId = stripControlChars(value.testingTestCaseId.normalize("NFKC")).trim().slice(0, 80);
    if (testCaseId) settings.testingTestCaseId = testCaseId;
  }
  if (typeof value.testingRunId === "string") {
    const runId = stripControlChars(value.testingRunId.normalize("NFKC")).trim().slice(0, 80);
    if (runId) settings.testingRunId = runId;
  }
  if (typeof value.testingAssignmentId === "string") {
    const assignmentId = stripControlChars(value.testingAssignmentId.normalize("NFKC")).trim().slice(0, 80);
    if (assignmentId) settings.testingAssignmentId = assignmentId;
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

/**
 * Scopes a storage key to an account UUID, or null when there is no account
 * to attribute it to. Exported so everything account-scoped shares one
 * definition of "a usable account id" — a second such store (Amap consent)
 * would otherwise reimplement this validation and drift from it.
 */
export function accountScopedKey(prefix: string, userId: string | null): string | null {
  const normalized = (userId ?? "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? `${prefix}${normalized}`
    : null;
}

function transcriptKey(userId: string): string | null {
  return accountScopedKey(TRANSCRIPT_KEY_PREFIX, userId);
}

function discardLegacyTranscript() {
  try {
    window.localStorage.removeItem(LEGACY_TRANSCRIPT_KEY);
  } catch {
    /* best-effort */
  }
}

export function loadStoredTranscript(userId: string): TranscriptItem[] {
  // A device-global transcript cannot be assigned to a user safely. Drop it
  // on first use instead of guessing and creating a cross-account disclosure.
  discardLegacyTranscript();
  const key = transcriptKey(userId);
  if (!key) return [];
  const items = readJson<TranscriptItem[]>(key);
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
      // Anything restored is by definition a finished turn. `language` may be
      // missing from an older stored schema — re-derive it rather than letting
      // Chinese rows silently render as "EN".
      .map((item) => ({
        ...item,
        final: true,
        language: item.language === "zh" || item.language === "en" ? item.language : detectLanguage(item.text)
      }))
      .slice(-TRANSCRIPT_CAP)
  );
}

export function saveStoredTranscript(userId: string, items: TranscriptItem[]) {
  const key = transcriptKey(userId);
  if (key) writeJson(key, items.slice(-TRANSCRIPT_CAP));
}

export function clearStoredTranscript(userId: string) {
  const key = transcriptKey(userId);
  try {
    if (key) window.localStorage.removeItem(key);
    window.localStorage.removeItem(LEGACY_TRANSCRIPT_KEY);
  } catch {
    /* best-effort */
  }
}

export function loadStoredSettings(): StoredSettings {
  const settings = normalizeStoredSettings(readJson<unknown>(SETTINGS_KEY));
  return {
    ...settings,
    testingCampaignId: settings.testingCampaignId ?? DEFAULT_TESTING_CAMPAIGN_ID,
    testingTestCaseId: settings.testingTestCaseId ?? DEFAULT_TESTING_TEST_CASE_ID
  };
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
  const fromUrl = new URLSearchParams(window.location.search).get("token");
  if (fromUrl) {
    // Keep it for this page even if storage is unavailable. Scrub the URL
    // independently so a storage failure does not leave the token in browser
    // history, copied links, or subsequent same-origin referrers.
    sessionRelayToken = fromUrl;
    try {
      window.localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      /* persistence is best-effort */
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("token");
      window.history.replaceState(window.history.state, document.title, `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* history rewrite is best-effort; the in-memory token still stands */
    }
    return fromUrl;
  }
  if (sessionRelayToken) return sessionRelayToken;
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}
