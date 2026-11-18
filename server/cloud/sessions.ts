// Session tokens a Max Cloud project gets without its API key:
//
//  - test:  the console's Test panel, for the signed-in owner of the project.
//  - embed: the public widget on a website the owner listed. Anyone visiting
//           that website can start a session, as with any public chat widget,
//           so it is limited per visitor address and per project, and every
//           session still counts against the owner's 5 concurrent sessions
//           and their balance. Browsers send Origin and cannot fake it; other
//           clients can, which is why the limits matter.

import { cloudSessionTokens } from "../session-tokens";
import { now } from "./context";
import { projectStudio, type Result } from "./customers";
import { liveProject, liveProjectByPublicId } from "./store";

const TEST_TTL_SECONDS = 300;
const EMBED_TTL_SECONDS = 120;
const PUBLIC_ID = /^pub_[0-9a-f]{24}$/;
const WINDOW_MS = 60_000;
const LIMITS = { testPerProject: 20, embedPerAddress: 10, embedPerProject: 120 } as const;

const hits = new Map<string, number[]>();

/** Sliding one-minute window; true when this hit is within `limit`. */
function allowed(key: string, limit: number): boolean {
  const at = now();
  const recent = (hits.get(key) ?? []).filter((time) => at - time < WINDOW_MS);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(at);
  hits.set(key, recent);
  if (hits.size > 50_000) {
    for (const [stale, times] of hits) if (!times.some((time) => at - time < WINDOW_MS)) hits.delete(stale);
  }
  return true;
}

/** Test hook. */
export function resetCloudSessionLimits(): void {
  hits.clear();
}

type Minted = { token: string; expiresAt: number };

export function mintTestSession(customerId: string, projectId: string): Result<Minted> {
  const row = typeof projectId === "string" ? liveProject(projectId, customerId) : undefined;
  if (!row) return { ok: false, status: 404, error: "Project not found." };
  if (!row.model_key_enc) {
    return { ok: false, status: 409, error: "Add your model key and save before testing." };
  }
  if (!allowed(`test:${row.id}`, LIMITS.testPerProject)) {
    return { ok: false, status: 429, error: "Too many test sessions in a minute. Wait a moment." };
  }
  const minted = cloudSessionTokens.mint(
    { ttlSeconds: TEST_TTL_SECONDS },
    { projectId: row.id, customerId, keyHash: row.key_hash, source: "test" }
  );
  if (!minted.ok) return { ok: false, status: 400, error: minted.error };
  return { ok: true, value: { token: minted.token, expiresAt: minted.expiresAt } };
}

const NOT_EMBEDDABLE = "This agent is not available on this website.";

export function mintEmbedSession(input: { publicId: unknown; origin: unknown; address: string }): Result<Minted> {
  if (typeof input.publicId !== "string" || !PUBLIC_ID.test(input.publicId)) {
    return { ok: false, status: 404, error: "Unknown agent." };
  }
  const row = liveProjectByPublicId(input.publicId);
  if (!row) return { ok: false, status: 404, error: "Unknown agent." };
  const studio = projectStudio(row);
  const origin = typeof input.origin === "string" ? input.origin : "";
  if (!studio.publicEmbed.enabled || !origin || !studio.publicEmbed.origins.includes(origin)) {
    return { ok: false, status: 403, error: NOT_EMBEDDABLE };
  }
  if (!row.model_key_enc) return { ok: false, status: 409, error: "This agent is not ready yet." };
  if (!allowed(`embed-ip:${input.address}`, LIMITS.embedPerAddress)) {
    return { ok: false, status: 429, error: "Too many conversations started. Try again in a minute." };
  }
  if (!allowed(`embed:${row.id}`, LIMITS.embedPerProject)) {
    return { ok: false, status: 429, error: "This agent is busy. Try again in a minute." };
  }
  const minted = cloudSessionTokens.mint(
    { ttlSeconds: EMBED_TTL_SECONDS },
    { projectId: row.id, customerId: row.customer_id, keyHash: row.key_hash, source: "embed", origin }
  );
  if (!minted.ok) return { ok: false, status: 400, error: minted.error };
  return { ok: true, value: { token: minted.token, expiresAt: minted.expiresAt } };
}
