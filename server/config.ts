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
  wakeWord: process.env.AGENT_WAKE_WORD?.trim().toLowerCase() !== "off"
};

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
    `Wake word ("Max"): ${config.wakeWord ? "on" : "off"}`
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
