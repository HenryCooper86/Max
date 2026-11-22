// The admin Studio's relay API: read and replace the running assistant's
// config, and upload or remove its logo. Every call carries the admin's
// bearer token; API keys are never part of this exchange.

import type { AssistantSummary, VoiceEqualizerOptions, VoiceProviderSummary } from "../../shared/agent";
import { requestJson, type ApiResult } from "./api-client";
import { credentialToken } from "./utils";

type StudioDevice = {
  id: string;
  family: string;
  label: { zh: string; en: string };
  template: string;
  visualizer: string;
  equalizer: string;
};

export type StudioState = {
  ok: true;
  /** The stored config; {} when the relay runs on its defaults. */
  config: Record<string, unknown>;
  assistant: AssistantSummary;
  customLogo: boolean;
  devices: StudioDevice[];
  equalizer: VoiceEqualizerOptions;
  providers: VoiceProviderSummary[];
  defaultProvider: string;
};

export const STUDIO_LOGO_MAX_BYTES = 512 * 1024;

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = credentialToken();
  return { ...extra, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

export function fetchStudio(): Promise<ApiResult<StudioState>> {
  return requestJson<StudioState>("/auth/admin/studio", { headers: authHeaders() });
}

export function saveStudio(config: Record<string, unknown>): Promise<ApiResult<StudioState>> {
  return requestJson<StudioState>("/auth/admin/studio", {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ config })
  });
}

export function uploadStudioLogo(file: Blob): Promise<ApiResult<StudioState>> {
  const type = file.type === "image/png" ? "image/png" : "image/svg+xml";
  return requestJson<StudioState>("/auth/admin/studio/logo", {
    method: "PUT",
    headers: authHeaders({ "Content-Type": type }),
    body: file
  });
}

export function removeStudioLogo(): Promise<ApiResult<StudioState>> {
  return requestJson<StudioState>("/auth/admin/studio/logo", { method: "DELETE", headers: authHeaders() });
}

// ---- The configs that have been live ----------------------------------------

export type StudioVersion = {
  id: string;
  savedAt: number;
  /** An admin's name, "studio", or "file" for a config found on the server's disk at startup. */
  by: string;
  restoredFrom?: string;
  name?: string;
  version?: string;
  /** The top-level config keys that differ from the version before it. */
  changed: string[];
  /** True when this is what the config file holds now. */
  current: boolean;
};

export type StudioHistory = { ok: true; versions: StudioVersion[] };

/** After a restore: the keys the running relay read only at startup, and so needs a restart for. */
export type StudioRestored = StudioState & { restartFor: string[] };

export function fetchStudioHistory(): Promise<ApiResult<StudioHistory>> {
  return requestJson<StudioHistory>("/auth/admin/studio/history", { headers: authHeaders() });
}

export function restoreStudioVersion(id: string): Promise<ApiResult<StudioRestored>> {
  return requestJson<StudioRestored>(`/auth/admin/studio/history/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    headers: authHeaders()
  });
}

// ---- Voice backend setup ---------------------------------------------------

export type BackendFieldState = {
  env: string;
  label: string;
  kind: "secret" | "text" | "url" | "toggle";
  /** True when the backend will see a value for this field. */
  set: boolean;
  /** Where that value comes from: set here, the server's .env, or nowhere. */
  source: "studio" | "env" | "unset";
  /** Never present for secrets. */
  value?: string;
  placeholder?: string;
};

export type BackendSetupState = {
  id: string;
  label: string;
  kind: "demo" | "live" | "pipeline";
  description: string;
  local: boolean;
  configured: boolean;
  requires: string;
  fields: BackendFieldState[];
};

export type StudioBackends = {
  ok: true;
  defaultProvider: string;
  switching: boolean;
  backends: BackendSetupState[];
};

export type StudioBackendsUpdate = {
  /** New values; null (or "") clears a field back to what .env provides. */
  values?: Record<string, string | null>;
  defaultProvider?: string;
  switching?: boolean;
};

export function fetchStudioBackends(): Promise<ApiResult<StudioBackends>> {
  return requestJson<StudioBackends>("/auth/admin/studio/backends", { headers: authHeaders() });
}

export function saveStudioBackends(update: StudioBackendsUpdate): Promise<ApiResult<StudioBackends>> {
  return requestJson<StudioBackends>("/auth/admin/studio/backends", {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(update)
  });
}
