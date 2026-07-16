// Access control for the /agent WebSocket upgrade. Three layers, all optional
// and configured via environment so the open demo setup keeps working:
//   1. Shared token  — RELAY_AUTH_TOKEN, sent by clients as ?token=…
//   2. Origin check  — RELAY_ALLOWED_ORIGINS, comma-separated allowlist
//   3. Rate limiting — RELAY_CONN_PER_MINUTE upgrade attempts per client IP
// The relay holds the Doubao credentials, so without at least the token anyone
// who discovers the URL can burn the API quota.

import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { authActive, sessionUser, type PublicUser } from "./accounts";
import { config } from "./config";

export type UpgradeDecision = { ok: true } | { ok: false; code: number; reason: string };

const RATE_WINDOW_MS = 60_000;
// Per-address timestamps of recent upgrade attempts within the trailing window.
const rateHits = new Map<string, number[]>();

/**
 * Compares secrets without leaking prefix information via timing. The length
 * pre-check is mandatory — timingSafeEqual throws on unequal-length buffers — so
 * the expected length is (negligibly, for a high-entropy token) observable; only
 * the byte-by-byte comparison is constant-time.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function clientAddress(request: IncomingMessage): string {
  // Trust the proxy header only when explicitly enabled — otherwise any client
  // could spoof X-Forwarded-For to dodge the per-IP limit.
  if (config.trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    const entries = (raw ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    // Proxies APPEND the address they received from, so the real client IP is
    // `trustedProxyHops` entries from the right; anything further left was set
    // by the client and is spoofable. Taking the leftmost entry (as before)
    // would let a client forge its own IP and evade the per-IP limit.
    const candidate = entries[entries.length - config.trustedProxyHops];
    if (candidate) return candidate;
  }
  return request.socket.remoteAddress ?? "unknown";
}

export function clientRegionHint(request: IncomingMessage): string | undefined {
  const candidate =
    request.headers["cf-ipcountry"] ??
    request.headers["x-vercel-ip-country-region"] ??
    request.headers["x-vercel-ip-country"];
  const value = Array.isArray(candidate) ? candidate[0] : candidate;
  return value?.trim() || undefined;
}

/**
 * Sliding-window upgrade-attempt limiter: allows at most `connPerMinute`
 * attempts per address across any trailing 60 s span (not a fixed bucket that
 * resets on the minute, which would permit a ~2× burst across the boundary).
 * Exported for tests.
 */
export function checkRateLimit(address: string, now = Date.now()): boolean {
  if (config.connPerMinute <= 0) return true;

  const cutoff = now - RATE_WINDOW_MS;
  const recent = (rateHits.get(address) ?? []).filter((at) => at > cutoff);

  if (recent.length >= config.connPerMinute) {
    // Persist the pruned list so a blocked address can't grow memory unbounded.
    rateHits.set(address, recent);
    return false;
  }

  recent.push(now);
  rateHits.set(address, recent);

  // Opportunistic cleanup so long-running relays don't accumulate dead IPs.
  if (rateHits.size > 10_000) {
    for (const [key, value] of rateHits) {
      const pruned = value.filter((at) => at > cutoff);
      if (pruned.length === 0) rateHits.delete(key);
      else rateHits.set(key, pruned);
    }
  }

  return true;
}

/** Test hook: clears rate-limit state between cases. */
export function resetRateLimit() {
  rateHits.clear();
}

/** The credentials a request presented: `?token=…` and/or a Bearer header. */
function presentedTokens(request: IncomingMessage): string[] {
  const url = new URL(request.url ?? "/", "http://relay.local");
  const fromQuery = url.searchParams.get("token") ?? "";
  const authorization = request.headers.authorization ?? "";
  const fromHeader = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  return [fromQuery, fromHeader].filter(Boolean);
}

function matchesRelayToken(tokens: string[]): boolean {
  if (!config.relayAuthToken) return false;
  return tokens.some((token) => tokenMatches(token, config.relayAuthToken));
}

/** True when the request presented the configured operator relay token. */
export function relayTokenPresented(request: IncomingMessage): boolean {
  return matchesRelayToken(presentedTokens(request));
}

/** The logged-in user behind a request's session token, if any. */
export function requestUser(request: IncomingMessage): PublicUser | null {
  for (const token of presentedTokens(request)) {
    const user = sessionUser(token);
    if (user) return user;
  }
  return null;
}

