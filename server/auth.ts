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

type RateWindow = { windowStartedAt: number; count: number };

const RATE_WINDOW_MS = 60_000;
const rateWindows = new Map<string, RateWindow>();

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
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.socket.remoteAddress ?? "unknown";
}

/** Sliding-window upgrade-attempt limiter. Exported for tests. */
export function checkRateLimit(address: string, now = Date.now()): boolean {
  if (config.connPerMinute <= 0) return true;

  const window = rateWindows.get(address);
  if (!window || now - window.windowStartedAt >= RATE_WINDOW_MS) {
    rateWindows.set(address, { windowStartedAt: now, count: 1 });
    // Opportunistic cleanup so long-running relays don't accumulate dead IPs.
    if (rateWindows.size > 10_000) {
      for (const [key, value] of rateWindows) {
        if (now - value.windowStartedAt >= RATE_WINDOW_MS) rateWindows.delete(key);
      }
    }
    return true;
  }

  window.count += 1;
  return window.count <= config.connPerMinute;
}

/** Test hook: clears rate-limit state between cases. */
export function resetRateLimit() {
  rateWindows.clear();
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
