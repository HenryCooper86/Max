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
import { config } from "./config";

const scrypt = promisify(scryptCallback) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

export type AccountRole = "admin" | "tester";

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

export type AuthResult = { ok: true; token: string; user: PublicUser } | { ok: false; error: string };

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 60;
const SCRYPT_KEY_LENGTH = 64;

const ACCOUNTS_PATH = resolveAccountsPath();

const users = new Map<string, StoredUser>(); // keyed by normalized username
const sessions = new Map<string, StoredSession>(); // keyed by token
let accountsLoaded = ACCOUNTS_PATH === null;
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

export function normalizeUsername(value: unknown): string {
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
    id: typeof value.id === "string" && value.id ? value.id : randomUUID(),
    username,
    displayName: normalizeDisplayName(value.displayName, username),
    role: value.role === "admin" ? "admin" : "tester",
    createdAt: typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : 0,
    lastLoginAt: typeof value.lastLoginAt === "number" && Number.isFinite(value.lastLoginAt) ? value.lastLoginAt : 0,
    passwordHash: value.passwordHash,
    salt: value.salt
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
    if (!isRecord(raw)) return;
    if (Array.isArray(raw.users)) {
      for (const entry of raw.users) {
        const user = loadStoredUser(entry);
        if (user) users.set(user.username, user);
      }
    }
    if (Array.isArray(raw.sessions)) {
      const userIds = new Set([...users.values()].map((user) => user.id));
      for (const entry of raw.sessions) {
        const session = loadStoredSession(entry);
        if (session && userIds.has(session.userId)) sessions.set(session.token, session);
      }
    }
  } catch {
    // Missing or unreadable accounts file must not take the relay down; auth
    // simply starts from an empty (open) state.
  }
}

function persistAccounts() {
  const filePath = ACCOUNTS_PATH;
  if (!filePath) return;
  const snapshot = JSON.stringify({ users: [...users.values()], sessions: [...sessions.values()] }, null, 2);
  persistQueue = persistQueue
    .then(async () => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.write`;
      await fs.promises.writeFile(tempPath, `${snapshot}\n`, { mode: 0o600 });
      await fs.promises.rename(tempPath, filePath);
    })
    .catch(() => {
      // Best-effort durability; the in-memory state stays authoritative.
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

function createSession(user: StoredUser, now: number): StoredSession {
  const session: StoredSession = {
    token: `sess_${randomBytes(32).toString("hex")}`,
    userId: user.id,
    createdAt: now,
    expiresAt: now + config.authSessionDays * 86_400_000
  };
  sessions.set(session.token, session);
  return session;
}

/** True once at least one user is registered — this is what turns auth on. */
export function authActive(): boolean {
  ensureAccountsLoaded();
  return users.size > 0;
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

export async function registerUser(
  usernameInput: unknown,
  passwordInput: unknown,
  displayNameInput?: unknown,
  now = Date.now()
): Promise<AuthResult> {
  ensureAccountsLoaded();
  if (!registrationOpen()) return { ok: false, error: "注册已关闭，请联系管理员。" };
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
  // Re-check after the await: two concurrent registrations of the same name
  // must not both insert.
  if (users.has(username)) return { ok: false, error: "用户名已被使用。" };
  if (user.role === "admin" && users.size > 0) user.role = "tester";
  users.set(username, user);
  const session = createSession(user, now);
  pruneExpiredSessions(now);
  persistAccounts();
  return { ok: true, token: session.token, user: publicUser(user) };
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
  user.lastLoginAt = now;
  const session = createSession(user, now);
  pruneExpiredSessions(now);
  persistAccounts();
  return { ok: true, token: session.token, user: publicUser(user) };
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

/** Test hook: clears users and sessions. */
export function resetAccounts() {
  users.clear();
  sessions.clear();
  accountsLoaded = ACCOUNTS_PATH === null;
}