/**
 * Whether an HTTP request may see the per-tester QA statistics (IPs, regions,
 * chat transcripts). Open only while NEITHER a relay token is configured NOR
 * any user account exists — the documented plug-and-play internal mode. Once
 * either is in place, the request must present the relay token (?token=… or
 * Authorization: Bearer …) or a valid login session. /health liveness fields
 * stay open either way, so the one-curl deployment check keeps working.
 */
export function testingStatsAuthorized(request: IncomingMessage): boolean {
  return testingAccess(request).allowed;
}

export type TestingAccess =
  | { allowed: true; role: "operator" | "admin" | "reviewer"; testerId?: undefined }
  | { allowed: true; role: "tester"; testerId: string }
  | { allowed: false; role: "anonymous"; testerId?: undefined };

/** Evidence scope for HTTP APIs: testers see only their own rows, while
 * reviewers/admins/operator tokens may inspect the complete release corpus. */
export function testingAccess(request: IncomingMessage): TestingAccess {
  if (matchesRelayToken(presentedTokens(request))) return { allowed: true, role: "operator" };
  if (!config.relayAuthToken && !authActive()) return { allowed: true, role: "admin" };
  const user = requestUser(request);
  if (!user) return { allowed: false, role: "anonymous" };
  if (user.role === "admin" || user.role === "reviewer") return { allowed: true, role: user.role };
  return { allowed: true, role: "tester", testerId: user.username };
}

/**
 * Whether a request may DELETE tester QA data (/testing/clear). Stricter than
 * viewing: once user accounts exist, only an admin login (or the relay token,
 * which remains the operator master key) may clear.
 */
export function testingClearAuthorized(request: IncomingMessage): boolean {
  if (!config.relayAuthToken && !authActive()) return true;
  if (matchesRelayToken(presentedTokens(request))) return true;
  return requestUser(request)?.role === "admin";
}

// Login/registration attempts get their own, deliberately tight sliding
// window per client IP — independent of the /agent upgrade limiter so a
// password-guessing loop can't ride on a generous RELAY_CONN_PER_MINUTE.
const authHits = new Map<string, number[]>();

export function checkAuthRateLimit(address: string, now = Date.now()): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  const recent = (authHits.get(address) ?? []).filter((at) => at > cutoff);
  if (recent.length >= config.authAttemptsPerMinute) {
    authHits.set(address, recent);
    return false;
  }
  recent.push(now);
  authHits.set(address, recent);
  if (authHits.size > 10_000) {
    for (const [key, value] of authHits) {
      const pruned = value.filter((at) => at > cutoff);
      if (pruned.length === 0) authHits.delete(key);
      else authHits.set(key, pruned);
    }
  }
  return true;
}

/** Test hook: clears auth rate-limit state between cases. */
export function resetAuthRateLimit() {
  authHits.clear();
}

export function authorizeUpgrade(request: IncomingMessage, now = Date.now()): UpgradeDecision {
  if (!checkRateLimit(clientAddress(request), now)) {
    return { ok: false, code: 429, reason: "Too many connection attempts" };
  }

  if (config.allowedOrigins.length) {
    const origin = request.headers.origin;
    // Native apps (iOS/Android/health checks) send no Origin header; the
    // allowlist guards browsers, where a hostile page could otherwise open
    // the relay cross-site. Token auth covers the no-Origin case.
    if (origin && !config.allowedOrigins.includes(origin)) {
      return { ok: false, code: 403, reason: "Origin not allowed" };
    }
  }

  // The voice line requires credentials once EITHER protection is in place:
  // the shared relay token, or user accounts (site login gate). A logged-in
  // user's session token is as good as the operator secret, so web testers
  // are never handed the shared token. With neither configured the relay
  // stays plug-and-play open, as documented.
  if (config.relayAuthToken || authActive()) {
    const url = new URL(request.url ?? "/", "http://relay.local");
    const provided = url.searchParams.get("token") ?? "";
    const relayTokenOk = config.relayAuthToken ? tokenMatches(provided, config.relayAuthToken) : false;
    if (!relayTokenOk && !sessionUser(provided)) {
      return { ok: false, code: 401, reason: "Login or relay token required" };
    }
  }

  return { ok: true };
}
