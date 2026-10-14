// User accounts and login sessions for the testing framework. Deliberately
// dependency-free like the rest of the relay: scrypt password hashing from
// node:crypto, opaque random session tokens, and one JSON file for durability
// (atomic write-then-rename on a serialized queue). The FIRST registered user
// becomes the admin; everyone after that is a tester. With zero users the
// framework behaves exactly like before (open internal mode) — registering is
// what switches authentication on.

import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./runtime-config";
import { createLogger } from "./logger";
import { ensureTestingStorageDirectory } from "./testing-storage";

const scrypt = promisify(scryptCallback) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

type AccountRole = "admin" | "reviewer" | "tester";

export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
  role: AccountRole;
  createdAt: number;
  lastLoginAt: number;
};

type StoredUser = PublicUser & {
  passwordHash: string;
  salt: string;
};

type StoredSession = {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
};

/** Single-use registration invite, so admins can onboard testers while
 *  AUTH_REGISTRATION=off keeps strangers out. */
export type InviteInfo = {
  code: string;
  createdAt: number;
  expiresAt: number;
  createdBy: string;
};

export type AuthResult = { ok: true; token: string; user: PublicUser } | { ok: false; error: string };

type RegistrationOptions = {
  /** Require a valid single-use invite even when AUTH_REGISTRATION is open.
   *  Token-protected HTTP registration uses this when the request did not
   *  present the operator relay token. */
  requireInvite?: boolean;
};

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 60;
const SCRYPT_KEY_LENGTH = 64;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ACCOUNTS_PATH = resolveAccountsPath();
const log = createLogger("accounts");

const INVITE_LIFETIME_MS = 7 * 86_400_000;

const users = new Map<string, StoredUser>(); // keyed by normalized username
const sessions = new Map<string, StoredSession>(); // keyed by token
const invites = new Map<string, InviteInfo>(); // keyed by code
let accountsLoaded = ACCOUNTS_PATH === null;
let accountsLoadFailed = false;
let accountsPersistFailed = false;
let persistQueue: Promise<void> = Promise.resolve();

function resolveAccountsPath(): string | null {
  const configured = process.env.ACCOUNTS_FILE?.trim();
  if (configured?.toLowerCase() === "off") return null;
  if (configured) return configured;
  if (process.env.NODE_ENV === "test") return null;
  return path.join(os.homedir(), ".horizon-helmet-testing", "accounts.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").trim().toLowerCase();
}

function normalizeDisplayName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .normalize("NFKC")
    .split("")
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
  return cleaned || fallback;
}

function publicUser(user: StoredUser): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt
  };
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
  return derived.toString("hex");
}

function hashesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "hex");
  const bufferB = Buffer.from(b, "hex");
  if (bufferA.length !== bufferB.length || bufferA.length === 0) return false;
  return timingSafeEqual(bufferA, bufferB);
}

function loadStoredUser(value: unknown): StoredUser | null {
  if (!isRecord(value)) return null;
  const username = normalizeUsername(value.username);
  if (!USERNAME_PATTERN.test(username)) return null;
  if (typeof value.passwordHash !== "string" || typeof value.salt !== "string") return null;
  if (!value.passwordHash || !value.salt) return null;
  return {
    id: typeof value.id === "string" && ACCOUNT_ID_PATTERN.test(value.id) ? value.id.toLowerCase() : randomUUID(),
    username,
    displayName: normalizeDisplayName(value.displayName, username),
    role: value.role === "admin" || value.role === "reviewer" ? value.role : "tester",
    createdAt: typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : 0,
    lastLoginAt: typeof value.lastLoginAt === "number" && Number.isFinite(value.lastLoginAt) ? value.lastLoginAt : 0,
    passwordHash: value.passwordHash,
    salt: value.salt
  };
}

function loadStoredInvite(value: unknown): InviteInfo | null {
  if (!isRecord(value)) return null;
  if (typeof value.code !== "string" || !value.code.startsWith("inv_")) return null;
  const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : 0;
  const expiresAt = typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? value.expiresAt : 0;
  if (!createdAt || !expiresAt) return null;
  return {
    code: value.code,
    createdAt,
    expiresAt,
    createdBy: typeof value.createdBy === "string" ? value.createdBy : "unknown"
  };
}

