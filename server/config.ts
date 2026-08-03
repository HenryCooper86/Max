import "dotenv/config";
import { providerCapabilities, type AgentHealth } from "../shared/agent";
import { buildInfo } from "./build-info";
// Runtime-only use inside buildHealth/describeConfig; accounts.ts references
// config only inside functions, so this import cycle never bites at load time.
import { accountsStorageHealthy, authActive, registrationOpen } from "./accounts";
import { metrics, metricsWindow, testingSnapshot } from "./metrics";
import { userMemoryEnabled, userMemoryStorageHealthy } from "./user-memory";

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
  crashNotifier: process.env.CRASH_NOTIFIER?.trim().toLowerCase() || "log"
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

function credentialStatus(): AgentHealth["credentials"] {
  if (config.voiceProvider !== "doubao") return "not-required";

  const hasApiKey = Boolean(process.env.DOUBAO_API_KEY?.trim());
  const hasLegacy = Boolean(
    process.env.DOUBAO_APP_ID?.trim() && process.env.DOUBAO_APP_KEY?.trim() && process.env.DOUBAO_ACCESS_KEY?.trim()
  );
  return hasApiKey || hasLegacy ? "configured" : "missing";
}

/** "45 s" below one minute, "10 min" from there up. */
function describeDuration(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
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
    `User accounts: ${authActive() ? "active" : "none yet"} · registration ${config.authRegistration ? "open" : "closed"}`,
    `Per-user conversation memory: ${userMemoryEnabled() ? "on" : "off"}`,
    `Relay origin allowlist: ${config.allowedOrigins.length ? config.allowedOrigins.join(", ") : "any"}`,
    `Relay rate limit: ${config.connPerMinute ? `${config.connPerMinute} conn/min/IP (sliding)` : "off"}`,
    `Relay message ceiling: ${Math.round(config.maxPayloadBytes / 1024)} KiB`,
    `Relay heartbeat: ${config.heartbeatMs ? `ping every ${Math.round(config.heartbeatMs / 1000)} s` : "off"}`,
    `Relay idle timeout: ${config.idleTimeoutMs ? describeDuration(config.idleTimeoutMs) : "off"}`,
    `Relay proxy trust: ${config.trustProxy ? `on (${config.trustedProxyHops} hop${config.trustedProxyHops === 1 ? "" : "s"} via X-Forwarded-For)` : "off (client IP = socket address)"}`,
    `事故通知通道: ${config.crashNotifier}`
  ];
}

/**
 * Returns warnings for configuration that will fail at request time. The
 * server still starts so the mock path stays usable while credentials are
 * being sorted out.
 */
export function validateConfig(): string[] {
  const warnings: string[] = [];
  const hasAccountProtection = authActive();

  if (config.voiceProvider === "doubao") {
    if (credentialStatus() === "missing") {
      warnings.push(
        "VOICE_PROVIDER=doubao 但缺少 DOUBAO_API_KEY 或完整的 DOUBAO_APP_ID/APP_KEY/ACCESS_KEY：实时语音会话将无法建立。"
      );
    }
    if (!config.relayAuthToken && !hasAccountProtection) {
      warnings.push(
        "RELAY_AUTH_TOKEN 未设置：任何发现该地址的人都能消耗豆包配额。生产部署请设置一个随机令牌，客户端通过 ?token=… 连接。"
      );
    }
  }

  if (config.allowedOrigins.length && !config.relayAuthToken && !hasAccountProtection) {
    warnings.push(
      "RELAY_ALLOWED_ORIGINS 已设置但 RELAY_AUTH_TOKEN 未设置：来源白名单只能拦截浏览器，不发送 Origin 头的原生 App 或脚本仍可连接。请同时设置令牌。"
    );
  }

  // Behind a reverse proxy (the documented Caddy/Lightsail deploy), every client
  // shares the proxy's socket address unless X-Forwarded-For is trusted, so the
  // per-IP limiter collapses into a single global bucket that can lock everyone
  // out. Flag it when running the real backend without proxy trust enabled.
  if (config.voiceProvider === "doubao" && !config.trustProxy) {
    warnings.push(
      "RELAY_TRUST_PROXY=off：若本服务位于反向代理（如部署文档中的 Caddy）之后，所有客户端会被算作同一个代理 IP —— WebSocket 速率限制和 /auth 登录限制（每 IP 每分钟 " +
        `${config.authAttemptsPerMinute} 次）都会退化为全局限制并可能锁死所有人。反代后请设置 RELAY_TRUST_PROXY=on（并按需设置 RELAY_TRUSTED_PROXY_HOPS）。`
    );
  }

  if (process.env.NODE_ENV === "production" && config.authRegistration && !config.relayAuthToken) {
    warnings.push(
      "AUTH_REGISTRATION 在生产环境仍为开放状态：完成首批账号引导后请设置 AUTH_REGISTRATION=off，并使用单次邀请链接添加测试员。"
    );
  }

  if (config.crashNotifier !== "log") {
    warnings.push(`CRASH_NOTIFIER=${config.crashNotifier} 不是已实现的通道，事故升级将只记录、不发送短信。`);
  }

  return warnings;
}

/** Fail-fast checks used by the readiness probe. Liveness remains available
 * while a bad deployment is being repaired, but traffic should not be routed
 * to a real provider with missing credentials or no access control. */
export function readinessIssues(): string[] {
  const issues: string[] = [];
  if (!accountsStorageHealthy()) issues.push("accounts-storage-unavailable");
  if (!userMemoryStorageHealthy()) issues.push("user-memory-storage-unavailable");
  if (config.voiceProvider === "doubao" && credentialStatus() === "missing") {
    issues.push("provider-credentials-missing");
  }
  if (process.env.NODE_ENV === "production" && !config.relayAuthToken && !authActive()) {
    issues.push("access-control-not-configured");
  }
  if (process.env.NODE_ENV === "production" && !config.relayAuthToken && config.authRegistration && authActive()) {
    issues.push("open-registration-enabled");
  }
  return issues;
}

export function buildHealth(uptimeSec: number, includeTesting = false): AgentHealth {
  return {
    ok: true,
    provider: config.voiceProvider,
    uptimeSec,
    credentials: credentialStatus(),
    weather: "available",
    capabilities: providerCapabilities(config.voiceProvider),
    metrics: { ...metrics.snapshot() },
    metricsWindow: { ...metricsWindow() },
    // Lets clients decide whether to show the login/registration UI.
    auth: { enabled: authActive(), registrationOpen: registrationOpen() },
    build: { ...buildInfo },
    // Safe-by-default legacy/internal hook. The public route never opts in;
    // authenticated evidence is served by the scoped /testing APIs.
    ...(includeTesting ? { testing: testingSnapshot() } : {})
  };
}
