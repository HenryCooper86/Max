import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizeUpgrade, checkRateLimit, clientAddress, resetRateLimit } from "../server/auth";
import { config } from "../server/config";

function fakeRequest(
  options: { url?: string; origin?: string; address?: string; forwardedFor?: string | string[] } = {}
): IncomingMessage {
  const headers: Record<string, unknown> = {};
  if (options.origin) headers.origin = options.origin;
  if (options.forwardedFor !== undefined) headers["x-forwarded-for"] = options.forwardedFor;
  return {
    url: options.url ?? "/agent",
    headers,
    socket: { remoteAddress: options.address ?? "203.0.113.7" }
  } as unknown as IncomingMessage;
}

const original = {
  relayAuthToken: config.relayAuthToken,
  allowedOrigins: config.allowedOrigins,
  connPerMinute: config.connPerMinute,
  trustProxy: config.trustProxy,
  trustedProxyHops: config.trustedProxyHops
};

beforeEach(() => {
  resetRateLimit();
});

afterEach(() => {
  config.relayAuthToken = original.relayAuthToken;
  config.allowedOrigins = original.allowedOrigins;
  config.connPerMinute = original.connPerMinute;
  config.trustProxy = original.trustProxy;
  config.trustedProxyHops = original.trustedProxyHops;
});

describe("authorizeUpgrade", () => {
  it("allows everything when no auth is configured", () => {
    config.relayAuthToken = "";
    config.allowedOrigins = [];
    expect(authorizeUpgrade(fakeRequest())).toEqual({ ok: true });
  });

  it("requires the shared token when configured", () => {
    config.relayAuthToken = "s3cret";
    config.allowedOrigins = [];

    expect(authorizeUpgrade(fakeRequest()).ok).toBe(false);
    expect(authorizeUpgrade(fakeRequest({ url: "/agent?token=wrong" })).ok).toBe(false);
    expect(authorizeUpgrade(fakeRequest({ url: "/agent?token=s3cret" }))).toEqual({ ok: true });
  });

  it("rejects browsers from non-allowlisted origins but lets native apps through", () => {
    config.relayAuthToken = "";
    config.allowedOrigins = ["https://max.example.com"];

    expect(authorizeUpgrade(fakeRequest({ origin: "https://evil.example.com" })).ok).toBe(false);
    expect(authorizeUpgrade(fakeRequest({ origin: "https://max.example.com" }))).toEqual({ ok: true });
    // Native clients (iOS/Android) send no Origin header.
    expect(authorizeUpgrade(fakeRequest())).toEqual({ ok: true });
  });

  it("rate limits repeated upgrade attempts from one address", () => {
    config.relayAuthToken = "";
    config.allowedOrigins = [];
    config.connPerMinute = 3;

    const now = 1_000_000;
    expect(checkRateLimit("198.51.100.1", now)).toBe(true);
    expect(checkRateLimit("198.51.100.1", now + 10)).toBe(true);
    expect(checkRateLimit("198.51.100.1", now + 20)).toBe(true);
    expect(checkRateLimit("198.51.100.1", now + 30)).toBe(false);
    // Another address is unaffected.
    expect(checkRateLimit("198.51.100.2", now + 30)).toBe(true);
    // The window slides: a minute later the first address is clean again.
    expect(checkRateLimit("198.51.100.1", now + 61_000)).toBe(true);
  });

  it("enforces a sliding window, not a fixed bucket that resets on the minute", () => {
    config.connPerMinute = 3;
    const t = 5_000_000;
    expect(checkRateLimit("a", t)).toBe(true); // hit 1 @ t
    expect(checkRateLimit("a", t + 30_000)).toBe(true); // hit 2 @ t+30s
    expect(checkRateLimit("a", t + 40_000)).toBe(true); // hit 3 @ t+40s
    expect(checkRateLimit("a", t + 50_000)).toBe(false); // 4th within the trailing 60s → blocked
    // Just past the first hit's 60s lifetime, exactly ONE slot frees — a fixed
    // window would have reset the whole bucket at t+60s and allowed a fresh burst.
    expect(checkRateLimit("a", t + 61_000)).toBe(true); // only the t hit expired
    expect(checkRateLimit("a", t + 62_000)).toBe(false); // hits @ +30s/+40s/+61s still count
  });
});

describe("clientAddress proxy handling", () => {
  it("uses the socket address and ignores X-Forwarded-For when proxy trust is off", () => {
    config.trustProxy = false;
    expect(clientAddress(fakeRequest({ address: "10.0.0.5", forwardedFor: "1.2.3.4" }))).toBe("10.0.0.5");
  });

  it("reads the real client IP from the right of X-Forwarded-For behind one proxy", () => {
    config.trustProxy = true;
    config.trustedProxyHops = 1;
    // Caddy appends the peer it saw; a single hop leaves just the real client.
    expect(clientAddress(fakeRequest({ address: "127.0.0.1", forwardedFor: "198.51.100.9" }))).toBe("198.51.100.9");
  });

  it("ignores a spoofed leftmost X-Forwarded-For entry", () => {
    config.trustProxy = true;
    config.trustedProxyHops = 1;
    // Client forged "1.2.3.4"; the trusted proxy appended the true peer on the right.
    expect(clientAddress(fakeRequest({ forwardedFor: "1.2.3.4, 198.51.100.9" }))).toBe("198.51.100.9");
  });

  it("peels the configured number of trusted hops", () => {
    config.trustProxy = true;
    config.trustedProxyHops = 2;
    // client, edge-proxy → socket is the inner proxy; two trusted hops → client.
    expect(clientAddress(fakeRequest({ address: "127.0.0.1", forwardedFor: "203.0.113.7, 70.0.0.1" }))).toBe(
      "203.0.113.7"
    );
  });

  it("falls back to the socket address when X-Forwarded-For is absent", () => {
    config.trustProxy = true;
    config.trustedProxyHops = 1;
    expect(clientAddress(fakeRequest({ address: "10.0.0.9" }))).toBe("10.0.0.9");
  });
});
