import { randomBytes } from "node:crypto";

/**
 * Short-lived session tokens: how a browser on someone else's website talks to
 * the relay without ever seeing the relay's secret.
 *
 * The owner's backend, which holds RELAY_AUTH_TOKEN, asks for a token
 * (`POST /v1/session-tokens`) when its page loads and hands it to the page.
 * The page opens `/agent?token=vst_…` with it. A token:
 *
 * - opens voice sessions until it expires (default 10 minutes, at most an
 *   hour), so the SDK can reconnect after a dropped network;
 * - grants nothing else — no admin routes, no testing data;
 * - can carry a `userId` and `context` the client cannot change, which reach
 *   tools and the assistant's instructions.
 *
 * Tokens live in memory: a restart revokes every one, which is the safe
 * direction to fail in. Run one relay per token issuer, or make the backend
 * fetch a fresh token when a connect is refused.
 */

export const SESSION_TOKEN_PREFIX = "vst_";
export const DEFAULT_TOKEN_TTL_SECONDS = 600;
export const MIN_TOKEN_TTL_SECONDS = 30;
export const MAX_TOKEN_TTL_SECONDS = 3600;
const MAX_LIVE_TOKENS = 50_000;
const MAX_USER_ID_CHARS = 128;
const MAX_CONTEXT_CHARS = 4_000;

type SessionTokenGrant = {
  expiresAt: number;
  userId?: string;
  context?: string;
  /** Set when a Max Cloud project's API key minted the token: the session
   *  runs as that project and is billed to its customer. */
  project?: CloudProjectGrant;
};

type MintRequest = { ttlSeconds?: unknown; userId?: unknown; context?: unknown };

/** The Max Cloud project a token runs as, and where the session was started:
 *  "api" (the project key minted it), "test" (the console's Test panel) or
 *  "embed" (the public widget on an allowed website). */
type CloudProjectGrant = {
  projectId: string;
  customerId: string;
  keyHash: string;
  source?: "api" | "test" | "embed";
  /** Embed tokens: the website that asked for it, the only Origin it opens a session from. */
  origin?: string;
};

export type SessionTokenStore = {
  /** Validates a request body and issues a token, or explains what is wrong. */
  mint(
    request: MintRequest,
    project?: CloudProjectGrant
  ): { ok: true; token: string; expiresAt: number } | { ok: false; error: string };
  /** The grant behind a live token, if any. */
  grant(token: string | null | undefined): SessionTokenGrant | undefined;
  /** Revokes a token now. */
  revoke(token: string): void;
  /** Live tokens (for tests and metrics). */
  size(): number;
};

export type SessionTokenLimits = {
  /** Live tokens in the whole store; the oldest goes first when full. */
  maxLive?: number;
  /** Live tokens per project; that project's own oldest goes first. */
  perProject?: number;
  maxContextChars?: number;
};

export function createSessionTokenStore(
  now: () => number = Date.now,
  limits: SessionTokenLimits = {}
): SessionTokenStore {
  const maxLive = limits.maxLive ?? MAX_LIVE_TOKENS;
  const maxContext = limits.maxContextChars ?? MAX_CONTEXT_CHARS;
  // Insertion order is issue order, so the first entries are the oldest.
  const tokens = new Map<string, SessionTokenGrant>();

  function prune(at: number): void {
    for (const [token, grant] of tokens) if (grant.expiresAt <= at) tokens.delete(token);
  }

  return {
    mint(request, project) {
      const ttl = request.ttlSeconds === undefined ? DEFAULT_TOKEN_TTL_SECONDS : Number(request.ttlSeconds);
      if (!Number.isInteger(ttl) || ttl < MIN_TOKEN_TTL_SECONDS || ttl > MAX_TOKEN_TTL_SECONDS) {
        return {
          ok: false,
          error: `ttlSeconds must be a whole number from ${MIN_TOKEN_TTL_SECONDS} to ${MAX_TOKEN_TTL_SECONDS}`
        };
      }
      if (
        request.userId !== undefined &&
        (typeof request.userId !== "string" || !request.userId.trim() || request.userId.length > MAX_USER_ID_CHARS)
      ) {
        return { ok: false, error: `userId must be a non-empty string of at most ${MAX_USER_ID_CHARS} characters` };
      }
      if (
        request.context !== undefined &&
        (typeof request.context !== "string" || request.context.length > maxContext)
      ) {
        return { ok: false, error: `context must be a string of at most ${maxContext} characters` };
      }
      const at = now();
      prune(at);
      if (project && limits.perProject) {
        // A project can only ever push out its own tokens, and public-embed tokens (which
        // anyone visiting a listed website can mint) only other embed tokens.
        const embed = project.source === "embed";
        const own = [...tokens].filter(
          ([, grant]) => grant.project?.projectId === project.projectId && (grant.project.source === "embed") === embed
        );
        for (const [token] of own.slice(0, Math.max(0, own.length - limits.perProject + 1))) tokens.delete(token);
      }
      while (tokens.size >= maxLive) {
        const oldest = tokens.keys().next().value;
        if (oldest === undefined) break;
        tokens.delete(oldest);
      }
      const token = `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const expiresAt = at + ttl * 1000;
      tokens.set(token, {
        expiresAt,
        ...(typeof request.userId === "string" ? { userId: request.userId.trim() } : {}),
        ...(typeof request.context === "string" && request.context.trim() ? { context: request.context.trim() } : {}),
        ...(project ? { project: { ...project } } : {})
      });
      return { ok: true, token, expiresAt };
    },

    grant(token) {
      if (!token || !token.startsWith(SESSION_TOKEN_PREFIX)) return undefined;
      // A hashed lookup of 256 random bits: guessing is the only attack, and
      // timing reveals nothing useful about a value that is not stored in order.
      const found = tokens.get(token);
      if (!found) return undefined;
      if (found.expiresAt <= now()) {
        tokens.delete(token);
        return undefined;
      }
      return found;
    },

    revoke(token) {
      tokens.delete(token);
    },

    size() {
      prune(now());
      return tokens.size;
    }
  };
}

/** The relay's token store. */
export const sessionTokens = createSessionTokenStore();

/** Max Cloud projects' tokens, kept apart: anyone can sign up for Cloud, and
 *  nothing they mint may push out the relay's own tokens. */
export const cloudSessionTokens = createSessionTokenStore(Date.now, {
  maxLive: 20_000,
  perProject: 200,
  maxContextChars: 1_000
});
