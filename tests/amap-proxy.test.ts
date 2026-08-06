// tests/amap-proxy.test.ts
import { describe, expect, it } from "vitest";
import { amapProxyTarget } from "../server/amap-proxy";

describe("amapProxyTarget", () => {
  it("maps styles, vectormap, and restapi hosts with jscode appended", () => {
    expect(amapProxyTarget("/_AMapService/v4/map/styles", "?styleid=1", "s3cret")).toBe(
      "https://webapi.amap.com/v4/map/styles?styleid=1&jscode=s3cret"
    );
    expect(amapProxyTarget("/_AMapService/v3/vectormap", "", "s3cret")).toBe(
      "https://fmap01.amap.com/v3/vectormap?jscode=s3cret"
    );
    expect(amapProxyTarget("/_AMapService/v3/geocode/regeo", "?location=1,2", "s3cret")).toBe(
      "https://restapi.amap.com/v3/geocode/regeo?location=1,2&jscode=s3cret"
    );
  });

  it("refuses paths outside the proxy prefix", () => {
    expect(amapProxyTarget("/etc/passwd", "", "s")).toBeNull();
    expect(amapProxyTarget("/_AMapServiceX/v3/x", "", "s")).toBeNull();
  });
});
