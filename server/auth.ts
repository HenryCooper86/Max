// Access control for the /agent WebSocket upgrade. Three layers, all optional
// and configured via environment so the open demo setup keeps working:
//   1. Shared token  — RELAY_AUTH_TOKEN, sent by clients as ?token=…, or a
//      short-lived session token minted with it (server/session-tokens.ts)
//   2. Origin check  — RELAY_ALLOWED_ORIGINS, comma-separated allowlist
//   3. Rate limiting — RELAY_CONN_PER_MINUTE upgrade attempts per client IP
// The relay holds the Doubao credentials, so without at least the token anyone
// who discovers the URL can burn the API quota.

import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isIPv6 } from "node:net";
import { authActive, sessionUser, type PublicUser } from "./accounts";
// runtime-config, not ./config: config.ts reads the proxy-header notice below
// for /ready, and importing it back would make the two modules a cycle.
import { config } from "./runtime-config";
import { createLogger } from "./logger";
import { cloudSessionTokens, sessionTokens } from "./session-tokens";

export type UpgradeDecision = { ok: true } | { ok: false; code: number; reason: string };
export type AccountUpgradeDecision =
  { ok: true; token: string; user: PublicUser } | { ok: false; code: number; reason: string };

const RATE_WINDOW_MS = 60_000;
// Per-address timestamps of recent upgrade attempts within the trailing window.
const rateHits = new Map<string, number[]>();

/**
 * Compares secrets without leaking prefix information via timing. The length
 * pre-check is mandatory — timingSafeEqual throws on unequal-length buffers — so
 * the expected length is (negligibly, for a high-entropy token) observable; only
 * the byte-by-byte comparison is constant-time.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const log = createLogger("auth");
let proxyHeadersSeen = false;

/**
 * Notices a forwarded request while RELAY_TRUST_PROXY is off. Behind Caddy or
 * nginx that means every visitor shares the proxy's address, so the per-IP
 * limits on /agent, logins and the public embed become one global bucket that
 * a single visitor can exhaust for everyone. The default must stay off (on an
 * unproxied relay a client could pick its own address), so say it once, loudly.
 * A client can send these headers to a relay with no proxy too, which is why
 * this only warns and never changes behaviour.
 */
export function noteProxyHeaders(request: IncomingMessage): void {
  if (proxyHeadersSeen || config.trustProxy) return;
  if (request.headers["x-forwarded-for"] === undefined && request.headers.forwarded === undefined) return;
  proxyHeadersSeen = true;
  log.warn(
    "!!! A request arrived with X-Forwarded-For/Forwarded but RELAY_TRUST_PROXY is off. If this relay is behind a " +
      "reverse proxy, every client now shares the proxy's address and the per-IP rate limits (WebSocket, login, " +
      "embed) are global: one visitor can lock everyone out. Set RELAY_TRUST_PROXY=on (and RELAY_TRUSTED_PROXY_HOPS). " +
      "收到带 X-Forwarded-For/Forwarded 头的请求，但 RELAY_TRUST_PROXY 为 off：若位于反向代理之后，所有客户端共用代理 IP，" +
      "按 IP 的速率限制会变成全局限制。请设置 RELAY_TRUST_PROXY=on。",
    { remoteAddress: request.socket?.remoteAddress ?? "unknown" }
  );
}

/** True once a forwarded request reached the relay while proxy trust was off. */
export function untrustedProxyHeadersSeen(): boolean {
  return proxyHeadersSeen && !config.trustProxy;
}

/** Test hook: forgets that a forwarded request was seen. */
export function resetProxyHeaderNotice(): void {
  proxyHeadersSeen = false;
}

