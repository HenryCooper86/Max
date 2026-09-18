import { describe, expect, it, vi } from "vitest";
import { createBasemap, worldPixel } from "../rdk/agent/src/hud-cast/basemap";

const position = { lat: 31.23, lon: 121.47 };
const image = () =>
  new Response(new Uint8Array([137, 80, 78, 71, 13, 10]), { headers: { "content-type": "image/png" } });
describe("independent street basemap", () => {
  it("retains streets without phone screenshots, fetching again only after travel", async () => {
    let now = 1_000;
    const changed = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(image());
    const map = createBasemap("test-key", changed, fetcher, () => now);
    await map.update(position);
    expect(map.current).toMatchObject({ center: position, zoom: 16, sequence: 1 });
    expect(changed).toHaveBeenCalledTimes(1);
    now += 60_000;
    await map.update(position);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(image());
    await map.update({ lat: 31.24, lon: 121.47 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(map.image(1)).toBeDefined();
    expect(map.current?.sequence).toBe(2);
    map.reset();
    expect(map.current).toBeNull();
    expect(map.image(1)).toBeUndefined();
  });
  it("discards a request completing after disconnect", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const changed = vi.fn();
    const map = createBasemap("test-key", changed, fetcher);
    const pending = map.update(position);
    map.reset();
    finish(image());
    await pending;
    expect(map.current).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });
  it("keeps the last image during provider errors and backs off", async () => {
    let now = 1_000;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(image()).mockRejectedValue(new Error("network"));
    const map = createBasemap(
      "test-key",
      () => {},
      fetcher,
      () => now
    );
    await map.update(position);
    now += 4_000;
    await map.update({ lat: 32, lon: 121 });
    expect(map.current?.center).toEqual(position);
    await map.update({ lat: 32, lon: 121 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("projects GPS motion in the same pixel coordinates as the street image", () => {
    const first = worldPixel(position, 16);
    const east = worldPixel({ ...position, lon: position.lon + 0.001 }, 16);
    const north = worldPixel({ ...position, lat: position.lat + 0.001 }, 16);
    expect(east.x - first.x).toBeCloseTo(46.603, 2);
    expect(north.y).toBeLessThan(first.y);
  });
});
