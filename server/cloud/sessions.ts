// Session tokens a Max Cloud project gets:
//
//  - api:   the owner's backend, with the project's API key (mintProjectSession).
//           A token can name one of the owner's users (`userId`), whose minutes
//           in the project are counted per month and kept to the project's
//           per-user monthly limit.
//
//  - test:  the console's Test panel, for the signed-in owner of the project.
//  - embed: the public widget on a website the owner listed. Anyone visiting
//           that website can start a session, as with any public chat widget,
//           so it is limited per visitor address and per project, and every
//           session still counts against the owner's 5 concurrent sessions
//           (3 of them for the embed), their balance and the project's
//           monthly minutes limit. Browsers send Origin and cannot fake it;
//           other clients can, which is why the limits matter. An embed token
//           opens one session: the SDK fetches a new one for every connect.

import type { InstallSignalKind } from "../../shared/studio-install";
import { observeInstall } from "./install-diagnostics";
import { cloudSessionTokens } from "../session-tokens";
import { now } from "./context";
import { projectStudio, type Result } from "./customers";
import { projectLimitRefusal, userLimitRefusal } from "./live";
import { draftRevisionProject } from "./revisions";
import { hashToken } from "./secrets";
import { ANONYMOUS_USER, liveProject, liveProjectByPublicId, readStudioLiveRevision } from "./store";

const TEST_TTL_SECONDS = 300;
const EMBED_TTL_SECONDS = 120;
const PUBLIC_ID = /^pub_[0-9a-f]{24}$/;
const WINDOW_MS = 60_000;
const LIMITS = { testPerProject: 20, embedPerAddress: 10, embedPerProject: 120 } as const;

const hits = new Map<string, number[]>();
// Hashes of embed tokens that already opened a session, until they would have expired anyway.
const spentEmbedTokens = new Map<string, number>();