function loadStoredSession(value: unknown): StoredSession | null {
  if (!isRecord(value)) return null;
  if (typeof value.token !== "string" || !value.token) return null;
  if (typeof value.userId !== "string" || !value.userId) return null;
  const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : 0;
  const expiresAt = typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? value.expiresAt : 0;
  if (!createdAt || !expiresAt) return null;
  return { token: value.token, userId: value.userId, createdAt, expiresAt };
}

function ensureAccountsLoaded() {
  if (accountsLoaded) return;
  accountsLoaded = true;
  if (!ACCOUNTS_PATH) return;
  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8")) as unknown;
    // Syntactically valid JSON is not automatically a valid account store.
    // Treat a missing/malformed users array as corruption; otherwise `{}` or
    // `[]` would be mistaken for a fresh relay and reopen every auth gate.
    if (!isRecord(raw) || !Array.isArray(raw.users)) throw new Error("accounts store is missing its users array");
    let needsIdMigration = false;
    for (const entry of raw.users) {
      const user = loadStoredUser(entry);
      if (!user) throw new Error("accounts store contains an invalid user record");
      if (users.has(user.username)) throw new Error("accounts store contains duplicate usernames");
      if (!isRecord(entry) || typeof entry.id !== "string" || !ACCOUNT_ID_PATTERN.test(entry.id)) {
        needsIdMigration = true;
      }
      users.set(user.username, user);
    }
    if (Array.isArray(raw.sessions)) {
      const userIds = new Set([...users.values()].map((user) => user.id));
      for (const entry of raw.sessions) {
        const session = loadStoredSession(entry);
        if (session && userIds.has(session.userId)) sessions.set(session.token, session);
      }
    }
    if (Array.isArray(raw.invites)) {
      for (const entry of raw.invites) {
        const invite = loadStoredInvite(entry);
        if (invite) invites.set(invite.code, invite);
      }
    }
    // Older account stores may not carry UUID ids. Generate them once and
    // persist immediately so per-user memory and device caches keep a stable
    // identity across subsequent restarts. Legacy sessions are intentionally
    // dropped because they reference the replaced id and cannot be trusted.
    if (needsIdMigration) persistAccounts();
  } catch (error) {
    // Never retain a partially parsed store. One malformed record after valid
    // entries must not leave an incomplete account/session view in memory.
    users.clear();
    sessions.clear();
    invites.clear();
    // A MISSING file is the normal first run: auth starts from an empty
    // (open) state. Anything else (corrupt JSON, permissions) must not fail
    // open — that would silently expose transcripts and the voice line — so
    // the gates lock (authActive() reports true) until an operator fixes it.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      accountsLoadFailed = true;
      log.error("accounts file unreadable — auth gates locked until fixed", {
        path: ACCOUNTS_PATH,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function persistAccounts() {
  const filePath = ACCOUNTS_PATH;
  if (!filePath) return;
  const snapshot = JSON.stringify(
    { users: [...users.values()], sessions: [...sessions.values()], invites: [...invites.values()] },
    null,
    2
  );
  persistQueue = persistQueue
    .then(async () => {
      // The accounts file holds password hashes and session tokens; create its
      // directory 0o700 (private) via the shared helper instead of a bare mkdir,
      // which inherits a possibly world-listable umask (0o755) on multi-user hosts.
      await ensureTestingStorageDirectory(filePath);
      const tempPath = `${filePath}.write`;
      await fs.promises.writeFile(tempPath, `${snapshot}\n`, { mode: 0o600 });
      await fs.promises.rename(tempPath, filePath);
      accountsPersistFailed = false;
    })
    .catch((error) => {
      // The in-memory state remains authoritative for this process, but a
      // silent write failure would make successful account/admin actions
      // disappear at the next restart. Surface it prominently for operators.
      accountsPersistFailed = true;
      log.error("failed to persist accounts", {
        path: filePath,
        message: error instanceof Error ? error.message : String(error)
      });
    });
}

function pruneExpiredSessions(now: number) {
  let removed = false;
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
      removed = true;
    }
  }
  if (removed) persistAccounts();
}

const MAX_SESSIONS_PER_USER = 20;

function createSession(user: StoredUser, now: number): StoredSession {
  const session: StoredSession = {
    token: `sess_${randomBytes(32).toString("hex")}`,
    userId: user.id,
    createdAt: now,
    expiresAt: now + config.authSessionDays * 86_400_000
  };
  sessions.set(session.token, session);
  // Cap live sessions per user (oldest first) so a login loop can't grow the
  // accounts file with a month-long tail of tokens.
  const mine = [...sessions.values()]
    .filter((candidate) => candidate.userId === user.id)
    .sort((a, b) => a.createdAt - b.createdAt);
  while (mine.length > MAX_SESSIONS_PER_USER) {
    sessions.delete(mine.shift()!.token);
  }
  return session;
}

/** True once at least one user is registered — this is what turns auth on.
 *  Also true when the accounts file exists but could not be read: corruption
 *  fails CLOSED (gates locked) rather than silently reopening everything. */
export function authActive(): boolean {
  ensureAccountsLoaded();
  return users.size > 0 || accountsLoadFailed;
}

/** Readiness signal for the authorization store. A corrupt load already locks
 * all gates; a failed write means successful mutations could vanish on restart. */
export function accountsStorageHealthy(): boolean {
  ensureAccountsLoaded();
  return !accountsLoadFailed && !accountsPersistFailed;
}

export function registrationOpen(): boolean {
  return config.authRegistration;
}

export function userCount(): number {
  ensureAccountsLoaded();
  return users.size;
}

/** Resolves a session token to its (non-expired) user, or null. */
export function sessionUser(token: unknown, now = Date.now()): PublicUser | null {
  if (typeof token !== "string" || !token.startsWith("sess_")) return null;
  ensureAccountsLoaded();
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= now) {
    pruneExpiredSessions(now);
    return null;
  }
  const user = [...users.values()].find((candidate) => candidate.id === session.userId);
  return user ? publicUser(user) : null;
}