export function clientAddress(request: IncomingMessage): string {
  noteProxyHeaders(request);
  // Trust the proxy header only when explicitly enabled — otherwise any client
  // could spoof X-Forwarded-For to dodge the per-IP limit.
  if (config.trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    const entries = (raw ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    // Proxies APPEND the address they received from, so the real client IP is
    // `trustedProxyHops` entries from the right; anything further left was set
    // by the client and is spoofable. Taking the leftmost entry (as before)
    // would let a client forge its own IP and evade the per-IP limit.
    const candidate = entries[entries.length - config.trustedProxyHops];
    if (candidate) return candidate;
  }
  return request.socket.remoteAddress ?? "unknown";
}

export function clientRegionHint(request: IncomingMessage): string | undefined {
  const candidate =
    request.headers["cf-ipcountry"] ??
    request.headers["x-vercel-ip-country-region"] ??
    request.headers["x-vercel-ip-country"];
  const value = Array.isArray(candidate) ? candidate[0] : candidate;
  return value?.trim() || undefined;
}

/**
 * Sliding-window upgrade-attempt limiter: allows at most `connPerMinute`
 * attempts per address across any trailing 60 s span (not a fixed bucket that
 * resets on the minute, which would permit a ~2× burst across the boundary).
 * Exported for tests.
 */
export function checkRateLimit(address: string, now = Date.now()): boolean {
  if (config.connPerMinute <= 0) return true;

  const cutoff = now - RATE_WINDOW_MS;
  const recent = (rateHits.get(address) ?? []).filter((at) => at > cutoff);

  if (recent.length >= config.connPerMinute) {
    // Persist the pruned list so a blocked address can't grow memory unbounded.
    rateHits.set(address, recent);
    return false;
  }

  recent.push(now);
  rateHits.set(address, recent);

  // Opportunistic cleanup so long-running relays don't accumulate dead IPs.
  if (rateHits.size > 10_000) {
    for (const [key, value] of rateHits) {
      const pruned = value.filter((at) => at > cutoff);
      if (pruned.length === 0) rateHits.delete(key);
      else rateHits.set(key, pruned);
    }
  }

  return true;
}

/** Test hook: clears rate-limit state between cases. */
export function resetRateLimit() {
  rateHits.clear();
}

/** The credentials a request presented: `?token=…` and/or a Bearer header. */
export function presentedTokens(request: IncomingMessage): string[] {
  const url = new URL(request.url ?? "/", "http://relay.local");
  const fromQuery = url.searchParams.get("token") ?? "";
  const authorization = request.headers.authorization ?? "";
  const fromHeader = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  return [fromQuery, fromHeader].filter(Boolean);
}

function matchesRelayToken(tokens: string[]): boolean {
  if (!config.relayAuthToken) return false;
  return tokens.some((token) => tokenMatches(token, config.relayAuthToken));
}

/** True when the request presented the configured operator relay token. */
export function relayTokenPresented(request: IncomingMessage): boolean {
  return matchesRelayToken(presentedTokens(request));
}

/** The logged-in user behind a request's session token, if any. */
export function requestUser(request: IncomingMessage): PublicUser | null {
  return requestSession(request)?.user ?? null;
}

/** The concrete login session presented by a request, including its opaque
 * token so an HTTP logout/password change can revoke matching live sockets. */
export function requestSession(request: IncomingMessage, now = Date.now()): { token: string; user: PublicUser } | null {
  for (const token of presentedTokens(request)) {
    const user = sessionUser(token, now);
    if (user) return { token, user };
  }
  return null;
}

/**
 * Whether an HTTP request may see the per-tester QA statistics (IPs, regions,
 * chat transcripts). Open only while NEITHER a relay token is configured NOR
 * any user account exists — the documented plug-and-play internal mode. Once
 * either is in place, the request must present the relay token (?token=… or
 * Authorization: Bearer …) or a valid login session. /health liveness fields
 * stay open either way, so the one-curl deployment check keeps working.
 */
export function testingStatsAuthorized(request: IncomingMessage): boolean {
  return testingAccess(request).allowed;
}

export type TestingAccess =
  | { allowed: true; role: "operator" | "admin" | "reviewer"; testerId?: undefined }
  | { allowed: true; role: "tester"; testerId: string }
  | { allowed: false; role: "anonymous"; testerId?: undefined };

/** Evidence scope for HTTP APIs: testers see only their own rows, while
 * reviewers/admins/operator tokens may inspect the complete release corpus. */
export function testingAccess(request: IncomingMessage): TestingAccess {
  if (matchesRelayToken(presentedTokens(request))) return { allowed: true, role: "operator" };
  if (!config.relayAuthToken && !authActive()) return { allowed: true, role: "admin" };
  const user = requestUser(request);
  if (!user) return { allowed: false, role: "anonymous" };
  if (user.role === "admin" || user.role === "reviewer") return { allowed: true, role: user.role };
  return { allowed: true, role: "tester", testerId: user.username };
}

/**
 * Whether a request may DELETE tester QA data (/testing/clear). Stricter than
 * viewing: once user accounts exist, only an admin login (or the relay token,
 * which remains the operator master key) may clear.
 */
export function testingClearAuthorized(request: IncomingMessage): boolean {
  if (!config.relayAuthToken && !authActive()) return true;
  if (matchesRelayToken(presentedTokens(request))) return true;
  return requestUser(request)?.role === "admin";
}

// Login/registration attempts get their own, deliberately tight sliding
// window per client IP — independent of the /agent upgrade limiter so a
// password-guessing loop can't ride on a generous RELAY_CONN_PER_MINUTE.
// Each route class counts separately: a visitor who used up relay logins (or
// an office behind one NAT address) must still be able to sign in to Cloud or
// change a password, and anonymous token minting must not eat login attempts.
export type AuthRateBucket = "relay-auth" | "relay-password" | "cloud-auth" | "token-mint" | "tool-test";
const authHits = new Map<string, number[]>();

export function checkAuthRateLimit(address: string, now = Date.now(), bucket: AuthRateBucket = "relay-auth"): boolean {
  const key = `${bucket} ${address}`;
  const cutoff = now - RATE_WINDOW_MS;
  const recent = (authHits.get(key) ?? []).filter((at) => at > cutoff);
  if (recent.length >= config.authAttemptsPerMinute) {
    authHits.set(key, recent);
    return false;
  }
  recent.push(now);
  authHits.set(key, recent);
  if (authHits.size > 10_000) {
    for (const [entry, value] of authHits) {
      const pruned = value.filter((at) => at > cutoff);
      if (pruned.length === 0) authHits.delete(entry);
      else authHits.set(entry, pruned);
    }
  }
  return true;
}

/** Test hook: clears auth rate-limit state between cases. */
export function resetAuthRateLimit() {
  authHits.clear();
}

// Login backoff. The per-IP window above does nothing against a guesser
// spread over many addresses, and a lockout on the account name alone would let
// anyone who knows a name keep its owner out. So failures are counted twice:
//
// - Per account name and client address. After a few free mistakes each
//   further failure doubles that address's lockout for that name, up to a
//   ceiling. An address can only lock itself out, and "address" means what
//   one subscriber controls: an IPv6 address counts as its /64 network, or
//   anyone could draw a fresh address per guess. People who really do share
//   one address (an office, a mobile carrier's NAT) share its count.
// - Per account name, across addresses, over the last hour. Each address adds
//   at most its free mistakes to this count, so it takes several addresses to
//   fill it. While it is full the name is locked until the hour moves on,
//   except for addresses that have logged in to it successfully before: its
//   owner, on a connection they have used, is not shut out by an attack on
//   their account.
//
// An attempt is counted as a failure before its password is checked and
// uncounted if it succeeds, so of a burst sent in parallel only the free
// mistakes are checked.
//
// Behind a reverse proxy with RELAY_TRUST_PROXY off every client appears to
// come from the proxy's address. A lock on that address would then be a lock
// on the name for everybody, which anyone could hold against its owner, so in
// that state (untrustedProxyHeadersSeen) a lock lasts at most a minute and no
// address is remembered as the owner's. Counts are keyed by the name as typed
// (normalised), whether or not such an account exists, so a locked response
// says nothing about which accounts are real.
export type LoginScope = "relay" | "cloud";

export const LOGIN_BACKOFF_LIMITS = {
  freeFailures: 5,
  baseMs: 1_000,
  maxMs: 15 * 60_000,
  // The longest lock while every client shares the proxy's address.
  sharedAddressMaxMs: 60_000,
  // An address's count for a name with no failure for this long starts afresh.
  forgetAfterMs: 24 * 3_600_000,
  // Failed logins to one name, from all addresses together, per window.
  accountFailures: 20,
  accountWindowMs: 3_600_000,
  // Bounded so a flood of made-up names or addresses cannot grow memory
  // without limit. A full table drops its least recently failed unlocked
  // entry; a lock in force is never dropped to make room.
  maxTrackedAccounts: 10_000,
  maxTrackedPairs: 50_000,
  knownAddressesPerAccount: 8
} as const;

type LoginFailures = { failures: number; lastFailureAt: number; lockedUntil: number };

class FailureTable {
  // Map order is least recently failed first: every failure re-inserts its key.
  private readonly entries = new Map<string, LoginFailures>();

  constructor(
    private readonly capacity: number,
    private readonly freeFailures: number
  ) {}

  get size(): number {
    return this.entries.size;
  }

  private stale(entry: LoginFailures, now: number): boolean {
    return now - entry.lastFailureAt >= LOGIN_BACKOFF_LIMITS.forgetAfterMs && entry.lockedUntil <= now;
  }

  /** `maxLockMs` shortens a lock to that long after the failure that set it. */
  lockedForMs(key: string, now: number, maxLockMs = Infinity): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    if (this.stale(entry, now)) {
      this.entries.delete(key);
      return 0;
    }
    return Math.max(0, Math.min(entry.lockedUntil, entry.lastFailureAt + maxLockMs) - now);
  }

  /** Makes room for one new key. False when every entry holds a lock in force. */
  private makeRoom(now: number): boolean {
    for (const [key, entry] of this.entries) {
      if (!this.stale(entry, now)) break;
      this.entries.delete(key);
    }
    if (this.entries.size < this.capacity) return true;
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil > now) continue;
      this.entries.delete(key);
      return true;
    }
    return false;
  }

  /** Counts one failure. Returns the new count, or 0 when the table is full of locks and cannot track the key. */
  fail(key: string, now: number): number {
    const previous = this.entries.get(key);
    if (!previous && this.entries.size >= this.capacity && !this.makeRoom(now)) return 0;
    const failures = !previous || this.stale(previous, now) ? 1 : previous.failures + 1;
    const { baseMs, maxMs } = LOGIN_BACKOFF_LIMITS;
    const lockMs =
      failures < this.freeFailures ? 0 : Math.min(maxMs, baseMs * 2 ** Math.min(30, failures - this.freeFailures));
    this.entries.delete(key);
    this.entries.set(key, {
      failures,
      lastFailureAt: now,
      lockedUntil: Math.max(previous?.lockedUntil ?? 0, now + lockMs)
    });
    return failures;
  }

  /** Takes back one failure that turned out not to be one. Its lock, if it set one, runs out on its own. */
  undo(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.failures <= 1) this.entries.delete(key);
    else entry.failures -= 1;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Failed logins per account name across addresses, as a sliding window. */
