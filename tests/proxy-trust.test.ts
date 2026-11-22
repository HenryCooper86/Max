import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientAddress, noteProxyHeaders, resetProxyHeaderNotice, untrustedProxyHeadersSeen } from "../server/auth";
import { config, readinessWarnings, validateConfig } from "../server/config";

// Behind Caddy/nginx with RELAY_TRUST_PROXY off every visitor shares the
// proxy's address, so the per-IP limits become global. The default stays off
// (trusting the header on an unproxied relay lets clients pick their address),
// so the relay has to say so loudly instead.

const CLOUD_KEY = "a".repeat(64);
const original = { voiceProvider: config.voiceProvider, trustProxy: config.trustProxy };

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { url: "/auth/login", headers, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
}

function proxyWarnings(): string[] {
  return validateConfig().filter((warning) => warning.includes("RELAY_TRUST_PROXY"));
}

beforeEach(() => {
  resetProxyHeaderNotice();
  vi.stubEnv("CLOUD_SECRET_KEY", "");
});

afterEach(() => {
  config.voiceProvider = original.voiceProvider;
  config.trustProxy = original.trustProxy;
  resetProxyHeaderNotice();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("startup warning", () => {
  it("warns in Chinese and English when a live backend runs without proxy trust", () => {
    config.voiceProvider = "openai";
    config.trustProxy = false;
    const [warning] = proxyWarnings();
    expect(warning).toContain("反向代理");
    expect(warning).toContain("reverse proxy");
    expect(warning).toContain("RELAY_TRUST_PROXY=on");
  });

  it("warns for a Max Cloud deployment even on the mock backend", () => {
    config.voiceProvider = "mock";
    config.trustProxy = false;
    expect(proxyWarnings()).toEqual([]);
    vi.stubEnv("CLOUD_SECRET_KEY", CLOUD_KEY);
    expect(proxyWarnings()).toHaveLength(1);
  });

  it("stays quiet once proxy trust is on", () => {
    config.voiceProvider = "openai";
    config.trustProxy = true;
    vi.stubEnv("CLOUD_SECRET_KEY", CLOUD_KEY);
    expect(proxyWarnings()).toEqual([]);
  });
});

describe("forwarded headers while proxy trust is off", () => {
  it("logs one loud warning the first time, and reports it on /ready without failing it", () => {
    config.trustProxy = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readinessWarnings()).toEqual([]);

    noteProxyHeaders(request());
    expect(warn).not.toHaveBeenCalled();
    expect(untrustedProxyHeadersSeen()).toBe(false);

    // clientAddress is on every rate-limited path, so it notices too.
    expect(clientAddress(request({ "x-forwarded-for": "198.51.100.7" }))).toBe("127.0.0.1");
    noteProxyHeaders(request({ forwarded: "for=198.51.100.8" }));
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("RELAY_TRUST_PROXY");
    expect(line).toContain("X-Forwarded-For");
    expect(untrustedProxyHeadersSeen()).toBe(true);
    expect(readinessWarnings()).toEqual(["proxy-headers-untrusted"]);
  });

  it("notices the standard Forwarded header as well", () => {
    config.trustProxy = false;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    noteProxyHeaders(request({ forwarded: "for=198.51.100.8;proto=https" }));
    expect(untrustedProxyHeadersSeen()).toBe(true);
  });

  it("says nothing when proxy trust is on", () => {
    config.trustProxy = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    noteProxyHeaders(request({ "x-forwarded-for": "198.51.100.7" }));
    expect(warn).not.toHaveBeenCalled();
    expect(readinessWarnings()).toEqual([]);
  });
});
