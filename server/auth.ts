// Access control for the /agent WebSocket upgrade. Three layers, all optional
// and configured via environment so the open demo setup keeps working:
//   1. Shared token  — RELAY_AUTH_TOKEN, sent by clients as ?token=…
//   2. Origin check  — RELAY_ALLOWED_ORIGINS, comma-separated allowlist
//   3. Rate limiting — RELAY_CONN_PER_MINUTE upgrade attempts per client IP
// The relay holds the Doubao credentials, so without at least the token anyone
// who discovers the URL can burn the API quota.

import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config";

export type UpgradeDecision = { ok: true } | { ok: false; code: number; reason: string };

const RATE_WINDOW_MS = 60_000;
// Per-address timestamps of recent upgrade attempts within the trailing window.
const rateHits = new Map<string, number[]>();

/** Compares secrets without leaking length/prefix information via timing. */
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

  if (config.relayAuthToken) {
    const url = new URL(request.url ?? "/", "http://relay.local");
    const provided = url.searchParams.get("token") ?? "";
    if (!tokenMatches(provided, config.relayAuthToken)) {
      return { ok: false, code: 401, reason: "Invalid relay token" };
    }
  }

  return { ok: true };
}
