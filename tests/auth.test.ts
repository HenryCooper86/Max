import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizeUpgrade, checkRateLimit, resetRateLimit } from "../server/auth";
import { config } from "../server/config";

function fakeRequest(options: { url?: string; origin?: string; address?: string } = {}): IncomingMessage {
  return {
    url: options.url ?? "/agent",
    headers: options.origin ? { origin: options.origin } : {},
    socket: { remoteAddress: options.address ?? "203.0.113.7" }
  } as unknown as IncomingMessage;
}

const original = {
  relayAuthToken: config.relayAuthToken,
  allowedOrigins: config.allowedOrigins,
  connPerMinute: config.connPerMinute
};

beforeEach(() => {
  resetRateLimit();
});

afterEach(() => {
  config.relayAuthToken = original.relayAuthToken;
  config.allowedOrigins = original.allowedOrigins;
  config.connPerMinute = original.connPerMinute;
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
});
