import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loginUser, registerUser, resetAccounts } from "../server/accounts";
import {
  LOGIN_BACKOFF_LIMITS,
  checkAuthRateLimit,
  loginAddressGroup,
  loginBackoffEntries,
  loginLockedForMs,
  noteProxyHeaders,
  recordLoginFailure,
  recordLoginSuccess,
  resetAuthRateLimit,
  resetLoginBackoff,
  resetProxyHeaderNotice,
  withLoginBackoff
} from "../server/auth";
import { config } from "../server/config";

const { freeFailures, baseMs, maxMs, sharedAddressMaxMs, accountFailures, accountWindowMs, maxTrackedAccounts } =
  LOGIN_BACKOFF_LIMITS;
const HOME = "198.51.100.7";
const address = (index: number) => `203.0.113.${index}`;

beforeEach(() => {
  resetAuthRateLimit();
  resetLoginBackoff();
  resetAccounts();
});

afterEach(() => {
  resetLoginBackoff();
  resetAccounts();
});

describe("per-route auth rate-limit buckets", () => {
  it("keeps each route class's per-IP budget separate", () => {
    const now = 1_000_000;
    const address = "198.51.100.7";
    for (let attempt = 0; attempt < config.authAttemptsPerMinute; attempt += 1) {
      expect(checkAuthRateLimit(address, now + attempt, "relay-auth")).toBe(true);
    }
    expect(checkAuthRateLimit(address, now + 20, "relay-auth")).toBe(false);
    // Exhausting relay logins must not lock the same visitor out of Cloud,
    // token minting or a password change.
    expect(checkAuthRateLimit(address, now + 20, "cloud-auth")).toBe(true);
    expect(checkAuthRateLimit(address, now + 20, "token-mint")).toBe(true);
    expect(checkAuthRateLimit(address, now + 20, "relay-password")).toBe(true);
    expect(checkAuthRateLimit(address, now + 20, "tool-test")).toBe(true);
  });

  it("defaults to the relay login bucket for existing callers", () => {
    const now = 2_000_000;
    for (let attempt = 0; attempt < config.authAttemptsPerMinute; attempt += 1) {
      expect(checkAuthRateLimit("203.0.113.9", now + attempt)).toBe(true);
    }
    expect(checkAuthRateLimit("203.0.113.9", now + 20, "relay-auth")).toBe(false);
  });
});

