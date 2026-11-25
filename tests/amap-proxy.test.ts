// tests/amap-proxy.test.ts
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { amapProxyTarget, isAllowedProxyReferer, registerAmapRoutes, resolveRequestScheme } from "../server/amap-proxy";
import { checkAuthRateLimit, resetAuthRateLimit, resetProxyHeaderNotice } from "../server/auth";
import { config } from "../server/config";

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

  // The relay serves its own pages with `Referrer-Policy: no-referrer`, so
  // the Amap SDK's requests from the real map arrive with no Referer at all.
  it("allows a request with no Referer", () => {
    expect(isAllowedProxyReferer(undefined, selfOrigin)).toBe(true);
    expect(isAllowedProxyReferer("", selfOrigin)).toBe(true);
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

describe("resolveRequestScheme", () => {
  it("ignores X-Forwarded-Proto when trustProxy is off", () => {
    expect(resolveRequestScheme("http", "https", false)).toBe("http");
  });

  it("uses X-Forwarded-Proto when trustProxy is on", () => {
    expect(resolveRequestScheme("http", "https", true)).toBe("https");
  });

  it("takes the first entry of a comma-separated X-Forwarded-Proto list", () => {
    expect(resolveRequestScheme("http", "https, http", true)).toBe("https");
  });

  it("falls back to reqProtocol when X-Forwarded-Proto is absent, even with trustProxy on", () => {
    expect(resolveRequestScheme("http", undefined, true)).toBe("http");
  });
});

// The route itself. Every request it forwards is signed with the operator's
// Amap secret and spends the operator's quota, so it is bounded: by a rate
// limit per client address, and by how much of an answer it reads.
describe("the proxy route", () => {
  const original = { secret: config.amapJsSecret, perMinute: config.amapProxyPerMinute, trustProxy: config.trustProxy };
  const upstream = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  // The real one, for the requests the test makes itself: `fetch` is replaced for the proxy.
  const request: typeof fetch = globalThis.fetch;
  let server: Server;
  let origin: string;

  beforeEach(async () => {
    config.amapJsSecret = "s3cret";
    resetAuthRateLimit();
    resetProxyHeaderNotice();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The suite keeps a mock's calls from one test to the next (clearMocks is off).
    upstream.mockReset();
    upstream.mockImplementation(
      async () => new Response("tile", { headers: { "content-type": "application/octet-stream" } })
    );
    vi.stubGlobal("fetch", upstream);
    const app = express();
    registerAmapRoutes(app);
    server = app.listen(0);
    const listening = Promise.withResolvers<void>();
    server.once("listening", listening.resolve);
    await listening.promise;
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetAuthRateLimit();
    resetProxyHeaderNotice();
    config.amapJsSecret = original.secret;
    config.amapProxyPerMinute = original.perMinute;
    config.trustProxy = original.trustProxy;
  });

  /** One request for a tile, as the map's page sends it (no Referer). */
  const tile = (headers: Record<string, string> = {}) =>
    request(`${origin}/_AMapService/v3/vectormap?x=1`, { headers: { Connection: "close", ...headers } });

  it("forwards the map's request signed with the secret, and passes the answer back", async () => {
    const response = await tile({ referer: `${origin}/nav` });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(await response.text()).toBe("tile");
    expect(upstream).toHaveBeenCalledWith(
      "https://fmap01.amap.com/v3/vectormap?x=1&jscode=s3cret",
      expect.objectContaining({ headers: { referer: `${origin}/nav` } })
    );
  });

  it("refuses another site's Referer without asking Amap", async () => {
    const response = await tile({ referer: "https://evil.example.com/" });
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers 429 to an address past its limit, without asking Amap", async () => {
    config.amapProxyPerMinute = 2;
    expect((await tile()).status).toBe(200);
    expect((await tile()).status).toBe(200);
    const refused = await tile();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("counts client addresses by X-Forwarded-For only behind a trusted proxy", async () => {
    config.amapProxyPerMinute = 1;
    const forwarded = (address: string) => tile({ "x-forwarded-for": address });

    config.trustProxy = true;
    expect((await forwarded("198.51.100.1")).status).toBe(200);
    expect((await forwarded("198.51.100.1")).status).toBe(429);
    // Another visitor behind the same proxy has a limit of their own.
    expect((await forwarded("198.51.100.2")).status).toBe(200);

    // Without that trust the header is the client's to make up: both are one address.
    resetAuthRateLimit();
    config.trustProxy = false;
    expect((await forwarded("203.0.113.1")).status).toBe(200);
    expect((await forwarded("203.0.113.2")).status).toBe(429);
  });

  it("reads no more than 8 MiB of an answer, and answers 502 to a larger one", async () => {
    const MiB = 1024 * 1024;
    const chunk = new Uint8Array(MiB).fill(1);
    let pulls = 0;
    let cancelled = false;
    /** An answer of `chunks` mebibytes, or one that never ends when left undefined. */
    const answer = (chunks?: number) =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (chunks !== undefined && pulls > chunks) controller.close();
            else controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          }
        }),
        { headers: { "content-type": "application/octet-stream" } }
      );

    upstream.mockImplementation(async () => answer());
    const refused = await tile();
    expect(refused.status).toBe(502);
    expect(await refused.text()).toBe("");
    // The chunk that crossed the line is read, and at most the one already asked for.
    expect(pulls).toBeGreaterThanOrEqual(9);
    expect(pulls).toBeLessThanOrEqual(10);
    expect(cancelled).toBe(true);

    pulls = 0;
    cancelled = false;
    upstream.mockImplementation(async () => answer(8));
    const allowed = await tile();
    expect(allowed.status).toBe(200);
    expect((await allowed.arrayBuffer()).byteLength).toBe(8 * MiB);
    expect(cancelled).toBe(false);
  });
});