function validInvite(codeInput: unknown, now: number): InviteInfo | null {
  if (typeof codeInput !== "string") return null;
  const invite = invites.get(codeInput.trim());
  if (!invite) return null;
  if (invite.expiresAt <= now) {
    invites.delete(invite.code);
    persistAccounts();
    return null;
  }
  return invite;
}

export async function registerUser(
  usernameInput: unknown,
  passwordInput: unknown,
  displayNameInput?: unknown,
  now = Date.now(),
  inviteCodeInput?: unknown,
  options: RegistrationOptions = {}
): Promise<AuthResult> {
  ensureAccountsLoaded();
  // With the stored accounts unreadable, a registration would make a stranger
  // the "first" (admin) user over data that actually exists. Refuse.
  if (accountsLoadFailed) {
    return { ok: false, error: "账号数据无法读取，请管理员检查服务器上的 accounts.json。" };
  }
  const inviteCode = typeof inviteCodeInput === "string" ? inviteCodeInput.trim() : "";
  const invite = inviteCode ? validInvite(inviteCode, now) : null;
  if ((options.requireInvite || !registrationOpen()) && !invite) {
    return {
      ok: false,
      error: inviteCode ? "邀请链接无效或已过期，请向管理员索取新邀请。" : "注册已关闭，请联系管理员。"
    };
  }
  const username = normalizeUsername(usernameInput);
  if (!USERNAME_PATTERN.test(username)) {
    return { ok: false, error: "用户名需为 3–32 位小写字母、数字、_ 或 -。" };
  }
  if (typeof passwordInput !== "string" || passwordInput.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `密码至少 ${MIN_PASSWORD_LENGTH} 位。` };
  }
  if (passwordInput.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: "密码过长。" };
  }
  if (users.has(username)) return { ok: false, error: "用户名已被使用。" };

  const salt = randomBytes(16).toString("hex");
  const user: StoredUser = {
    id: randomUUID(),
    username,
    displayName: normalizeDisplayName(displayNameInput, username),
    // Bootstrap: the first account administers the framework (clears, etc.).
    role: users.size === 0 ? "admin" : "tester",
    createdAt: now,
    lastLoginAt: now,
    passwordHash: await hashPassword(passwordInput, salt),
    salt
  };
  // Re-check EVERYTHING that was validated before the await: a concurrent
  // registration may have taken the username, spent the single-use invite, or
  // an admin may have revoked it while scrypt ran.
  if (users.has(username)) return { ok: false, error: "用户名已被使用。" };
  const inviteAfterHash = inviteCode ? validInvite(inviteCode, now) : null;
  if ((options.requireInvite || !registrationOpen()) && !inviteAfterHash) {
    return { ok: false, error: "邀请链接无效或已过期，请向管理员索取新邀请。" };
  }
  if (user.role === "admin" && users.size > 0) user.role = "tester";
  users.set(username, user);
  // Invites are single-use: consumed by the registration they admitted.
  if (inviteAfterHash) invites.delete(inviteAfterHash.code);
  const session = createSession(user, now);
  pruneExpiredSessions(now);
  persistAccounts();
  return { ok: true, token: session.token, user: publicUser(user) };
}