describe("login backoff", () => {
  it("allows a few mistakes, then locks that address out of the name for exponentially longer", () => {
    const now = 10_000_000;
    expect(loginLockedForMs("relay", "rider", HOME, now)).toBe(0);
    for (let failure = 1; failure < freeFailures; failure += 1) {
      recordLoginFailure("relay", "rider", HOME, now);
      expect(loginLockedForMs("relay", "rider", HOME, now)).toBe(0);
    }
    recordLoginFailure("relay", "rider", HOME, now);
    expect(loginLockedForMs("relay", "rider", HOME, now)).toBe(baseMs);
    expect(loginLockedForMs("relay", "rider", HOME, now + baseMs)).toBe(0);
    // Each further failure doubles the lockout.
    recordLoginFailure("relay", "rider", HOME, now + baseMs);
    expect(loginLockedForMs("relay", "rider", HOME, now + baseMs)).toBe(baseMs * 2);
    recordLoginFailure("relay", "rider", HOME, now + baseMs * 3);
    expect(loginLockedForMs("relay", "rider", HOME, now + baseMs * 3)).toBe(baseMs * 4);
    // Up to a ceiling.
    for (let failure = 0; failure < 40; failure += 1) recordLoginFailure("relay", "rider", HOME, now + baseMs * 10);
    expect(loginLockedForMs("relay", "rider", HOME, now + baseMs * 10)).toBe(maxMs);
  });

  it("folds case and whitespace in the name and keeps relay and Cloud logins apart", () => {
    const now = 20_000_000;
    for (let failure = 0; failure < freeFailures; failure += 1) {
      recordLoginFailure("cloud", " Rider@Example.com ", HOME, now);
    }
    expect(loginLockedForMs("cloud", "rider@example.com", HOME, now)).toBeGreaterThan(0);
    expect(loginLockedForMs("relay", "rider@example.com", HOME, now)).toBe(0);
  });

  it("starts an address afresh after a successful login", () => {
    const now = 30_000_000;
    for (let failure = 0; failure < freeFailures - 1; failure += 1) recordLoginFailure("relay", "rider", HOME, now);
    recordLoginSuccess("relay", "rider", HOME);
    recordLoginFailure("relay", "rider", HOME, now);
    expect(loginLockedForMs("relay", "rider", HOME, now)).toBe(0);
  });

  it("refuses even the right password while locked, and lets it in afterwards", async () => {
    await registerUser("rider", "password123");
    const start = Date.now();
    for (let failure = 0; failure < freeFailures; failure += 1) {
      const outcome = await withLoginBackoff("relay", "rider", HOME, () => loginUser("rider", "wrong-password"), start);
      expect(outcome.locked).toBe(false);
    }
    const blocked = await withLoginBackoff("relay", "rider", HOME, () => loginUser("rider", "password123"), start);
    expect(blocked).toEqual({ locked: true, retryAfterSeconds: Math.ceil(baseMs / 1000) });

    const later = start + baseMs;
    const allowed = await withLoginBackoff("relay", "rider", HOME, () => loginUser("rider", "password123"), later);
    expect(allowed.locked).toBe(false);
    if (!allowed.locked) expect(allowed.result.ok).toBe(true);
    expect(loginLockedForMs("relay", "rider", HOME, later)).toBe(0);
  });

  it("answers the same for an unknown account as for a real one", async () => {
    await registerUser("rider", "password123");
    const now = Date.now();
    const real: unknown[] = [];
    const unknown: unknown[] = [];
    for (let attempt = 0; attempt <= freeFailures + 1; attempt += 1) {
      const at = now + attempt;
      real.push(await withLoginBackoff("relay", "rider", HOME, () => loginUser("rider", "wrong-password"), at));
      unknown.push(await withLoginBackoff("relay", "nobody", HOME, () => loginUser("nobody", "wrong-password"), at));
    }
    expect(unknown).toEqual(real);
    expect(real.at(-1)).toMatchObject({ locked: true });
  });

  it("lets through only the free mistakes of a burst sent in parallel", async () => {
    await registerUser("rider", "password123");
    const now = Date.now();
    let checked = 0;
    const outcomes = await Promise.all(
      Array.from({ length: 200 }, () =>
        withLoginBackoff(
          "relay",
          "rider",
          HOME,
          () => {
            checked += 1;
            return loginUser("rider", "wrong-password");
          },
          now
        )
      )
    );
    expect(checked).toBe(freeFailures);
    expect(outcomes.filter((outcome) => outcome.locked)).toHaveLength(200 - freeFailures);
  });

  it("does not count an attempt whose password check broke", async () => {
    const now = 50_000_000;
    for (let attempt = 0; attempt < freeFailures * 3; attempt += 1) {
      await expect(
        withLoginBackoff("relay", "rider", HOME, () => Promise.reject(new Error("database down")), now)
      ).rejects.toThrow("database down");
    }
    expect(loginLockedForMs("relay", "rider", HOME, now)).toBe(0);
    expect(loginBackoffEntries()).toBe(0);
  });

  it("does not let one address lock anyone else out of an account", () => {
    const now = 60_000_000;
    for (let failure = 0; failure < 200; failure += 1) recordLoginFailure("relay", "rider", address(1), now + failure);
    expect(loginLockedForMs("relay", "rider", address(1), now + 199)).toBe(maxMs);
    expect(loginLockedForMs("relay", "rider", HOME, now + 200)).toBe(0);
  });

  it("locks a name that many addresses fail on, until the hour moves on", () => {
    const now = 70_000_000;
    const addresses = accountFailures / freeFailures;
    for (let index = 0; index < addresses; index += 1) {
      expect(loginLockedForMs("relay", "rider", address(100), now)).toBe(0);
      for (let failure = 0; failure < freeFailures; failure += 1) {
        recordLoginFailure("relay", "rider", address(index), now + index);
      }
    }
    // An address that never failed is refused too: that is the point.
    expect(loginLockedForMs("relay", "rider", address(100), now + addresses)).toBe(accountWindowMs - addresses);
    expect(loginLockedForMs("relay", "other", address(100), now + addresses)).toBe(0);
    expect(loginLockedForMs("relay", "rider", address(100), now + accountWindowMs)).toBe(0);
  });

  it("still lets the owner in from an address they have logged in from", async () => {
    await registerUser("rider", "password123");
    const now = Date.now();
    const first = await withLoginBackoff("relay", "rider", HOME, () => loginUser("rider", "password123"), now);
    expect(first).toMatchObject({ locked: false, result: { ok: true } });
    expect(loginBackoffEntries()).toBe(0);

    for (let index = 0; index < accountFailures / freeFailures; index += 1) {
      for (let failure = 0; failure < freeFailures; failure += 1) {
        recordLoginFailure("relay", "rider", address(index), now + 1);
      }
    }
    expect(loginLockedForMs("relay", "rider", address(100), now + 2)).toBeGreaterThan(0);
    const owner = await withLoginBackoff("relay", "rider", HOME, () => loginUser("rider", "password123"), now + 2);
    expect(owner).toMatchObject({ locked: false, result: { ok: true } });
    // The owner's own mistakes at that address still count against that address.
    for (let failure = 0; failure < freeFailures; failure += 1) {
      await withLoginBackoff("relay", "rider", HOME, () => loginUser("rider", "wrong-password"), now + 3);
    }
    expect(loginLockedForMs("relay", "rider", HOME, now + 3)).toBe(baseMs);
  });

  it("stays within a fixed number of tracked names and never drops a lock to make room", () => {
    const now = 80_000_000;
    for (let index = 0; index < accountFailures / freeFailures; index += 1) {
      for (let failure = 0; failure < freeFailures; failure += 1) {
        recordLoginFailure("relay", "admin", address(index), now);
      }
    }
    expect(loginLockedForMs("relay", "admin", HOME, now)).toBeGreaterThan(0);
    for (let index = 0; index < maxTrackedAccounts + 500; index += 1) {
      recordLoginFailure("relay", `guess-${index}`, address(200), now + 1);
    }
    expect(loginBackoffEntries()).toBeLessThanOrEqual(maxTrackedAccounts);
    expect(loginLockedForMs("relay", "admin", HOME, now + 1)).toBeGreaterThan(0);
    expect(loginLockedForMs("relay", "admin", address(0), now + 1)).toBeGreaterThan(0);
  });

  it("counts an IPv6 address as its /64, so a fresh address per guess is the same guesser", () => {
    expect(loginAddressGroup("2001:db8:1:2:a:b:c:d")).toBe("2001:db8:1:2::/64");
    expect(loginAddressGroup("2001:DB8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(loginAddressGroup("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(loginAddressGroup("[fe80::1%en0]")).toBe("fe80:0:0:0::/64");
    expect(loginAddressGroup("::1")).toBe("0:0:0:0::/64");
    expect(loginAddressGroup("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(loginAddressGroup("198.51.100.7")).toBe("198.51.100.7");
    expect(loginAddressGroup(undefined)).toBe("unknown");

    const now = 90_000_000;
    // Twenty addresses in one /64 are one address: they lock themselves out, not the account.
    for (let index = 0; index < 20; index += 1) {
      recordLoginFailure("relay", "rider", `2001:db8:1:2::${(index + 1).toString(16)}`, now + index);
    }
    expect(loginLockedForMs("relay", "rider", "2001:db8:1:2::ffff", now + 20)).toBeGreaterThan(0);
    expect(loginLockedForMs("relay", "rider", HOME, now + 20)).toBe(0);
    // And the owner's privacy address changing within their /64 is still their own.
    recordLoginSuccess("relay", "owner", "2001:db8:9:9:1111:2222:3333:4444");
    for (let index = 0; index < accountFailures / freeFailures; index += 1) {
      for (let failure = 0; failure < freeFailures; failure += 1) {
        recordLoginFailure("relay", "owner", address(index), now);
      }
    }
    expect(loginLockedForMs("relay", "owner", address(100), now)).toBeGreaterThan(0);
    expect(loginLockedForMs("relay", "owner", "2001:db8:9:9:aaaa:bbbb:cccc:dddd", now)).toBe(0);
  });

  it("never locks a name for more than a minute when every client shares the proxy's address", () => {
    const now = 100_000_000;
    const proxy = "10.0.0.2";
    // A request with X-Forwarded-For while RELAY_TRUST_PROXY is off: the relay is behind a proxy it does not trust.
    noteProxyHeaders({ headers: { "x-forwarded-for": "203.0.113.9" }, socket: {} } as never);
    try {
      for (let failure = 0; failure < 40; failure += 1) recordLoginFailure("relay", "rider", proxy, now);
      expect(loginLockedForMs("relay", "rider", proxy, now)).toBe(sharedAddressMaxMs);
      expect(loginLockedForMs("relay", "rider", proxy, now + sharedAddressMaxMs)).toBe(0);
      // The shared address is nobody's own: a login from it earns no exemption from the account-wide lock.
      recordLoginSuccess("relay", "rider", proxy);
      for (let index = 0; index < accountFailures / freeFailures; index += 1) {
        for (let failure = 0; failure < freeFailures; failure += 1) {
          recordLoginFailure("relay", "rider", address(index), now + sharedAddressMaxMs);
        }
      }
      expect(loginLockedForMs("relay", "rider", proxy, now + sharedAddressMaxMs)).toBeGreaterThan(0);
    } finally {
      resetProxyHeaderNotice();
    }
    // With the proxy trusted (or absent) the same history locks for the full time.
    expect(loginLockedForMs("relay", "rider", proxy, now + 2 * sharedAddressMaxMs)).toBeGreaterThan(0);
  });

  it("ignores empty or non-string account names", () => {
    recordLoginFailure("relay", undefined, HOME, 1);
    recordLoginFailure("relay", "   ", HOME, 1);
    expect(loginBackoffEntries()).toBe(0);
    expect(loginLockedForMs("relay", undefined, HOME, 1)).toBe(0);
  });
});