class AccountWindow {
  // Failure times per name, oldest first, at most `accountFailures` of them.
  // Map order is least recently failed first.
  private readonly entries = new Map<string, number[]>();

  get size(): number {
    return this.entries.size;
  }

  private recent(key: string, now: number): number[] {
    const times = this.entries.get(key);
    if (!times) return [];
    const kept = times.filter((at) => now - at < LOGIN_BACKOFF_LIMITS.accountWindowMs);
    if (kept.length === 0) this.entries.delete(key);
    else if (kept.length !== times.length) this.entries.set(key, kept);
    return kept;
  }

  lockedForMs(key: string, now: number): number {
    const times = this.recent(key, now);
    const { accountFailures, accountWindowMs } = LOGIN_BACKOFF_LIMITS;
    return times.length < accountFailures ? 0 : Math.max(0, times[0]! + accountWindowMs - now);
  }

  /** Counts one failure. False when the table is full of locked names and cannot track this one. */
  fail(key: string, now: number): boolean {
    const times = this.recent(key, now);
    if (times.length === 0 && this.entries.size >= LOGIN_BACKOFF_LIMITS.maxTrackedAccounts) {
      let room = false;
      for (const candidate of [...this.entries.keys()]) {
        if (this.lockedForMs(candidate, now) > 0) continue;
        this.entries.delete(candidate);
        room = true;
        break;
      }
      if (!room) return false;
    }
    this.entries.delete(key);
    this.entries.set(key, [...times, now].slice(-LOGIN_BACKOFF_LIMITS.accountFailures));
    return true;
  }

