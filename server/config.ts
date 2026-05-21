import "dotenv/config";

export type VoiceProvider = "mock" | "doubao";

/** Backend configuration resolved from environment variables at startup. */
export const config = {
  port: Number(process.env.PORT ?? 8787),
  voiceProvider: (process.env.VOICE_PROVIDER === "doubao" ? "doubao" : "mock") as VoiceProvider
};

/** Human-readable summary printed on startup. */
export function describeConfig(): string[] {
  return [`Realtime voice provider: ${config.voiceProvider}`];
}

/**
 * Returns warnings for configuration that will fail at request time. The
 * server still starts so the mock path stays usable while credentials are
 * being sorted out.
 */
export function validateConfig(): string[] {
  const warnings: string[] = [];

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
