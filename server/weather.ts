// Live weather for the rider's location, used to give the agent real data.
// Open-Meteo is free and needs no API key, so there is no credential to manage.

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

// WMO weather interpretation codes → short Chinese description.
// https://open-meteo.com/en/docs — "Weather variable documentation".
const WEATHER_CODES: Record<number, string> = {
  0: "晴",
  1: "晴间多云",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "大毛毛雨",
  56: "冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "小阵雨",
  81: "阵雨",
  82: "强阵雨",
  85: "小阵雪",
  86: "大阵雪",
  95: "雷阵雨",
  96: "雷阵雨伴冰雹",
  99: "强雷阵雨伴冰雹"
};

/** Maps a WMO weather code to a short Chinese description. */
export function describeWeatherCode(code: number): string {
  return WEATHER_CODES[code] ?? "未知天气";
}

/**
 * Builds the natural-language Chinese summary folded into the agent's context.
 * Calls out strong wind because it matters most to a motorcycle rider.
 */
export function buildWeatherSummary(description: string, temperatureC: number, windSpeedKmh: number): string {
  const windNote = windSpeedKmh >= 30 ? "，风较大，注意横风" : windSpeedKmh >= 15 ? "，有微风" : "";
  return `天气${description}，气温约 ${temperatureC}°C，风速约 ${windSpeedKmh} 公里每小时${windNote}。`;
}

export type RiderWeather = {
  description: string;
  temperatureC: number;
  windSpeedKmh: number;
  isDay: boolean;
  riskLevel: "normal" | "caution" | "critical";
  riderAdvice: string;
  /** Natural-language summary for the agent system prompt. */
  summary: string;
};

type OpenMeteoResponse = {
  current?: {
    temperature_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    is_day?: number;
  };
};

/** Fetches current weather for the coordinates. Throws on network/HTTP error. */
export async function fetchRiderWeather(lat: number, lon: number): Promise<RiderWeather> {
  const url =
    `${OPEN_METEO_URL}?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code,wind_speed_10m,is_day&wind_speed_unit=kmh&timezone=auto`;

  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) {
    throw new Error(`Weather request failed with HTTP ${response.status}`);
  }

  const current = ((await response.json()) as OpenMeteoResponse).current ?? {};
  const temperatureC = Math.round(Number(current.temperature_2m ?? 0));
  const windSpeedKmh = Math.round(Number(current.wind_speed_10m ?? 0));
  const description = describeWeatherCode(Number(current.weather_code ?? 0));
  const { riskLevel, riderAdvice } = assessWeatherRisk(description, windSpeedKmh);

  return {
    description,
    temperatureC,
    windSpeedKmh,
    isDay: current.is_day !== 0,
    riskLevel,
    riderAdvice,
    summary: buildWeatherSummary(description, temperatureC, windSpeedKmh)
  };
}

export function assessWeatherRisk(description: string, windSpeedKmh: number) {
  const severeWeather = /雷|冰雹|大雨|强|冻雨|大雪/.test(description);
  if (severeWeather || windSpeedKmh >= 45) {
    return {
      riskLevel: "critical" as const,
      riderAdvice: "建议降低速度，尽快寻找安全地点停车等待。"
    };
  }

  if (/雨|雪|雾/.test(description) || windSpeedKmh >= 25) {
    return {
      riskLevel: "caution" as const,
      riderAdvice: "保持更大车距，注意横风和低附着路面。"
    };
  }

  return {
    riskLevel: "normal" as const,
    riderAdvice: "天气风险较低，保持正常安全骑行。"
  };
}
