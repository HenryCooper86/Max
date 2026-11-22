import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Login session tokens authorise /agent, /testing and the admin API. The
// accounts file (and every backup of it) must therefore hold only a digest:
// reading the file must not be enough to take over a live session.

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

let tempDir: string | null = null;

function accountsFile(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-accounts-hash-"));
  const file = path.join(tempDir, "accounts.json");
  vi.stubEnv("ACCOUNTS_FILE", file);
  return file;
}

async function freshAccounts() {
  vi.resetModules();
  return import("../server/accounts");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("session tokens at rest", () => {
  it("never writes a raw session token to the accounts file", async () => {
    const file = accountsFile();
    const accounts = await freshAccounts();
    const registered = await accounts.registerUser("boss", "hunter2-hunter2", "Boss", 1_000);
    const login = await accounts.loginUser("boss", "hunter2-hunter2", 2_000);
    expect(registered.ok && login.ok).toBe(true);
    if (!registered.ok || !login.ok) return;
    await accounts.flushAccounts();

    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain(registered.token);
    expect(raw).not.toContain(login.token);
    expect(raw).not.toMatch(/sess_[0-9a-f]{16}/);
    const stored = JSON.parse(raw) as { sessions: Array<Record<string, unknown>> };
    expect(stored.sessions).toHaveLength(2);
    for (const session of stored.sessions) {
      expect(session).not.toHaveProperty("token");
      expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(stored.sessions.map((session) => session.tokenHash).sort()).toEqual(
      [sha256(registered.token), sha256(login.token)].sort()
    );

    // A restart still recognises the token the client holds.
    const restarted = await freshAccounts();
    expect(restarted.sessionUser(login.token, 3_000)?.username).toBe("boss");
    // The digest itself is not a credential.
    expect(restarted.sessionUser(`sess_${sha256(login.token)}`, 3_000)).toBeNull();
  });

  it("loads an old file with raw tokens, keeps those logins working and rewrites it without them", async () => {
    const file = accountsFile();
    const seed = await freshAccounts();
    const registered = await seed.registerUser("boss", "hunter2-hunter2", "Boss", 1_000);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    await seed.flushAccounts();

    // Rewrite the store the way relays before this change wrote it.
    const legacyToken = registered.token;
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as {
      users: Array<{ id: string }>;
      sessions: Array<{ tokenHash: string; userId: string; createdAt: number; expiresAt: number }>;
    };
    const legacy = {
      ...current,
      sessions: current.sessions.map(({ userId, createdAt, expiresAt }) => ({
        token: legacyToken,
        userId,
        createdAt,
        expiresAt
      }))
    };
    fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
    expect(fs.readFileSync(file, "utf8")).toContain(legacyToken);

    const migrated = await freshAccounts();
    expect(migrated.sessionUser(legacyToken, 2_000)?.username).toBe("boss");
    await migrated.flushAccounts();
    const rewritten = fs.readFileSync(file, "utf8");
    expect(rewritten).not.toContain(legacyToken);
    expect(rewritten).toContain(sha256(legacyToken));

    // Logout, password change and the per-user cap keep working on migrated sessions.
    expect(migrated.logoutSession(legacyToken)).toBe(true);
    expect(migrated.sessionUser(legacyToken, 2_000)).toBeNull();
  });

  it("revokes other sessions on a password change and drops logged-out sessions from disk", async () => {
    const file = accountsFile();
    const accounts = await freshAccounts();
    const registered = await accounts.registerUser("rider", "password123", undefined, 1_000);
    const other = await accounts.loginUser("rider", "password123", 2_000);
    expect(registered.ok && other.ok).toBe(true);
    if (!registered.ok || !other.ok) return;

    expect((await accounts.changePassword(registered.token, "password123", "new-password-1", 2_500)).ok).toBe(true);
    expect(accounts.sessionUser(registered.token, 3_000)?.username).toBe("rider");
    expect(accounts.sessionUser(other.token, 3_000)).toBeNull();

    expect(accounts.logoutSession(registered.token)).toBe(true);
    await accounts.flushAccounts();
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { sessions: unknown[] };
    expect(stored.sessions).toEqual([]);
  });
});
