import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerUser, resetAccounts, setUserRole } from "../server/accounts";
import {
  authorizeAccountUpgrade,
  authorizeUpgrade,
  checkAuthRateLimit,
  checkRateLimit,
  clientAddress,
  resetAuthRateLimit,
  resetRateLimit,
  testingClearAuthorized,
  testingAccess,
  testingStatsAuthorized
} from "../server/auth";
import { config } from "../server/config";

function fakeRequest(
  options: {
    url?: string;
    origin?: string;
    address?: string;
    forwardedFor?: string | string[];
    authorization?: string;
  } = {}
): IncomingMessage {
  const headers: Record<string, unknown> = {};
  if (options.origin) headers.origin = options.origin;
  if (options.authorization) headers.authorization = options.authorization;
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
  resetAuthRateLimit();
  resetAccounts();
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

describe("authorizeAccountUpgrade", () => {
  it("requires a live account session and rejects the operator token", async () => {
    config.relayAuthToken = "operator-token";
    config.allowedOrigins = [];
    config.connPerMinute = 0;
    const registeredAt = Date.now();
    const registered = await registerUser("phone-rider", "password123", undefined, registeredAt);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    expect(authorizeAccountUpgrade(fakeRequest())).toMatchObject({ ok: false, code: 401 });
    expect(authorizeAccountUpgrade(fakeRequest({ url: "/companion?token=operator-token" }))).toMatchObject({
      ok: false,
      code: 401
    });
    expect(authorizeAccountUpgrade(fakeRequest({ url: `/companion?token=${registered.token}` }))).toMatchObject({
      ok: true,
      token: registered.token,
      user: { id: registered.user.id }
    });

    const expiredAt = registeredAt + config.authSessionDays * 86_400_000 + 1;
    expect(
      authorizeAccountUpgrade(fakeRequest({ url: `/companion?token=${registered.token}` }), expiredAt)
    ).toMatchObject({ ok: false, code: 401 });
  });
});

describe("testingStatsAuthorized", () => {
  it("stays open when no relay token is configured (internal test mode)", () => {
    config.relayAuthToken = "";
    expect(testingStatsAuthorized(fakeRequest({ url: "/health" }))).toBe(true);
  });

  it("requires the token once one is configured — tester transcripts/IPs must not leak", () => {
    config.relayAuthToken = "s3cret";
    expect(testingStatsAuthorized(fakeRequest({ url: "/health" }))).toBe(false);
    expect(testingStatsAuthorized(fakeRequest({ url: "/health?token=wrong" }))).toBe(false);
    expect(testingStatsAuthorized(fakeRequest({ url: "/health", authorization: "Bearer nope" }))).toBe(false);
    expect(testingStatsAuthorized(fakeRequest({ url: "/health?token=s3cret" }))).toBe(true);
    expect(testingStatsAuthorized(fakeRequest({ url: "/health", authorization: "Bearer s3cret" }))).toBe(true);
  });
});

describe("user sessions in the gates", () => {
  it("scopes testers to their username while reviewers can inspect the full corpus", async () => {
    config.relayAuthToken = "";
    const admin = await registerUser("boss", "hunter2-hunter2");
    const tester = await registerUser("rider", "password123");
    const reviewer = await registerUser("reviewer", "password123");
    expect(admin.ok && tester.ok && reviewer.ok).toBe(true);
    if (!admin.ok || !tester.ok || !reviewer.ok) return;
    expect(setUserRole("reviewer", "reviewer").ok).toBe(true);

    expect(testingAccess(fakeRequest({ authorization: `Bearer ${tester.token}` }))).toEqual({
      allowed: true,
      role: "tester",
      testerId: "rider"
    });
    expect(testingAccess(fakeRequest({ authorization: `Bearer ${reviewer.token}` }))).toEqual({
      allowed: true,
      role: "reviewer"
    });
  });

  it("locks the testing stats once the first user registers, unlocked by login session", async () => {
    config.relayAuthToken = "";
    expect(testingStatsAuthorized(fakeRequest({ url: "/health" }))).toBe(true); // open mode

    const registered = await registerUser("boss", "hunter2-hunter2");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    expect(testingStatsAuthorized(fakeRequest({ url: "/health" }))).toBe(false); // now locked
    expect(testingStatsAuthorized(fakeRequest({ url: "/health", authorization: `Bearer ${registered.token}` }))).toBe(
      true
    );
    expect(testingStatsAuthorized(fakeRequest({ url: `/health?token=${registered.token}` }))).toBe(true);
  });

  it("restricts clears to admins (relay token stays the master key)", async () => {
    config.relayAuthToken = "";
    expect(testingClearAuthorized(fakeRequest({ url: "/testing/clear" }))).toBe(true); // open mode

    const admin = await registerUser("boss", "hunter2-hunter2");
    const tester = await registerUser("rider", "password123");
    expect(admin.ok && tester.ok).toBe(true);
    if (!admin.ok || !tester.ok) return;

    expect(testingClearAuthorized(fakeRequest({ url: "/testing/clear" }))).toBe(false);
    expect(testingClearAuthorized(fakeRequest({ authorization: `Bearer ${tester.token}` }))).toBe(false); // can view…
    expect(testingStatsAuthorized(fakeRequest({ authorization: `Bearer ${tester.token}` }))).toBe(true); // …not clear
    expect(testingClearAuthorized(fakeRequest({ authorization: `Bearer ${admin.token}` }))).toBe(true);

    config.relayAuthToken = "s3cret";
    expect(testingClearAuthorized(fakeRequest({ url: "/testing/clear?token=s3cret" }))).toBe(true);
  });

  it("accepts a login session for the /agent upgrade on token-protected relays", async () => {
    config.relayAuthToken = "s3cret";
    const registered = await registerUser("rider", "password123");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    expect(authorizeUpgrade(fakeRequest({ url: `/agent?token=${registered.token}` }))).toEqual({ ok: true });
    expect(authorizeUpgrade(fakeRequest({ url: "/agent?token=sess_forged" })).ok).toBe(false);
    expect(authorizeUpgrade(fakeRequest({ url: "/agent?token=s3cret" }))).toEqual({ ok: true });
  });

  it("locks the /agent upgrade behind login once accounts exist, even with no relay token", async () => {
    config.relayAuthToken = "";
    expect(authorizeUpgrade(fakeRequest())).toEqual({ ok: true }); // open mode

    const registered = await registerUser("rider", "password123");
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    // The site gate is enforcement, not decoration: anonymous voice sessions
    // are refused as soon as the first account exists.
    expect(authorizeUpgrade(fakeRequest()).ok).toBe(false);
    expect(authorizeUpgrade(fakeRequest({ url: "/agent?token=sess_forged" })).ok).toBe(false);
    expect(authorizeUpgrade(fakeRequest({ url: `/agent?token=${registered.token}` }))).toEqual({ ok: true });
  });

  it("rate limits auth attempts per address independently of the upgrade limiter", () => {
    const now = 9_000_000;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(checkAuthRateLimit("198.51.100.7", now + attempt)).toBe(true);
    }
    expect(checkAuthRateLimit("198.51.100.7", now + 20)).toBe(false);
    expect(checkAuthRateLimit("198.51.100.8", now + 20)).toBe(true); // other address unaffected
    expect(checkAuthRateLimit("198.51.100.7", now + 61_000)).toBe(true); // window slides
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
