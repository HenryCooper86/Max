import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKEN_TTL_SECONDS,
  MAX_TOKEN_TTL_SECONDS,
  MIN_TOKEN_TTL_SECONDS,
  SESSION_TOKEN_PREFIX,
  createSessionTokenStore
} from "../server/session-tokens";

function store(start = 1_000_000) {
  const clock = { now: start };
  return { clock, tokens: createSessionTokenStore(() => clock.now) };
}

function mintOk(tokens: ReturnType<typeof createSessionTokenStore>, request = {}) {
  const result = tokens.mint(request);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("mint", () => {
  it("issues a prefixed token with the default ttl", () => {
    const { tokens } = store();
    const result = mintOk(tokens);
    expect(result.token.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
    expect(result.token.length).toBeGreaterThan(40);
    expect(result.expiresAt).toBe(1_000_000 + DEFAULT_TOKEN_TTL_SECONDS * 1000);
    expect(mintOk(tokens).token).not.toBe(result.token);
  });

  it("accepts ttl bounds and rejects outside or non-integers", () => {
    const { tokens } = store();
    expect(mintOk(tokens, { ttlSeconds: MIN_TOKEN_TTL_SECONDS }).expiresAt).toBe(1_000_000 + 30_000);
    expect(mintOk(tokens, { ttlSeconds: MAX_TOKEN_TTL_SECONDS }).expiresAt).toBe(1_000_000 + 3_600_000);
    expect(mintOk(tokens, { ttlSeconds: "60" }).expiresAt).toBe(1_000_000 + 60_000);
    for (const ttlSeconds of [29, 3601, 60.5, "abc", null, NaN, {}]) {
      const result = tokens.mint({ ttlSeconds });
      expect(result.ok, String(ttlSeconds)).toBe(false);
    }
  });

  it("validates userId", () => {
    const { tokens } = store();
    expect(tokens.mint({ userId: "" }).ok).toBe(false);
    expect(tokens.mint({ userId: "   " }).ok).toBe(false);
    expect(tokens.mint({ userId: 5 }).ok).toBe(false);
    expect(tokens.mint({ userId: "x".repeat(129) }).ok).toBe(false);
    expect(tokens.mint({ userId: "x".repeat(128) }).ok).toBe(true);
  });

  it("validates context", () => {
    const { tokens } = store();
    expect(tokens.mint({ context: 5 }).ok).toBe(false);
    expect(tokens.mint({ context: "x".repeat(4001) }).ok).toBe(false);
    expect(tokens.mint({ context: "x".repeat(4000) }).ok).toBe(true);
  });
});

describe("grant", () => {
  it("returns trimmed userId and context; blank context is dropped", () => {
    const { tokens } = store();
    const full = mintOk(tokens, { userId: " u-1 ", context: "  on pricing page " });
    expect(tokens.grant(full.token)).toEqual({ expiresAt: full.expiresAt, userId: "u-1", context: "on pricing page" });
    const bare = mintOk(tokens, { context: "   " });
    expect(tokens.grant(bare.token)).toEqual({ expiresAt: bare.expiresAt });
  });

  it("rejects unknown, empty and wrongly prefixed tokens", () => {
    const { tokens } = store();
    const { token } = mintOk(tokens);
    expect(tokens.grant(undefined)).toBeUndefined();
    expect(tokens.grant(null)).toBeUndefined();
    expect(tokens.grant("")).toBeUndefined();
    expect(tokens.grant("vst_unknown")).toBeUndefined();
    expect(tokens.grant(token.slice(SESSION_TOKEN_PREFIX.length))).toBeUndefined();
  });

  it("expires exactly at expiresAt", () => {
    const { tokens, clock } = store();
    const { token, expiresAt } = mintOk(tokens, { ttlSeconds: 60 });
    clock.now = expiresAt - 1;
    expect(tokens.grant(token)).toBeDefined();
    clock.now = expiresAt;
    expect(tokens.grant(token)).toBeUndefined();
    expect(tokens.size()).toBe(0);
  });

  it("revoke removes a token", () => {
    const { tokens } = store();
    const { token } = mintOk(tokens);
    expect(tokens.size()).toBe(1);
    tokens.revoke(token);
    expect(tokens.grant(token)).toBeUndefined();
    expect(tokens.size()).toBe(0);
    expect(() => tokens.revoke("missing")).not.toThrow();
  });

  it("prunes expired tokens when counting", () => {
    const { tokens, clock } = store();
    mintOk(tokens, { ttlSeconds: 30 });
    mintOk(tokens, { ttlSeconds: 600 });
    clock.now += 31_000;
    expect(tokens.size()).toBe(1);
  });
});
