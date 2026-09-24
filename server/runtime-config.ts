import "dotenv/config";

type VoiceProvider = "mock" | "doubao";
type WeatherLocation = {
  lat: number;
  lon: number;
  source: "configured" | "demo";
};

const DEMO_WEATHER_LOCATION = {
  // Seoul City Hall, close to the Lightsail test region and useful for demos
  // when browser geolocation is denied.
  lat: 37.5665,
  lon: 126.978,
  source: "demo" as const
};

/** Backend configuration resolved from environment variables at startup. */
export const config = {
  // Bounded like every other numeric env var: PORT="" would otherwise become 0
  // (bind a random ephemeral port) and a typo would crash listen() with NaN.
  port: resolveBoundedInt(process.env.PORT, 8787, 1, 65_535),
  voiceProvider: (process.env.VOICE_PROVIDER === "doubao" ? "doubao" : "mock") as VoiceProvider,
  defaultWeatherLocation: resolveDefaultWeatherLocation(),
  // When on, the live agent only replies when the rider addresses it by name
  // ("Max"); set AGENT_WAKE_WORD=off to make it answer every utterance again.
  wakeWord: process.env.AGENT_WAKE_WORD?.trim().toLowerCase() !== "off",
  // Shared secret for the /agent WebSocket (clients send it as ?token=…).
  // Empty disables auth so the local demo stays plug-and-play.
  relayAuthToken: process.env.RELAY_AUTH_TOKEN?.trim() ?? "",
  // Browser Origin allowlist for /agent. Empty allows every origin.
  allowedOrigins: (process.env.RELAY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean),
  // Upgrade attempts allowed per client IP per minute; 0 disables the limiter.
  connPerMinute: resolveBoundedInt(process.env.RELAY_CONN_PER_MINUTE, 30, 0, 10_000),
  // Hard ceiling for one reassembled WebSocket message. The ws package's
  // default is 100 MiB — far larger than this relay needs and large enough to
  // exhaust the small Lightsail host, so we cap it much lower. But ws enforces
  // this ceiling before the "message" event fires, and rejects an oversized
  // message by terminating the connection outright, not with a catchable
  // error — for /agent that connection is the rider's live voice session.
  // The floor (and default) must therefore clear MAX_CLIENT_JSON_BYTES
  // (session-controller.ts, 256 KiB — sized for a camera.frame image up to
  // 200_000 base64 chars, ~195 KiB). If this ceiling could sit at or below
  // that JSON gate, ws would silently drop the session on a slightly
  // oversized frame instead of the relay returning a clean
  // "Invalid camera.frame image" error. 320 KiB / 384 KiB leave headroom
  // above the 256 KiB gate; the 32 KiB audio protocol stays far under both.
  maxPayloadBytes: resolveBoundedInt(process.env.RELAY_MAX_PAYLOAD_BYTES, 384 * 1024, 320 * 1024, 1024 * 1024),
  // Honor X-Forwarded-For for rate limiting only behind a trusted proxy.
  trustProxy: process.env.RELAY_TRUST_PROXY?.trim().toLowerCase() === "on",
  // Number of trusted reverse proxies in front of the relay (e.g. 1 for the
  // documented single Caddy hop). The real client IP is this many entries from
  // the RIGHT of X-Forwarded-For; entries further left are client-supplied and
  // must never be trusted. Only consulted when trustProxy is on.
  trustedProxyHops: resolveBoundedInt(process.env.RELAY_TRUSTED_PROXY_HOPS, 1, 1, 10),
  // Liveness heartbeat for /agent clients: ping cadence; a client that misses
  // a full interval without a pong is terminated (half-open TCP links would
  // otherwise hold their Doubao upstream forever). 0 disables pinging.
  heartbeatMs: resolveBoundedInt(process.env.RELAY_HEARTBEAT_MS, 30_000, 0, 300_000),
  // Close /agent sessions with no client traffic (events or mic frames) for
  // this long, freeing the upstream slot held by a forgotten tab. Clients see
  // close code 4001 (IDLE_CLOSE_CODE) and must not auto-reconnect. 0 disables.
  idleTimeoutMs: resolveBoundedInt(process.env.RELAY_IDLE_TIMEOUT_MS, 10 * 60_000, 0, 24 * 3_600_000),
  // How often a live session re-fetches weather mid-ride. 0 turns refresh off.
  weatherRefreshMs: resolveBoundedInt(process.env.WEATHER_REFRESH_MS, 10 * 60_000, 0, 6 * 3_600_000),
  // Base wait for Doubao TTS audio before falling back to browser speech. The
  // doubao provider adapts upward from this floor using measured first-audio
  // latency, so a slow link doesn't trigger spurious fallbacks.
  ttsFallbackMs: resolveBoundedInt(process.env.TTS_FALLBACK_MS, 1800, 400, 10_000),
  // User accounts (/auth/register): set AUTH_REGISTRATION=off once the test
  // team is onboarded so strangers can't self-register on a reachable relay.
  authRegistration: process.env.AUTH_REGISTRATION?.trim().toLowerCase() !== "off",
  // Login session lifetime, in days.
  authSessionDays: resolveBoundedInt(process.env.AUTH_SESSION_DAYS, 30, 1, 365),
  // Login/registration attempts allowed per client IP per minute.
  authAttemptsPerMinute: resolveBoundedInt(process.env.AUTH_ATTEMPTS_PER_MINUTE, 10, 3, 1000),
  // Crash escalation delivery channel. Only "log" exists today: incidents are
  // audited but nobody is texted, and the ack says so honestly.
  crashNotifier: process.env.CRASH_NOTIFIER?.trim().toLowerCase() || "log",
  // Amap Web 服务 key for relay-side routing. Empty selects the mock route
  // provider, so navigation demos keylessly like the mock voice provider.
  amapApiKey: process.env.AMAP_API_KEY?.trim() ?? "",
  // Web 端 (JS API) key served to the browser HUD; the map panel hides without it.
  amapJsKey: process.env.AMAP_JS_KEY?.trim() ?? "",
  // JS API 安全密钥 — used only inside the /_AMapService proxy, never sent to a client.
  amapJsSecret: process.env.AMAP_JS_SECRET?.trim() ?? ""
};

function resolveBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  // Treat empty/whitespace as unset: Number("") is 0, which would otherwise be
  // clamped to `min` instead of falling back to the intended default.
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function resolveDefaultWeatherLocation(): WeatherLocation {
  const latValue = process.env.DEFAULT_RIDER_LAT?.trim() || process.env.WEATHER_DEFAULT_LAT?.trim();
  const lonValue = process.env.DEFAULT_RIDER_LON?.trim() || process.env.WEATHER_DEFAULT_LON?.trim();
  if (!latValue || !lonValue) return DEMO_WEATHER_LOCATION;

  const lat = Number(latValue);
  const lon = Number(lonValue);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return DEMO_WEATHER_LOCATION;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return DEMO_WEATHER_LOCATION;
  return { lat, lon, source: "configured" };
}
