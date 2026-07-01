import "dotenv/config";
import { providerCapabilities, type AgentHealth } from "../shared/agent";

export type VoiceProvider = "mock" | "doubao";
export type WeatherLocation = {
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
  port: Number(process.env.PORT ?? 8787),
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
  // Honor X-Forwarded-For for rate limiting only behind a trusted proxy.
  trustProxy: process.env.RELAY_TRUST_PROXY?.trim().toLowerCase() === "on",
  // Number of trusted reverse proxies in front of the relay (e.g. 1 for the
  // documented single Caddy hop). The real client IP is this many entries from
  // the RIGHT of X-Forwarded-For; entries further left are client-supplied and
  // must never be trusted. Only consulted when trustProxy is on.
  trustedProxyHops: resolveBoundedInt(process.env.RELAY_TRUSTED_PROXY_HOPS, 1, 1, 10),
  // How often a live session re-fetches weather mid-ride. 0 turns refresh off.
  weatherRefreshMs: resolveBoundedInt(process.env.WEATHER_REFRESH_MS, 10 * 60_000, 0, 6 * 3_600_000),
  // Base wait for Doubao TTS audio before falling back to browser speech. The
  // doubao provider adapts upward from this floor using measured first-audio
  // latency, so a slow link doesn't trigger spurious fallbacks.
  ttsFallbackMs: resolveBoundedInt(process.env.TTS_FALLBACK_MS, 1800, 400, 10_000)
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

export function credentialStatus(): AgentHealth["credentials"] {
  if (config.voiceProvider !== "doubao") return "not-required";

  const hasApiKey = Boolean(process.env.DOUBAO_API_KEY?.trim());
  const hasLegacy = Boolean(
    process.env.DOUBAO_APP_ID?.trim() && process.env.DOUBAO_APP_KEY?.trim() && process.env.DOUBAO_ACCESS_KEY?.trim()
  );
  return hasApiKey || hasLegacy ? "configured" : "missing";
}

/** Human-readable summary printed on startup. */
export function describeConfig(): string[] {
  return [
    `Realtime voice provider: ${config.voiceProvider}`,
    `Provider credentials: ${credentialStatus()}`,
    `Weather context: Open-Meteo best-effort + ${config.defaultWeatherLocation.source} fallback`,
    `Weather mid-ride refresh: ${config.weatherRefreshMs ? `every ${Math.round(config.weatherRefreshMs / 60000)} min` : "off"}`,
    `Wake word ("Max"): ${config.wakeWord ? "on" : "off"}`,
    `Relay auth token: ${config.relayAuthToken ? "required" : "open"}`,
    `Relay origin allowlist: ${config.allowedOrigins.length ? config.allowedOrigins.join(", ") : "any"}`,
    `Relay rate limit: ${config.connPerMinute ? `${config.connPerMinute} conn/min/IP (sliding)` : "off"}`,
    `Relay proxy trust: ${config.trustProxy ? `on (${config.trustedProxyHops} hop${config.trustedProxyHops === 1 ? "" : "s"} via X-Forwarded-For)` : "off (client IP = socket address)"}`
  ];
}

/**
 * Returns warnings for configuration that will fail at request time. The
 * server still starts so the mock path stays usable while credentials are
 * being sorted out.
 */
export function validateConfig(): string[] {
  const warnings: string[] = [];

  if (config.voiceProvider === "doubao") {
    if (credentialStatus() === "missing") {
      warnings.push(
        "VOICE_PROVIDER=doubao 但缺少 DOUBAO_API_KEY 或完整的 DOUBAO_APP_ID/APP_KEY/ACCESS_KEY：实时语音会话将无法建立。"
      );
    }
    if (!config.relayAuthToken) {
      warnings.push(
        "RELAY_AUTH_TOKEN 未设置：任何发现该地址的人都能消耗豆包配额。生产部署请设置一个随机令牌，客户端通过 ?token=… 连接。"
      );
    }
  }

  if (config.allowedOrigins.length && !config.relayAuthToken) {
    warnings.push(
      "RELAY_ALLOWED_ORIGINS 已设置但 RELAY_AUTH_TOKEN 未设置：来源白名单只能拦截浏览器，不发送 Origin 头的原生 App 或脚本仍可连接。请同时设置令牌。"
    );
  }

  // Behind a reverse proxy (the documented Caddy/Lightsail deploy), every client
  // shares the proxy's socket address unless X-Forwarded-For is trusted, so the
  // per-IP limiter collapses into a single global bucket that can lock everyone
  // out. Flag it when running the real backend without proxy trust enabled.
  if (config.voiceProvider === "doubao" && config.connPerMinute > 0 && !config.trustProxy) {
    warnings.push(
      "RELAY_CONN_PER_MINUTE 已启用但 RELAY_TRUST_PROXY=off：若本服务位于反向代理（如部署文档中的 Caddy）之后，所有客户端会被算作同一个代理 IP，速率限制会退化为全局限制并可能锁死所有人。反代后请设置 RELAY_TRUST_PROXY=on（并按需设置 RELAY_TRUSTED_PROXY_HOPS）。"
    );
  }

  return warnings;
}

export function buildHealth(uptimeSec: number): AgentHealth {
  return {
    ok: true,
    provider: config.voiceProvider,
    uptimeSec,
    credentials: credentialStatus(),
    weather: "available",
    capabilities: providerCapabilities(config.voiceProvider)
  };
}