  /** Takes back the most recent failure. */
  undo(key: string): void {
    const times = this.entries.get(key);
    if (!times) return;
    if (times.length <= 1) this.entries.delete(key);
    else times.pop();
  }

  clear(): void {
    this.entries.clear();
  }
}

const pairFailures = new FailureTable(LOGIN_BACKOFF_LIMITS.maxTrackedPairs, LOGIN_BACKOFF_LIMITS.freeFailures);
const accountFailures = new AccountWindow();
// Addresses that have logged in to an account, most recent last. In memory
// only: after a restart the failure counts are gone too.
const knownAddresses = new Map<string, string[]>();

type LoginKeys = { account: string; pair: string; address: string };

/**
 * What a login's source counts as: an IPv4 address as itself, an IPv6 address
 * as its /64 (one subscriber's network, within which a client picks addresses
 * freely and privacy extensions change them daily).
 */
export function loginAddressGroup(address: unknown): string {
  if (typeof address !== "string" || !address) return "unknown";
  const bare = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  const mapped = /^(?:::ffff:|::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (mapped?.[1]) return mapped[1];
  if (!isIPv6(bare)) return bare.slice(0, 64);
  const [head = "", tail = ""] = bare.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = bare.includes("::")
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

function loginKeys(scope: LoginScope, identifier: unknown, address: unknown): LoginKeys | null {
  if (typeof identifier !== "string") return null;
  const normalised = identifier.normalize("NFKC").trim().toLowerCase().slice(0, 320);
  if (!normalised) return null;
  const from = loginAddressGroup(address);
  const account = `${scope} ${normalised}`;
  return { account, pair: `${account} ${from}`, address: from };
}

function addressKnown(keys: LoginKeys): boolean {
  return !untrustedProxyHeadersSeen() && knownAddresses.get(keys.account)?.includes(keys.address) === true;
}

function lockedForMs(keys: LoginKeys, now: number): number {
  const pair = pairFailures.lockedForMs(
    keys.pair,
    now,
    untrustedProxyHeadersSeen() ? LOGIN_BACKOFF_LIMITS.sharedAddressMaxMs : Infinity
  );
  return addressKnown(keys) ? pair : Math.max(pair, accountFailures.lockedForMs(keys.account, now));
}

/** Counts a failure in both tables. True when it was added to the account's cross-address count. */
function countFailure(keys: LoginKeys, now: number): boolean {
  const failures = pairFailures.fail(keys.pair, now);
  // One address adds at most its free mistakes to the account's count, so a
  // single address can lock itself out but never the account.
  if (failures > LOGIN_BACKOFF_LIMITS.freeFailures) return false;
  return accountFailures.fail(keys.account, now);
}

/** Milliseconds until `identifier` may try to log in from `address` again; 0 when it may now. */
export function loginLockedForMs(scope: LoginScope, identifier: unknown, address: unknown, now = Date.now()): number {
  const keys = loginKeys(scope, identifier, address);
  return keys ? lockedForMs(keys, now) : 0;
}

export function recordLoginFailure(scope: LoginScope, identifier: unknown, address: unknown, now = Date.now()): void {
  const keys = loginKeys(scope, identifier, address);
  if (keys) countFailure(keys, now);
}

/** A login succeeded: the address starts afresh and is remembered as one of the account's own. */
export function recordLoginSuccess(scope: LoginScope, identifier: unknown, address: unknown): void {
  const keys = loginKeys(scope, identifier, address);
  if (!keys) return;
  pairFailures.delete(keys.pair);
  if (untrustedProxyHeadersSeen()) return;
  const known = (knownAddresses.get(keys.account) ?? []).filter((entry) => entry !== keys.address);
  known.push(keys.address);
  knownAddresses.delete(keys.account);
  knownAddresses.set(keys.account, known.slice(-LOGIN_BACKOFF_LIMITS.knownAddressesPerAccount));
  while (knownAddresses.size > LOGIN_BACKOFF_LIMITS.maxTrackedAccounts) {
    const oldest = knownAddresses.keys().next().value;
    if (oldest === undefined) break;
    knownAddresses.delete(oldest);
  }
}

/**
 * Runs a login attempt under the backoff: refused without trying while the
 * name is locked for this address (even with the right password, or the
 * lockout would only slow down guesses that are wrong), otherwise counted and
 * run.
 */
export async function withLoginBackoff<T extends { ok: boolean }>(
  scope: LoginScope,
  identifier: unknown,
  address: unknown,
  attempt: () => Promise<T>,
  now = Date.now()
): Promise<{ locked: true; retryAfterSeconds: number } | { locked: false; result: T }> {
  const keys = loginKeys(scope, identifier, address);
  if (!keys) return { locked: false, result: await attempt() };
  const lockedMs = lockedForMs(keys, now);
  if (lockedMs > 0) return { locked: true, retryAfterSeconds: Math.ceil(lockedMs / 1000) };
  // Counted before the password is checked: attempts that arrive while this
  // one is being checked see it.
  const countedForAccount = countFailure(keys, now);
  let result: T;
  try {
    result = await attempt();
  } catch (error) {
    // The check itself broke; that is not a wrong password.
    pairFailures.undo(keys.pair);
    if (countedForAccount) accountFailures.undo(keys.account);
    throw error;
  }
  if (result.ok) {
    if (countedForAccount) accountFailures.undo(keys.account);
    recordLoginSuccess(scope, identifier, address);
  }
  return { locked: false, result };
}

/** Number of account names with failed logins on record (for tests and metrics). */
export function loginBackoffEntries(): number {
  return accountFailures.size;
}

/** Test hook: clears login backoff state between cases. */
export function resetLoginBackoff(): void {
  pairFailures.clear();
  accountFailures.clear();
  knownAddresses.clear();
}

export function authorizeUpgrade(request: IncomingMessage, now = Date.now()): UpgradeDecision {
  if (!checkRateLimit(clientAddress(request), now)) {
    return { ok: false, code: 429, reason: "Too many connection attempts" };
  }

  // The grant the session will run with: the same choice the connection handler makes.
  const cloudProject = presentedTokens(request)
    .map((provided) => sessionTokens.grant(provided) ?? cloudSessionTokens.grant(provided))
    .find((grant) => grant !== undefined)?.project;
  if (cloudProject) {
    // Max Cloud sessions run on customers' own websites, so the relay's own
    // allowlist does not apply. A token the public embed minted works only
    // from the website that asked for it.
    if (cloudProject.origin && request.headers.origin !== cloudProject.origin) {
      return { ok: false, code: 403, reason: "Origin not allowed" };
    }
  } else if (config.allowedOrigins.length) {
    const origin = request.headers.origin;
    // Native apps (iOS/Android/health checks) send no Origin header; the
    // allowlist guards browsers, where a hostile page could otherwise open
    // the relay cross-site. Token auth covers the no-Origin case.
    if (origin && !config.allowedOrigins.includes(origin)) {
      return { ok: false, code: 403, reason: "Origin not allowed" };
    }
  }

  // The voice line requires credentials once EITHER protection is in place:
  // the shared relay token, or user accounts (site login gate). A logged-in
  // user's session token is as good as the operator secret, so web testers
  // are never handed the shared token. With neither configured the relay
  // stays plug-and-play open, as documented.
  if (config.relayAuthToken || authActive()) {
    // `?token=` (browsers cannot set headers on a WebSocket) or, for native
    // clients that can, `Authorization: Bearer`, which keeps it out of URLs and logs.
    const tokens = presentedTokens(request);
    const accepted = tokens.some(
      (provided) =>
        (config.relayAuthToken ? tokenMatches(provided, config.relayAuthToken) : false) ||
        Boolean(sessionTokens.grant(provided)) ||
        Boolean(cloudSessionTokens.grant(provided)) ||
        Boolean(sessionUser(provided))
    );
    if (!accepted) {
      return { ok: false, code: 401, reason: "Login, relay token or session token required" };
    }
  }

  return { ok: true };
}

/** Account-only access for the phone companion. The operator token is
 * deliberately insufficient because every companion must have a stable
 * account identity for pairing and session revocation. */
export function authorizeAccountUpgrade(request: IncomingMessage, now = Date.now()): AccountUpgradeDecision {
  if (!checkRateLimit(clientAddress(request), now)) {
    return { ok: false, code: 429, reason: "Too many connection attempts" };
  }

  if (config.allowedOrigins.length) {
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      return { ok: false, code: 403, reason: "Origin not allowed" };
    }
  }

  const session = requestSession(request, now);
  if (!session) return { ok: false, code: 401, reason: "Account login required" };
  return { ok: true, ...session };
}
