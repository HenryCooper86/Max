import type { CastPoint } from "./protocol";

export type HudWeather = {
  city: string;
  condition: string;
  temperature: string;
  humidity: string;
  wind: string;
  reportTime: string;
  fetchedAt: number;
  source: "network" | "navigation";
};

/** Only the city and weather survive a sharing session; no position is retained. */
export function createHudWeather(key: string, changed: () => void, fetcher = fetch, now = Date.now) {
  let weather: HudWeather | null = null;
  let city = "";
  let source: HudWeather["source"] = "network";
  let nextWeather = 0;
  let nextLocation = 0;
  let retryAt = 0;
  let busy = false;
  let closed = false;
  let controller: AbortController | undefined;
  const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 100) : "");
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  async function request(path: string, params: Record<string, string>) {
    const url = new URL(path, "https://restapi.amap.com");
    for (const [name, value] of Object.entries({ ...params, key })) url.searchParams.set(name, value);
    const response = await fetcher(url, { signal: controller!.signal });
    if (!response.ok) throw new Error("Weather unavailable");
    const body = record(await response.json());
    if (body.status !== "1") throw new Error("Weather unavailable");
    return body;
  }
  return {
    get current() {
      return weather
        ? {
            ...weather,
            stale:
              now() - weather.fetchedAt > 30 * 60_000 ||
              now() - new Date(weather.reportTime.replace(" ", "T") + "+08:00").getTime() > 3 * 60 * 60_000
          }
        : null;
    },
    async update(position: CastPoint | null = null) {
      if (!key || closed || busy || now() < retryAt) return;
      const locate = !city || (!!position && (source === "network" || now() >= nextLocation));
      if (!locate && now() < nextWeather) return;
      busy = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 8_000);
      try {
        if (locate) {
          const body = position
            ? await request("/v3/geocode/regeo", { location: `${position.lon},${position.lat}`, extensions: "base" })
            : await request("/v3/ip", {});
          const code = position ? record(record(body.regeocode).addressComponent).adcode : body.adcode;
          if (typeof code !== "string" || !/^\d{6}$/.test(code)) throw new Error("City unavailable");
          city = code;
          source = position ? "navigation" : "network";
          nextLocation = now() + 10 * 60_000;
        }
        const body = await request("/v3/weather/weatherInfo", { city, extensions: "base" });
        const live = record(Array.isArray(body.lives) ? body.lives[0] : null);
        if (
          !live ||
          !text(live.city) ||
          !text(live.weather) ||
          !/^-?\d+(\.\d+)?$/.test(text(live.temperature)) ||
          !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text(live.reporttime))
        )
          throw new Error("Invalid weather");
        if (closed) return;
        weather = {
          city: text(live.city),
          condition: text(live.weather),
          temperature: text(live.temperature),
          humidity: text(live.humidity),
          wind: `${text(live.winddirection)}风 ${text(live.windpower)}级`,
          reportTime: text(live.reporttime),
          fetchedAt: now(),
          source
        };
        nextWeather = now() + 10 * 60_000;
        changed();
      } catch {
        retryAt = now() + 60_000;
      } finally {
        clearTimeout(timeout);
        controller = undefined;
        busy = false;
      }
    },
    close() {
      closed = true;
      controller?.abort();
    }
  };
}
