import { wgs84ToGcj02, type GeoPoint } from "../shared/geo";
import { haversineMeters } from "../shared/guidance";

export function asksCurrentLocation(text: string): boolean {
  const value = text
    .trim()
    .replace(/^(?:hey\s+)?max[，,\s]*/i, "")
    .replace(/[?？!！。.]$/g, "");
  return /^(?:(?:你知道|告诉我|请问)?我(?:现在|目前)?(?:在(?:哪里|哪儿|什么地方)|的位置(?:是(?:哪里|什么))?)|我在哪|(?:do you know |can you tell me )?where (?:am i|i am)(?: right now)?|(?:what(?:'s| is)|do you know) my (?:current )?location|tell me (?:my (?:current )?location|where i am))$/i.test(
    value
  );
}

/** Session-local, never persisted or logged. Only device fixes count as rider
 * location; configured/demo weather coordinates must never enter this class. */
export class RiderLocationContext {
  private fix?: GeoPoint & { receivedAt: number };
  private address?: { point: GeoPoint; text: string };
  private lookupAt = -Infinity;
  private lookupGeneration = 0;
  constructor(
    private readonly apiKey: string,
    private readonly now: () => number = Date.now,
    private readonly request: typeof fetch = fetch
  ) {}

  isFresh(): boolean {
    return !!this.fix && this.now() - this.fix.receivedAt <= 45_000;
  }

  coordinates(): GeoPoint | undefined {
    return this.isFresh() ? this.fix : undefined;
  }

  answer(): string {
    const fix = this.coordinates();
    if (!fix) return "我还没有收到你手机的最新位置。请允许 Max 使用定位和精确位置，保持应用打开，稍等 GPS 更新。";
    if (this.address && haversineMeters(fix, this.address.point) <= 100) {
      return `手机 GPS 显示，你在${this.address.text}附近。`;
    }
    return `我已收到手机 GPS 位置：纬度 ${fix.lat.toFixed(5)}，经度 ${fix.lon.toFixed(5)}。暂时还没有解析出街道地址。`;
  }

  role(): string {
    return `\n\n[手机实时定位] ${this.answer()}这是手机提供的位置，与导航是否启动无关。只能复述此定位，不得猜测街道、门牌或地点；默认/演示天气地点不是骑手位置。`;
  }

  async update(lat: number, lon: number): Promise<void> {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    this.fix = { lat, lon, receivedAt: this.now() };
    if (!this.apiKey || this.now() - this.lookupAt < 30_000) return;
    if (this.address && haversineMeters(this.fix, this.address.point) <= 100) return;
    this.lookupAt = this.now();
    const generation = ++this.lookupGeneration;
    const point = { lat, lon };
    const gcj = wgs84ToGcj02(point);
    const url = new URL("https://restapi.amap.com/v3/geocode/regeo");
    url.search = new URLSearchParams({
      key: this.apiKey,
      location: `${gcj.lon.toFixed(6)},${gcj.lat.toFixed(6)}`,
      extensions: "base",
      radius: "100"
    }).toString();
    try {
      const response = await this.request(url, { signal: AbortSignal.timeout(2500) });
      if (!response.ok) return;
      const body = (await response.json()) as { status?: string; regeocode?: { formatted_address?: unknown } };
      const text = body.regeocode?.formatted_address;
      if (generation === this.lookupGeneration && body.status === "1" && typeof text === "string" && text.trim()) {
        this.address = { point, text: text.trim().slice(0, 200) };
      }
    } catch {
      /* Coordinates remain usable when address lookup is unavailable. */
    }
  }
}
