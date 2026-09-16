import { describe, expect, it, vi } from "vitest";
import { RiderLocationContext, asksCurrentLocation } from "../server/rider-location";
import { wgs84ToGcj02 } from "../shared/geo";

describe("rider location", () => {
  it("never uses a default/demo location as the rider's position", () => {
    const context = new RiderLocationContext("");
    expect(context.coordinates()).toBeUndefined();
    expect(context.answer()).toContain("还没有收到");
  });
  it("accepts later fixes and expires them when the phone stops updating", async () => {
    let now = 0;
    const context = new RiderLocationContext("", () => now);
    await context.update(31.23, 121.47);
    expect(context.answer()).toContain("31.23000");
    now = 46000;
    expect(context.coordinates()).toBeUndefined();
    await context.update(31.24, 121.48);
    expect(context.answer()).toContain("31.24000");
  });
  it("resolves an address with one coordinate conversion and throttles requests", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "1", regeocode: { formatted_address: "上海市黄浦区南京东路" } }))
    );
    const context = new RiderLocationContext("test-key", () => 1000, request as typeof fetch);
    await context.update(31.23, 121.47);
    await context.update(31.23, 121.47);
    expect(request).toHaveBeenCalledTimes(1);
    const expected = wgs84ToGcj02({ lat: 31.23, lon: 121.47 });
    const url = request.mock.calls[0] as unknown as [URL];
    expect(url[0].searchParams.get("location")).toBe(`${expected.lon.toFixed(6)},${expected.lat.toFixed(6)}`);
    expect(context.answer()).toContain("南京东路");
    await context.update(32, 122);
    expect(context.answer()).not.toContain("南京东路");
  });
  it("retains GPS when geocoding fails", async () => {
    const context = new RiderLocationContext("test-key", Date.now, vi.fn().mockRejectedValue(new Error("offline")));
    await context.update(31, 121);
    expect(context.answer()).toContain("31.00000");
    expect(context.answer()).toContain("没有解析出街道");
  });
  it.each(["Max where am I?", "what is my current location", "我现在在哪里", "Max 我的位置", "我在哪"])(
    "recognizes %s",
    (text) => {
      expect(asksCurrentLocation(text)).toBe(true);
    }
  );
  it.each(["导航去我的位置", "where am I going tomorrow", "do not share my location"])("does not hijack %s", (text) => {
    expect(asksCurrentLocation(text)).toBe(false);
  });
});
