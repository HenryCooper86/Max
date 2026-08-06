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
import type express from "express";
import { config } from "./config";

const SERVICE_PREFIX = "/_AMapService"; // no trailing slash: reused as the slice point below
const STYLES_PREFIX = SERVICE_PREFIX + "/v4/map/styles";
const VECTORMAP_PREFIX = SERVICE_PREFIX + "/v3/vectormap";

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
 * Pure gate for the `/_AMapService/*` proxy: same-origin only. Amap's own JS
 * SDK always sends a Referer from a browser, so requiring one to MATCH the
 * relay's own origin when present is enough to stop another site from
 * riding this relay's proxy (and thus its jscode secret) for its own map
 * traffic. No Referer at all (curl, server-side tooling, some QA harnesses)
 * is allowed through rather than rejected — browsers are the only client
 * this gate needs to constrain, and they never omit Referer for a same-tab
 * navigation/XHR to a same-site path like this one.
 */
export function isAllowedProxyReferer(referer: string | undefined, selfOrigin: string): boolean {
  if (!referer) return true;
  try {
    return new URL(referer).origin === selfOrigin;
  } catch {
    return false;
  }
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
    const selfOrigin = `${req.protocol}://${req.get("host")}`;
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
    try {
      // Forward Referer upstream: Amap's domain allowlist on the JS key gates
      // via Referer, so a domain-restricted key would otherwise see every
      // request as referer-less and reject it once it's behind this proxy.
      const upstream = await fetch(target, {
        signal: AbortSignal.timeout(8000),
        headers: referer ? { referer } : undefined
      });
      res.status(upstream.status);
      const type = upstream.headers.get("content-type");
      if (type) res.setHeader("Content-Type", type);
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      // Never surface upstream error details (they may echo the request URL,
      // which carries jscode) — an empty 502 is all the client needs.
      res.status(502).end();
    }
  });
}