describe("the amap-proxy rate-limit bucket", () => {
  afterEach(() => {
    resetAuthRateLimit();
    vi.unstubAllEnvs();
  });

  it("has a limit of its own, and spends none of the login attempts", () => {
    const address = "203.0.113.9";
    // The map's tiles are used up: two a minute is the limit given here, not the login limit.
    expect(checkAuthRateLimit(address, 1_000, "amap-proxy", 2)).toBe(true);
    expect(checkAuthRateLimit(address, 1_000, "amap-proxy", 2)).toBe(true);
    expect(checkAuthRateLimit(address, 1_000, "amap-proxy", 2)).toBe(false);

    // The address still has every login attempt it always had.
    for (let attempt = 0; attempt < config.authAttemptsPerMinute; attempt += 1) {
      expect(checkAuthRateLimit(address, 1_000)).toBe(true);
    }
    expect(checkAuthRateLimit(address, 1_000)).toBe(false);
  });

  it("is still whole for an address that used up its login attempts", () => {
    const address = "203.0.113.10";
    for (let attempt = 0; attempt < config.authAttemptsPerMinute; attempt += 1) {
      expect(checkAuthRateLimit(address, 1_000)).toBe(true);
    }
    expect(checkAuthRateLimit(address, 1_000)).toBe(false);
    expect(checkAuthRateLimit(address, 1_000, "amap-proxy", 2)).toBe(true);
    expect(checkAuthRateLimit(address, 1_000, "amap-proxy", 2)).toBe(true);
    expect(checkAuthRateLimit(address, 1_000, "amap-proxy", 2)).toBe(false);
  });

  it("leaves room for a map by default, and cannot be turned off with 0", async () => {
    // Config is read from the environment once, as its module loads: a static
    // import would hand back the copy this file already has.
    vi.resetModules();
    vi.stubEnv("AMAP_PROXY_PER_MINUTE", "");
    expect((await import("../server/runtime-config")).config.amapProxyPerMinute).toBe(600);
    vi.stubEnv("AMAP_PROXY_PER_MINUTE", "0");
    vi.resetModules();
    expect((await import("../server/runtime-config")).config.amapProxyPerMinute).toBe(1);
  });
});
