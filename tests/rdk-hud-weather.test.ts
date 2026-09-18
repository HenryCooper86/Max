import { describe, expect, it, vi } from "vitest";
import { createHudWeather } from "../rdk/agent/src/hud-cast/weather";

const live = {
  city: "北京市",
  weather: "晴",
  temperature: "23",
  humidity: "50",
  winddirection: "北",
  windpower: "3",
  reporttime: "2026-09-18 12:00:00"
};
const json = (body: unknown) => Response.json(body);
describe("idle HUD weather", () => {
  it("uses network city initially, caches weather, then follows the navigation city", async () => {
    let now = Date.parse("2026-09-18T12:00:00+08:00");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v3/ip") return json({ status: "1", adcode: "110000" });
      if (path === "/v3/geocode/regeo")
        return json({ status: "1", regeocode: { addressComponent: { adcode: "310000" } } });
      return json({ status: "1", lives: [live] });
    });
    const changed = vi.fn();
    const weather = createHudWeather("key", changed, fetcher, () => now);
    await weather.update();
    expect(weather.current).toMatchObject({ city: "北京市", temperature: "23", source: "network", stale: false });
    await weather.update();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await weather.update({ lat: 31.23, lon: 121.47 });
    expect(weather.current?.source).toBe("navigation");
    expect(fetcher).toHaveBeenCalledTimes(4);
    now += 600_001;
    await weather.update();
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(new URL(String(fetcher.mock.calls.at(-1)![0])).searchParams.get("city")).toBe("310000");
    expect(changed).toHaveBeenCalledTimes(3);
    weather.close();
  });
  it("retains and marks old weather during outages, and backs off failed requests", async () => {
    let now = Date.parse("2026-09-18T12:00:00+08:00");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ status: "1", adcode: "110000" }))
      .mockResolvedValueOnce(json({ status: "1", lives: [live] }))
      .mockRejectedValue(new Error("offline"));
    const weather = createHudWeather(
      "key",
      () => {},
      fetcher,
      () => now
    );
    await weather.update();
    now += 31 * 60_000;
    await weather.update();
    expect(weather.current).toMatchObject({ city: "北京市", stale: true });
    await weather.update();
    expect(fetcher).toHaveBeenCalledTimes(3);
    weather.close();
  });
  it("handles malformed provider responses without publishing weather", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(null));
    const changed = vi.fn();
    const weather = createHudWeather("key", changed, fetcher);
    await weather.update();
    expect(weather.current).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    weather.close();
  });
  it("does not contact the provider without a key or after closing", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const weather = createHudWeather("", () => {}, fetcher);
    await weather.update();
    weather.close();
    await weather.update();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
