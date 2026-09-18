import type { CastPoint } from "./protocol";

export type Basemap = { sequence: number; center: CastPoint; zoom: number };
export function worldPixel(point: CastPoint, zoom: number) {
  const size = 256 * 2 ** zoom;
  const latitude = (Math.max(-85, Math.min(85, point.lat)) * Math.PI) / 180;
  return {
    x: ((point.lon + 180) / 360) * size,
    y: ((1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2) * size
  };
}

/** Background imagery is independent of GPS freshness and never contains a rider marker. */
export function createBasemap(key: string, changed: () => void, fetcher = fetch, now = Date.now) {
  let current: Basemap | null = null;
  let generation = 0;
  let sequence = 0;
  let busy = false;
  let retryAt = 0;
  let controller: AbortController | undefined;
  const images = new Map<number, { bytes: Buffer; type: string }>();
  return {
    get current() {
      return current;
    },
    image(id: number) {
      return images.get(id);
    },
    reset() {
      generation++;
      controller?.abort();
      controller = undefined;
      current = null;
      images.clear();
      busy = false;
      retryAt = 0;
    },
    async update(position: CastPoint | null) {
      if (!key || !position || busy || now() < retryAt) return;
      const zoom = 16;
      if (current) {
        const center = worldPixel(current.center, zoom),
          rider = worldPixel(position, zoom);
        if (Math.abs(center.x - rider.x) < 90 && Math.abs(center.y - rider.y) < 70) return;
      }
      busy = true;
      retryAt = now() + 3_000;
      const token = generation;
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort(), 8_000);
      try {
        const url = new URL("https://restapi.amap.com/v3/staticmap");
        for (const [name, value] of Object.entries({
          key,
          location: `${position.lon},${position.lat}`,
          zoom: String(zoom),
          size: "600*480",
          scale: "1"
        }))
          url.searchParams.set(name, value);
        const response = await fetcher(url, { signal: request.signal });
        const type = response.headers.get("content-type")?.split(";")[0] ?? "";
        if (!response.ok || !["image/png", "image/jpeg"].includes(type)) throw new Error("Map unavailable");
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 2_000_000 || bytes.length < 4) throw new Error("Invalid map image");
        if (token !== generation) return;
        current = { sequence: ++sequence, center: { ...position }, zoom };
        images.set(sequence, { bytes, type });
        if (images.size > 2) images.delete(images.keys().next().value!);
        changed();
      } catch {
        // Keep the previous geographic image during outages; never log credential URLs.
        if (token === generation) retryAt = now() + 10_000;
      } finally {
        clearTimeout(timeout);
        if (token === generation) {
          busy = false;
          controller = undefined;
        }
      }
    }
  };
}