// --- admin: user + invite management ------------------------------------------

/** Creates a single-use, 7-day registration invite. Admin action. */
export function createInvite(createdBy: string, now = Date.now()): InviteInfo {
  ensureAccountsLoaded();
  const invite: InviteInfo = {
    code: `inv_${randomBytes(16).toString("hex")}`,
    createdAt: now,
    expiresAt: now + INVITE_LIFETIME_MS,
    createdBy
  };
  invites.set(invite.code, invite);
  persistAccounts();
  return invite;
}

/** Withdraws an outstanding invite. Idempotent. */
export function revokeInvite(codeInput: unknown): boolean {
  ensureAccountsLoaded();
  if (typeof codeInput !== "string") return false;
  const removed = invites.delete(codeInput.trim());
  if (removed) persistAccounts();
  return removed;
}

/** Outstanding (non-expired) invites, newest first. */
export function listInvites(now = Date.now()): InviteInfo[] {
  ensureAccountsLoaded();
  let pruned = false;
  for (const [code, invite] of invites) {
    if (invite.expiresAt <= now) {
      invites.delete(code);
      pruned = true;
    }
  }
  if (pruned) persistAccounts();
  return [...invites.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Every registered account (public fields only), oldest first. */
export function listUsers(): PublicUser[] {
  ensureAccountsLoaded();
  return [...users.values()].map(publicUser).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Removes a tester account and all of their sessions. Admin accounts cannot
 * be deleted — that both protects the bootstrap admin and guarantees the
 * relay can never end up auth-enabled with nobody able to administer it.
 */
export function deleteUser(usernameInput: unknown): { ok: true; user: PublicUser } | { ok: false; error: string } {
  ensureAccountsLoaded();
  const username = normalizeUsername(usernameInput);
  const user = users.get(username);
  if (!user) return { ok: false, error: "用户不存在。" };
  if (user.role === "admin") return { ok: false, error: "不能删除管理员账号。" };
  const deletedUser = publicUser(user);
  users.delete(username);
  for (const [token, session] of sessions) {
    if (session.userId === user.id) sessions.delete(token);
  }
  persistAccounts();
  return { ok: true, user: deletedUser };
}

/** Changes QA access without ever leaving the service with zero admins. */
export function setUserRole(
  usernameInput: unknown,
  roleInput: unknown
): { ok: true; user: PublicUser } | { ok: false; error: string } {
  ensureAccountsLoaded();
  const username = normalizeUsername(usernameInput);
  const user = users.get(username);
  if (!user) return { ok: false, error: "用户不存在。" };
  if (roleInput !== "admin" && roleInput !== "reviewer" && roleInput !== "tester") {
    return { ok: false, error: "无效的账号角色。" };
  }
  if (user.role === "admin" && roleInput !== "admin") {
    const adminCount = [...users.values()].filter((candidate) => candidate.role === "admin").length;
    if (adminCount <= 1) return { ok: false, error: "必须至少保留一个管理员账号。" };
  }
  user.role = roleInput;
  persistAccounts();
  return { ok: true, user: publicUser(user) };
}

export async function loginUser(usernameInput: unknown, passwordInput: unknown, now = Date.now()): Promise<AuthResult> {
  ensureAccountsLoaded();
  const username = normalizeUsername(usernameInput);
  const user = users.get(username);
  // Verify against a dummy hash when the user is unknown so the response time
  // doesn't reveal which usernames exist.
  const salt = user?.salt ?? "0".repeat(32);
  const expected = user?.passwordHash ?? "";
  const provided = typeof passwordInput === "string" ? passwordInput : "";
  const hash = await hashPassword(provided.slice(0, MAX_PASSWORD_LENGTH), salt);
  if (!user || !provided || !hashesMatch(hash, expected)) {
    return { ok: false, error: "用户名或密码不正确。" };
  }
  // Hashing yields to password changes and account deletion. A verification
  // against retired credentials must never create a new session after the
  // password-change path has already revoked the old sessions.
  if (users.get(username) !== user || user.salt !== salt || user.passwordHash !== expected) {
    return { ok: false, error: "用户名或密码不正确。" };
  }
  user.lastLoginAt = now;
  const session = createSession(user, now);
  pruneExpiredSessions(now);
  persistAccounts();
  return { ok: true, token: session.token, user: publicUser(user) };
}

/**
 * Self-service password change for the session's own user. Verifies the
 * current password, then revokes every OTHER session — a stolen token dies
 * with the password — while keeping the one that made the change.
 */
export async function changePassword(
  token: unknown,
  currentPassword: unknown,
  newPassword: unknown,
  now = Date.now()
): Promise<{ ok: true } | { ok: false; error: string }> {
  ensureAccountsLoaded();
  if (typeof token !== "string" || !token.startsWith("sess_")) return { ok: false, error: "未登录或会话已过期。" };
  const session = sessions.get(token);
  if (!session || session.expiresAt <= now) return { ok: false, error: "未登录或会话已过期。" };
  const user = [...users.values()].find((candidate) => candidate.id === session.userId);
  if (!user) return { ok: false, error: "未登录或会话已过期。" };

  if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `新密码至少 ${MIN_PASSWORD_LENGTH} 位。` };
  }
  if (newPassword.length > MAX_PASSWORD_LENGTH) return { ok: false, error: "新密码过长。" };

  const provided = typeof currentPassword === "string" ? currentPassword : "";
  const previousSalt = user.salt;
  const previousHash = user.passwordHash;
  const currentHash = await hashPassword(provided.slice(0, MAX_PASSWORD_LENGTH), previousSalt);
  if (!provided || !hashesMatch(currentHash, previousHash)) {
    return { ok: false, error: "当前密码不正确。" };
  }

  const salt = randomBytes(16).toString("hex");
  const passwordHash = await hashPassword(newPassword, salt);
  // Both awaits can overlap logout, another password change, or deletion.
  // Commit only while the same session and verified credentials still exist.
  if (users.get(user.username) !== user || sessions.get(token) !== session) {
    return { ok: false, error: "未登录或会话已过期。" };
  }
  if (user.salt !== previousSalt || user.passwordHash !== previousHash) {
    return { ok: false, error: "密码已修改，请使用当前密码重试。" };
  }
  user.salt = salt;
  user.passwordHash = passwordHash;
  for (const [candidateToken, candidate] of sessions) {
    if (candidate.userId === user.id && candidateToken !== token) sessions.delete(candidateToken);
  }
  persistAccounts();
  return { ok: true };
}

/** Invalidates one session token. Idempotent. */
export function logoutSession(token: unknown): boolean {
  ensureAccountsLoaded();
  if (typeof token !== "string") return false;
  const removed = sessions.delete(token);
  if (removed) persistAccounts();
  return removed;
}

/** Test hook: resolves when every queued accounts write has hit disk. */
export function flushAccounts(): Promise<void> {
  return persistQueue;
}

/** Test hook: clears users, sessions, and invites. */
export function resetAccounts() {
  users.clear();
  sessions.clear();
  invites.clear();
  accountsLoaded = ACCOUNTS_PATH === null;
  accountsLoadFailed = false;
  accountsPersistFailed = false;
  persistQueue = Promise.resolve();
}
