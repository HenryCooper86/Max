import { APP_DEMO_CAPABILITIES, providerCapabilities, type AgentHealth } from "../shared/agent";
import { buildInfo } from "./build-info";
import { accountsStorageHealthy, authActive, registrationOpen } from "./accounts";
import { metrics, metricsWindow, testingSnapshot } from "./metrics";
import { userMemoryEnabled, userMemoryStorageHealthy } from "./user-memory";

import { assistant, assistantLogoProblem, assistantSummary, wakeWordActive } from "./assistant";
import { serverTools } from "./tools/registry";
import { equalizerOptions } from "./audio-eq";
import { resolveVoiceProviderId, voiceProvider, voiceProviderSummaries } from "./providers/catalog";
import { config } from "./runtime-config";
export { config };

/** The monthly voice-minute limit and webhook, as the startup log states them. */
function usageLimitLine(): string {
  const minutes = Number(process.env.USAGE_MONTHLY_MINUTES);
  const limit = Number.isFinite(minutes) && minutes > 0 ? `${minutes} min per user per month` : "off";
  return `${limit} · usage webhook ${process.env.USAGE_WEBHOOK_URL?.trim() ? "on" : "off"}`;
}

/** True for every backend that spends a real provider's quota. */
function usesLiveBackend(): boolean {
  return config.voiceProvider !== "mock";
}

function credentialStatus(): AgentHealth["credentials"] {
  if (!usesLiveBackend()) return "not-required";
  return voiceProvider(config.voiceProvider).configured() ? "configured" : "missing";
}

/** "45 s" below one minute, "10 min" from there up. */
function describeDuration(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

/** Human-readable summary printed on startup. */
export function describeConfig(): string[] {
  return [
    `Assistant: ${assistant().name} (${assistant().preset.id}) · template ${assistant().template}`,
    `Realtime voice provider: ${config.voiceProvider}`,
    `Voice backends ready: ${voiceProviderSummaries()
      .filter((entry) => entry.configured)
      .map((entry) => entry.id)
      .join(", ")} · per-session switching ${config.voiceProviderSwitching ? "on" : "off"}`,
    `Provider credentials: ${credentialStatus()}`,
    `Weather context: Open-Meteo best-effort + ${config.defaultWeatherLocation.source} fallback`,
    `Weather mid-ride refresh: ${config.weatherRefreshMs ? `every ${Math.round(config.weatherRefreshMs / 60000)} min` : "off"}`,
    `Wake word ("${assistant().wake.label}"): ${wakeWordActive(config.wakeWord) ? "on" : "off"}`,
    `Usage limit: ${usageLimitLine()}`,
    `Server tools: ${
      serverTools().length
        ? serverTools()
            .map((tool) => tool.name)
            .join(", ")
        : "none"
    }`,
    `Relay auth token: ${config.relayAuthToken ? "required" : "open"}`,
    `User accounts: ${authActive() ? "active" : "none yet"} · registration ${config.authRegistration ? "open" : "closed"}`,
    `Per-user conversation memory: ${userMemoryEnabled() ? "on" : "off"}`,
    `Relay origin allowlist: ${config.allowedOrigins.length ? config.allowedOrigins.join(", ") : "any"}`,
    `Relay rate limit: ${config.connPerMinute ? `${config.connPerMinute} conn/min/IP (sliding)` : "off"}`,
    `Relay message ceiling: ${Math.round(config.maxPayloadBytes / 1024)} KiB`,
    `Relay heartbeat: ${config.heartbeatMs ? `ping every ${Math.round(config.heartbeatMs / 1000)} s` : "off"}`,
    `Relay idle timeout: ${config.idleTimeoutMs ? describeDuration(config.idleTimeoutMs) : "off"}`,
    `Relay proxy trust: ${config.trustProxy ? `on (${config.trustedProxyHops} hop${config.trustedProxyHops === 1 ? "" : "s"} via X-Forwarded-For)` : "off (client IP = socket address)"}`,
    `Crash notification channel: ${config.crashNotifier}`
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

  const logoIssue = assistantLogoProblem();
  if (logoIssue) warnings.push(`assistant.config.json: ${logoIssue} — the built-in mark is used instead.`);

  const requested = process.env.VOICE_PROVIDER?.trim();
  if (requested && !resolveVoiceProviderId(requested)) {
    warnings.push(`VOICE_PROVIDER=${requested} 不是已知的语音后端，已回退到演示模式（mock）。`);
  }

  if (usesLiveBackend()) {
    if (credentialStatus() === "missing") {
      warnings.push(
        config.voiceProvider === "doubao"
          ? "VOICE_PROVIDER=doubao 但缺少 DOUBAO_API_KEY 或完整的 DOUBAO_APP_ID/APP_KEY/ACCESS_KEY：实时语音会话将无法建立。"
          : `VOICE_PROVIDER=${config.voiceProvider} 但缺少 ${voiceProvider(config.voiceProvider).requires}：实时语音会话将无法建立。`
      );
    }
    if (!config.relayAuthToken && !hasAccountProtection) {
      warnings.push(
        "RELAY_AUTH_TOKEN 未设置：任何发现该地址的人都能消耗语音服务配额。生产部署请设置一个随机令牌，客户端通过 ?token=… 连接。"
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
  if (usesLiveBackend() && !config.trustProxy) {
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
  if (usesLiveBackend() && credentialStatus() === "missing") {
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
    assistant: assistantSummary(wakeWordActive(config.wakeWord)),
    voice: {
      active: config.voiceProvider,
      switching: config.voiceProviderSwitching,
      providers: voiceProviderSummaries(),
      equalizer: equalizerOptions(assistant().equalizer, config.voiceEqualizerAdjustable)
    },
    uptimeSec,
    credentials: credentialStatus(),
    weather: "available",
    // What a session will actually report: a software assistant's demo is not the helmet's.
    capabilities:
      config.voiceProvider === "mock" && assistant().preset.general
        ? APP_DEMO_CAPABILITIES
        : providerCapabilities(config.voiceProvider),
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