/** Sliding one-minute window; true when this hit is within `limit`. */
export function allowed(key: string, limit: number): boolean {
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

/** Share the per-project attempt budget across interactive previews and replays. */
export function allowStudioTestAttempt(projectId: string): boolean {
  return allowed(`test:${projectId}`, LIMITS.testPerProject);
}

/** Test hook. */
export function resetCloudSessionLimits(): void {
  hits.clear();
  spentEmbedTokens.clear();
}

type Minted = { token: string; expiresAt: number };

export function mintTestSession(
  customerId: string,
  projectId: string,
  revision?: string,
  expectedLiveRevision?: string
): Result<Minted> {
  if (revision !== undefined && expectedLiveRevision !== undefined) {
    return { ok: false, status: 400, error: "Choose either a draft or a live revision to preview." };
  }
  const live = typeof projectId === "string" ? liveProject(projectId, customerId) : undefined;
  if (!live) return { ok: false, status: 404, error: "Project not found." };
  const row =
    revision !== undefined
      ? draftRevisionProject(customerId, projectId, revision)
      : expectedLiveRevision !== undefined
        ? readStudioLiveRevision(projectId, customerId, expectedLiveRevision, { requireNoDraft: true })
        : live;
  if (!row) return { ok: false, status: 409, error: "The Studio revision changed. Refresh and start a new test." };
  if (!row.model_key_enc) {
    return { ok: false, status: 409, error: "Add your model key and save before testing." };
  }
  if (projectLimitRefusal(row.id)) {
    return {
      ok: false,
      status: 403,
      error: "This project has used its monthly minutes limit. Raise it in Settings to keep testing."
    };
  }
  if (!allowStudioTestAttempt(row.id)) {
    return { ok: false, status: 429, error: "Too many test sessions in a minute. Wait a moment." };
  }
  const minted = cloudSessionTokens.mint(
    { ttlSeconds: TEST_TTL_SECONDS },
    {
      projectId: live.id,
      customerId,
      keyHash: row.key_hash,
      source: "test",
      ...(revision === undefined ? {} : { testRevision: revision }),
      ...(expectedLiveRevision === undefined ? {} : { testLiveRevision: expectedLiveRevision })
    }
  );
  if (!minted.ok) return { ok: false, status: 400, error: minted.error };
  return { ok: true, value: { token: minted.token, expiresAt: minted.expiresAt } };
}

/**
 * Mints a session token for the owner's backend (POST /v1/session-tokens with
 * the project key), for `project`, which that key was found to be. A token may
 * name one of their users (`userId`). None is minted while the project has
 * reached its monthly minutes limit, nor for a user who has reached the
 * project's per-user one.
 */
export function mintProjectSession(
  project: { projectId: string; customerId: string; keyHash: string },
  body: Record<string, unknown>
): Result<Minted> {
  if (projectLimitRefusal(project.projectId)) {
    return {
      ok: false,
      status: 403,
      error: "This project has used its monthly minutes limit. Raise it in the console's Settings."
    };
  }
  // The user is the userId as the token would carry it, trimmed. One that is blank is no user: the mint says why.
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  // Usage reports call the sessions that named no user "anonymous": a user of that name could not be told from them.
  if (userId === ANONYMOUS_USER) {
    return {
      ok: false,
      status: 400,
      error: `userId cannot be "${ANONYMOUS_USER}": usage reports use it for sessions without a user.`
    };
  }
  if (userId && userLimitRefusal(project.projectId, userId)) {
    return {
      ok: false,
      status: 403,
      error: "This user has used their monthly minutes limit. Raise the per-user limit in the console's Settings."
    };
  }
  const minted = cloudSessionTokens.mint(
    { ttlSeconds: body.ttlSeconds, userId: body.userId, context: body.context },
    project
  );
  return minted.ok
    ? { ok: true, value: { token: minted.token, expiresAt: minted.expiresAt } }
    : { ok: false, status: 400, error: minted.error };
}

const NOT_EMBEDDABLE = "This agent is not available on this website.";

export function mintEmbedSession(input: { publicId: unknown; origin: unknown; address: string }): Result<Minted> {
  if (typeof input.publicId !== "string" || !PUBLIC_ID.test(input.publicId)) {
    return { ok: false, status: 404, error: "Unknown agent." };
  }
  const row = liveProjectByPublicId(input.publicId);
  if (!row) return { ok: false, status: 404, error: "Unknown agent." };
  const refuse = (kind: InstallSignalKind, status: number, error: string): Result<Minted> => {
    observeInstall(row.id, kind);
    return { ok: false, status, error };
  };
  const studio = projectStudio(row);
  const origin = typeof input.origin === "string" ? input.origin : "";
  if (!studio.publicEmbed.enabled) return refuse("disabled", 403, NOT_EMBEDDABLE);
  if (!origin || !studio.publicEmbed.origins.includes(origin)) return refuse("origin", 403, NOT_EMBEDDABLE);
  if (!row.model_key_enc) return refuse("modelKey", 409, "This agent is not ready yet.");
  if (!allowed(`embed-ip:${input.address}`, LIMITS.embedPerAddress)) {
    return refuse("busy", 429, "Too many conversations started. Try again in a minute.");
  }
  if (!allowed(`embed:${row.id}`, LIMITS.embedPerProject)) {
    return refuse("busy", 429, "This agent is busy. Try again in a minute.");
  }
  if (projectLimitRefusal(row.id)) {
    return refuse("monthlyLimit", 403, "This agent has used its minutes for this month.");
  }
  const minted = cloudSessionTokens.mint(
    { ttlSeconds: EMBED_TTL_SECONDS },
    { projectId: row.id, customerId: row.customer_id, keyHash: row.key_hash, source: "embed", origin }
  );
  if (!minted.ok) return refuse("unavailable", 400, minted.error);
  observeInstall(row.id, "tokenIssued");
  return { ok: true, value: { token: minted.token, expiresAt: minted.expiresAt } };
}

/**
 * Spends the public-embed tokens a connection presents: the first connection
 * with one gets its session and the token is revoked, so a script holding a
 * token cannot open session after session with it past the per-visitor mint
 * limit. Returns false when a presented token was already spent; that
 * connection must be refused. Other tokens (project key, console test) are
 * left alone, so their clients can reconnect with them.
 */
export function spendEmbedTokens(presented: readonly string[]): boolean {
  // The token store's clock, which the expiry times come from.
  const at = Date.now();
  let fresh = true;
  for (const token of presented) {
    const key = hashToken(token);
    const spentUntil = spentEmbedTokens.get(key);
    if (spentUntil !== undefined && spentUntil > at) {
      fresh = false;
      continue;
    }
    const grant = cloudSessionTokens.grant(token);
    if (grant?.project?.source !== "embed") continue;
    spentEmbedTokens.set(key, grant.expiresAt);
    cloudSessionTokens.revoke(token);
  }
  if (spentEmbedTokens.size > 10_000) {
    for (const [key, until] of spentEmbedTokens) if (until <= at) spentEmbedTokens.delete(key);
  }
  return fresh;
}
