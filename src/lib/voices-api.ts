// The admin Studio's voice library, through the relay (never the speech
// server directly: the relay holds its address and key). JSON routes return
// parsed data; audio routes return Blobs the caller turns into object URLs.
// Errors keep the speech server's `code` so the UI can explain it.

import type { ApiError } from "./api-client";
import { readStoredLanguage } from "./i18n";
import { credentialToken } from "./utils";

export type VoiceGender = "female" | "male" | "neutral";

export type SpeechVoice = {
  id: string;
  name: string;
  kind: "preset" | "custom";
  languages: string[];
  gender?: string;
  transcript?: string;
  /** "recorded" for a cloned person, "designed" for a described voice. */
  origin?: "recorded" | "designed";
  created_at?: string;
  created_by?: string;
  consent?: { speaker?: string; statement?: string; [key: string]: unknown };
  design?: { description?: string; seed?: number; model?: string; text?: string };
};

export type VoiceAttribution = { model: string; weights_license?: string; text: string };

export type VoicesOverview =
  | {
      available: true;
      cloning: boolean;
      design: boolean;
      voices: SpeechVoice[];
      attributions: VoiceAttribution[];
    }
  | { available: false; reason: string };

export type DesignCandidate = { id: string; text: string; description: string };

type CloneInput = {
  name: string;
  gender: VoiceGender;
  languages: string[];
  transcript?: string;
  consentStatement: string;
  consentSpeaker: string;
  audio: Blob;
};

export type VoiceApiError = ApiError & { code?: string };
export type VoiceResult<T> = { ok: true; data: T } | { ok: false; error: VoiceApiError };

const BASE = "/auth/admin/studio";
// Cloning and design run a model, so they get longer than a settings call.
// Slightly more than the relay's own 120 s, so its timeout message wins.
const SLOW_MS = 130_000;
const FAST_MS = 20_000;

function kindFor(status: number): ApiError["kind"] {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status >= 400 && status < 500) return "invalid";
  return "server";
}

async function call<T>(
  path: string,
  init: { method?: string; json?: unknown; timeoutMs?: number },
  read: (response: Response) => Promise<T>
): Promise<VoiceResult<T>> {
  const language = readStoredLanguage();
  const token = credentialToken();
  const headers: Record<string, string> = { "Accept-Language": language };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.json !== undefined) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? FAST_MS);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
      signal: controller.signal
    });
    if (!response.ok) {
      let code: string | undefined;
      let message =
        language === "en-US"
          ? `The request failed (HTTP ${response.status}).`
          : `请求失败（HTTP ${response.status}）。`;
      try {
        const body: unknown = await response.json();
        if (body && typeof body === "object") {
          if ("code" in body && typeof body.code === "string") code = body.code;
          if ("error" in body && typeof body.error === "string") message = body.error;
        }
      } catch {
        /* keep the generic message */
      }
      return { ok: false, error: { kind: kindFor(response.status), status: response.status, message, code } };
    }
    return { ok: true, data: await read(response) };
  } catch {
    return {
      ok: false,
      error: {
        kind: "unavailable",
        message:
          language === "en-US" ? "Could not reach the relay. Please try again later." : "无法连接中继，请稍后重试。"
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

const asJson = <T>(response: Response) => response.json() as Promise<T>;
const asBlob = (response: Response) => response.blob();
const nothing = async () => undefined;
const voicePath = (id: string) => `/voices/${encodeURIComponent(id)}`;

/** Base64 of a byte array, in slices so a long recording cannot overflow the
 *  call stack of String.fromCharCode. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const slice = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += slice) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + slice));
  }
  return btoa(binary);
}

function listVoices(): Promise<VoiceResult<VoicesOverview>> {
  return call("/voices", {}, (response) => asJson<VoicesOverview>(response));
}

async function cloneVoice(input: CloneInput): Promise<VoiceResult<SpeechVoice>> {
  const audio = bytesToBase64(new Uint8Array(await input.audio.arrayBuffer()));
  const transcript = input.transcript?.trim();
  return call(
    "/voices",
    {
      method: "POST",
      timeoutMs: SLOW_MS,
      json: {
        name: input.name,
        gender: input.gender,
        languages: input.languages,
        ...(transcript ? { transcript } : {}),
        consent: true,
        consentStatement: input.consentStatement,
        consentSpeaker: input.consentSpeaker,
        audio,
        audioType: "audio/wav"
      }
    },
    (response) => asJson<SpeechVoice>(response)
  );
}

function updateVoice(
  id: string,
  patch: { name?: string; languages?: string[]; gender?: VoiceGender; transcript?: string }
): Promise<VoiceResult<SpeechVoice>> {
  return call(voicePath(id), { method: "PATCH", json: patch }, (response) => asJson<SpeechVoice>(response));
}

function deleteVoice(id: string): Promise<VoiceResult<undefined>> {
  return call(voicePath(id), { method: "DELETE" }, nothing);
}

function fetchReference(id: string): Promise<VoiceResult<Blob>> {
  return call(`${voicePath(id)}/reference`, { timeoutMs: SLOW_MS }, asBlob);
}

function previewVoice(id: string, text?: string): Promise<VoiceResult<Blob>> {
  return call(`${voicePath(id)}/preview`, { method: "POST", json: text ? { text } : {}, timeoutMs: SLOW_MS }, asBlob);
}

async function designVoice(request: {
  description: string;
  text?: string;
  language?: string;
  count?: number;
}): Promise<VoiceResult<DesignCandidate[]>> {
  const result = await call("/voices/design", { method: "POST", json: request, timeoutMs: SLOW_MS }, (response) =>
    asJson<{ candidates: DesignCandidate[] }>(response)
  );
  return result.ok ? { ok: true, data: result.data.candidates } : result;
}

function fetchCandidateAudio(candidateId: string): Promise<VoiceResult<Blob>> {
  return call(`/voices/design/${encodeURIComponent(candidateId)}/audio`, { timeoutMs: SLOW_MS }, asBlob);
}

function saveCandidate(
  candidateId: string,
  body: { name: string; gender?: VoiceGender; languages?: string[] }
): Promise<VoiceResult<SpeechVoice>> {
  return call(
    `/voices/design/${encodeURIComponent(candidateId)}/save`,
    { method: "POST", json: body, timeoutMs: SLOW_MS },
    (response) => asJson<SpeechVoice>(response)
  );
}

async function getLexicon(): Promise<VoiceResult<Record<string, string>>> {
  const result = await call("/lexicon", {}, (response) => asJson<{ entries: Record<string, string> }>(response));
  return result.ok ? { ok: true, data: result.data.entries } : result;
}

async function putLexicon(entries: Record<string, string>): Promise<VoiceResult<Record<string, string>>> {
  const result = await call("/lexicon", { method: "PUT", json: { entries } }, (response) =>
    asJson<{ entries: Record<string, string> }>(response)
  );
  return result.ok ? { ok: true, data: result.data.entries } : result;
}

/** Everything the panel calls, as one object so tests can inject a fake. */
export const voicesApi = {
  listVoices,
  cloneVoice,
  updateVoice,
  deleteVoice,
  fetchReference,
  previewVoice,
  designVoice,
  fetchCandidateAudio,
  saveCandidate,
  getLexicon,
  putLexicon
};
export type VoicesApi = typeof voicesApi;
