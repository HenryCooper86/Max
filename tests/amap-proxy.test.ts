// tests/amap-proxy.test.ts
import { describe, expect, it } from "vitest";
import { amapProxyTarget, isAllowedProxyReferer } from "../server/amap-proxy";

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

  it("URL-encodes a jscode containing reserved characters", () => {
    expect(amapProxyTarget("/_AMapService/v3/geocode/regeo", "?location=1,2", "s3&cr+et#x")).toBe(
      "https://restapi.amap.com/v3/geocode/regeo?location=1,2&jscode=s3%26cr%2Bet%23x"
    );
  });
});

describe("isAllowedProxyReferer", () => {
  const selfOrigin = "https://relay.example.com";

  it("allows a request with no Referer at all", () => {
    expect(isAllowedProxyReferer(undefined, selfOrigin)).toBe(true);
  });

  it("allows a same-origin Referer", () => {
    expect(isAllowedProxyReferer("https://relay.example.com/nav", selfOrigin)).toBe(true);
  });

  it("refuses a cross-origin Referer", () => {
    expect(isAllowedProxyReferer("https://evil.example.com/", selfOrigin)).toBe(false);
  });

  it("refuses a malformed Referer URL", () => {
    expect(isAllowedProxyReferer("not-a-url", selfOrigin)).toBe(false);
  });
});
