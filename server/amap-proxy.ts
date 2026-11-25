// Amap JS API 2.0 requires a 安全密钥 (security secret, `AMAP_JS_SECRET`) on
// every request the map SDK makes to Amap's tile/style/geocoding hosts. That
// secret must never reach the browser, so it is never embedded in the JS
// bundle and never returned by any HTTP response. Instead, the relay hosts
// this proxy — the browser is configured (via `window._AMapSecurityConfig`,
// see NavigationPanel.tsx) to route those requests through
// `/_AMapService/...` on the relay's own origin, and this module appends
// `jscode=<secret>` server-side before forwarding upstream. `/nav/js-config`
// serves only the public JS key (`AMAP_JS_KEY`), which is safe client-side —
// Amap's referer/domain restrictions gate that key, not secrecy.
//
// The three upstream hosts below are Amap's documented production-proxy
// mapping (https://lbs.amap.com/api/javascript-api/guide/abc/prepare, "使用安全密钥");
// every other `/_AMapService/*` path falls through to restapi.amap.com,
// which serves the JS SDK's POI/geocode/search calls.
//
// Every request proxied is signed with the operator's secret and spends the
// operator's Amap quota, and anyone who finds the relay can send one. What
// bounds that is in the route below: a per-address rate limit and a cap on
// how much is read of an answer. There is no login gate: the page is public
// static content (its sign-in screen is part of it), and the Amap SDK makes
// these requests itself, with no way to carry the app's bearer token.
import type express from "express";
import { config } from "./config";
import { checkAuthRateLimit, clientAddress } from "./auth";

const SERVICE_PREFIX = "/_AMapService"; // no trailing slash: reused as the slice point below
const STYLES_PREFIX = SERVICE_PREFIX + "/v4/map/styles";
const VECTORMAP_PREFIX = SERVICE_PREFIX + "/v3/vectormap";

/** The most that is read of one upstream answer. A tile, a style or a search result is a few hundred KB: more than this is not the map asking. */
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;
/** How long an answer may take, reading it included. */
const UPSTREAM_TIMEOUT_MS = 8_000;

/**
 * Pure URL mapper: `/_AMapService/...` (path + query string) → the fully
 * qualified upstream Amap URL, with `jscode=<secret>` appended to the query.
 * Returns null for anything outside the `/_AMapService/` prefix so the route
 * handler can 404 instead of guessing. `path` must match on full path
 * segments — `/_AMapServiceX/...` is NOT `/_AMapService/...` and must map to
 * null, not a truncated upstream path.
 */
export function amapProxyTarget(path: string, search: string, jscode: string): string | null {
  // Full-segment match only: "/_AMapServiceX/..." must NOT be treated as
  // "/_AMapService/..." with a stray suffix on the first segment.
  if (!path.startsWith(SERVICE_PREFIX + "/")) return null;

  const rest = path.slice(SERVICE_PREFIX.length); // leading "/…", e.g. "/v4/map/styles"
  let upstreamBase: string;
  if (path === STYLES_PREFIX || path.startsWith(STYLES_PREFIX + "/")) {
    upstreamBase = "https://webapi.amap.com" + rest;
  } else if (path === VECTORMAP_PREFIX || path.startsWith(VECTORMAP_PREFIX + "/")) {
    upstreamBase = "https://fmap01.amap.com" + rest;
  } else {
    upstreamBase = "https://restapi.amap.com" + rest;
  }

  const separator = search ? "&" : "?";
  return `${upstreamBase}${search}${separator}jscode=${encodeURIComponent(jscode)}`;
}

/**
 * Pure gate for the `/_AMapService/*` proxy: a Referer that is present must
 * match the relay's own origin. That is what stops another site's page from
 * riding this relay's proxy (and thus its jscode secret) for its own map
 * traffic: a browser always sends that page's origin as the Referer.
 *
 * No Referer at all is allowed, and has to be: the relay serves its own pages
 * with `Referrer-Policy: no-referrer` (server/index.ts), so the Amap SDK's
 * requests from the real map arrive without one. Refusing them would leave
 * the map blank. This gate is for browsers only, since anything else can
 * send whatever Referer it likes; what bounds the proxy is its per-address
 * rate limit and the cap on how much of an answer it reads, in the route
 * below.
 */
