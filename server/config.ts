import "dotenv/config";

export type VoiceProvider = "mock" | "doubao";

function readFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value !== "false";
}

/** Backend configuration resolved from environment variables at startup. */
export const config = {
  port: Number(process.env.PORT ?? 8787),
  voiceProvider: (process.env.VOICE_PROVIDER === "doubao" ? "doubao" : "mock") as VoiceProvider,
  arkApiKey: process.env.ARK_API_KEY?.trim() ?? "",
  offlineFallback: readFlag(process.env.HELMET_AGENT_OFFLINE_FALLBACK, true)
};

/** Human-readable summary printed on startup. */
export function describeConfig(): string[] {
  return [
    `Realtime voice provider: ${config.voiceProvider}`,
    `Ark command mode: ${config.arkApiKey ? "API key set" : "no API key (local fallback only)"}`,
    `Offline fallback: ${config.offlineFallback ? "on" : "off"}`
  ];
}

/**
 * Returns warnings for configuration that will fail at request time. The
 * server still starts so the mock path stays usable while credentials are
 * being sorted out.
 */
export function validateConfig(): string[] {
  const warnings: string[] = [];

  if (!config.arkApiKey) {
    warnings.push(
      config.offlineFallback
        ? "ARK_API_KEY 未设置：/ark/chat 将返回本地备用回复。"
        : "ARK_API_KEY 未设置且 offline fallback 已关闭：/ark/chat 将返回 HTTP 500。"
    );
  }

  if (config.voiceProvider === "doubao") {
    const hasApiKey = Boolean(process.env.DOUBAO_API_KEY?.trim());
    const hasLegacy = Boolean(
      process.env.DOUBAO_APP_ID?.trim() && process.env.DOUBAO_APP_KEY?.trim() && process.env.DOUBAO_ACCESS_KEY?.trim()
    );
    if (!hasApiKey && !hasLegacy) {
      warnings.push(
        "VOICE_PROVIDER=doubao 但缺少 DOUBAO_API_KEY 或完整的 DOUBAO_APP_ID/APP_KEY/ACCESS_KEY：实时语音会话将无法建立。"
      );
    }
  }

  return warnings;
}