export function isAllowedProxyReferer(referer: string | undefined, selfOrigin: string): boolean {
  if (!referer) return true;
  try {
    return new URL(referer).origin === selfOrigin;
  } catch {
    return false;
  }
}

/**
 * Pure scheme resolver for the Referer-origin gate above. Behind the
 * documented Caddy/Lightsail deploy, TLS terminates at the proxy and Express
 * sees plain HTTP, so `req.protocol` alone would make `selfOrigin` always
 * "http://…" and reject every legitimate "https://…" browser Referer. Mirrors
 * `clientAddress()` in server/auth.ts: X-Forwarded-* is only trustworthy when
 * the operator has explicitly declared a trusted proxy (RELAY_TRUST_PROXY),
 * since otherwise a client could spoof it directly.
 */
export function resolveRequestScheme(
  reqProtocol: string,
  forwardedProto: string | undefined,
  trustProxy: boolean
): string {
  if (trustProxy && forwardedProto) {
    const first = forwardedProto.split(",")[0]?.trim();
    if (first) return first;
  }
  return reqProtocol;
}

/** Registers `/nav/js-config` and the `/_AMapService/*` proxy. Must be
 *  mounted before the static/SPA-fallback block so these routes aren't
 *  swallowed by it. */
export function registerAmapRoutes(app: express.Express): void {
  // Public JS key only — never the secret. Null when unset so the client
  // hides the tile map and keeps the always-on schematic.
  app.get("/nav/js-config", (_req, res) => {
    res.json({ key: config.amapJsKey || null });
  });

  app.get(/^\/_AMapService\//, async (req, res) => {
    if (!config.amapJsSecret) {
      res.status(404).end();
      return;
    }
    const referer = req.get("referer");
    const scheme = resolveRequestScheme(req.protocol, req.get("x-forwarded-proto"), config.trustProxy);
    const selfOrigin = `${scheme}://${req.get("host")}`;
    if (!isAllowedProxyReferer(referer, selfOrigin)) {
      res.status(403).end();
      return;
    }
    const search = req.originalUrl.includes("?") ? "?" + req.originalUrl.split("?")[1] : "";
    const target = amapProxyTarget(req.path, search, config.amapJsSecret);
    if (!target) {
      res.status(404).end();
      return;
    }
    // The relay's limiter, in a bucket of its own: map tiles must neither use
    // up anybody's login attempts nor be held to ten a minute.
    if (!checkAuthRateLimit(clientAddress(req), Date.now(), "amap-proxy", config.amapProxyPerMinute)) {
      res.status(429).setHeader("Retry-After", "60").end();
      return;
    }
    try {
      // Forward Referer upstream: Amap's domain allowlist on the JS key gates
      // via Referer, so a domain-restricted key would otherwise see every
      // request as referer-less and reject it once it's behind this proxy.
      const upstream = await fetch(target, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: referer ? { referer } : undefined
      });
      // Read to the end before anything is sent: once an answer has begun
      // there is no taking it back to say 502.
      const body = await readCapped(upstream);
      if (!body) {
        res.status(502).end();
        return;
      }
      res.status(upstream.status);
      const type = upstream.headers.get("content-type");
      if (type) res.setHeader("Content-Type", type);
      res.send(body);
    } catch {
      // Never surface upstream error details (they may echo the request URL,
      // which carries jscode) — an empty 502 is all the client needs.
      res.status(502).end();
    }
  });
}

/**
 * The upstream answer, read as it comes and no further than
 * MAX_UPSTREAM_BYTES. Undefined when there is more than that, so that the
 * caller can still answer 502; nothing larger than the cap is ever held.
 */
async function readCapped(response: Response): Promise<Buffer | undefined> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_UPSTREAM_BYTES) {
      // Stop the download rather than drain it: the relay is not a pipe to Amap.
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
