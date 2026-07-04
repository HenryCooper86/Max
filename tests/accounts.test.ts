import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authActive,
  createInvite,
  deleteUser,
  listInvites,
  listUsers,
  loginUser,
  logoutSession,
  registerUser,
  resetAccounts,
  revokeInvite,
  sessionUser,
  userCount
} from "../server/accounts";
import { config } from "../server/config";

const DAY_MS = 86_400_000;

const originalRegistration = config.authRegistration;

afterEach(() => {
  resetAccounts();
  config.authRegistration = originalRegistration;
});

describe("user accounts", () => {
  it("registers the first user as admin and later users as testers", async () => {
    expect(authActive()).toBe(false);

    const first = await registerUser("Boss", "hunter2-hunter2", " QA Lead ", 1_000);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.user).toMatchObject({ username: "boss", displayName: "QA Lead", role: "admin" });
    expect(first.token.startsWith("sess_")).toBe(true);

    const second = await registerUser("rider-one", "password123", undefined, 2_000);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.user).toMatchObject({ username: "rider-one", displayName: "rider-one", role: "tester" });

    expect(authActive()).toBe(true);
    expect(userCount()).toBe(2);
  });

  it("rejects invalid usernames, short passwords, and duplicates", async () => {
    expect((await registerUser("ab", "password123")).ok).toBe(false); // too short
    expect((await registerUser("bad name!", "password123")).ok).toBe(false); // invalid chars
    expect((await registerUser("rider", "short")).ok).toBe(false); // weak password

    expect((await registerUser("rider", "password123")).ok).toBe(true);
    const duplicate = await registerUser("RIDER", "password456"); // case-folded duplicate
    expect(duplicate).toMatchObject({ ok: false, error: expect.stringContaining("已被使用") });
  });

  it("logs in with the right password and rejects the wrong one uniformly", async () => {
    await registerUser("rider", "password123");

    const good = await loginUser("Rider", "password123", 5_000);
    expect(good.ok).toBe(true);

    const badPassword = await loginUser("rider", "wrong-password");
    const badUser = await loginUser("nobody", "password123");
    expect(badPassword.ok).toBe(false);
    expect(badUser.ok).toBe(false);
    if (badPassword.ok || badUser.ok) return;
    // Same message for both, so responses don't reveal which usernames exist.
    expect(badPassword.error).toBe(badUser.error);
  });

  it("resolves, expires, and revokes session tokens", async () => {
    const registered = await registerUser("rider", "password123", undefined, 1_000);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    expect(sessionUser(registered.token, 2_000)?.username).toBe("rider");
    expect(sessionUser("sess_forged", 2_000)).toBeNull();
    expect(sessionUser(registered.token, 1_000 + config.authSessionDays * DAY_MS + 1)).toBeNull();

    const login = await loginUser("rider", "password123", 3_000);
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(logoutSession(login.token)).toBe(true);
    expect(sessionUser(login.token, 4_000)).toBeNull();
    expect(logoutSession(login.token)).toBe(false); // idempotent
  });
});

describe("invites and admin user management", () => {
  it("admits a registration through a single-use invite while registration is closed", async () => {
    await registerUser("boss", "hunter2-hunter2", undefined, 1_000);
    config.authRegistration = false;

    // Closed: plain registration refused.
    expect((await registerUser("rider", "password123", undefined, 2_000)).ok).toBe(false);

    const invite = createInvite("boss", 2_000);
    expect(listInvites(2_500).map((item) => item.code)).toEqual([invite.code]);

    const invited = await registerUser("rider", "password123", undefined, 3_000, invite.code);
    expect(invited.ok).toBe(true);
    if (!invited.ok) return;
    expect(invited.user.role).toBe("tester");

    // Single-use: the same code no longer works, and the list is empty.
    expect(listInvites(3_500)).toEqual([]);
    const reused = await registerUser("rider-two", "password123", undefined, 4_000, invite.code);
    expect(reused).toMatchObject({ ok: false, error: expect.stringContaining("邀请") });
  });

  it("expires and revokes invites", async () => {
    await registerUser("boss", "hunter2-hunter2", undefined, 1_000);
    config.authRegistration = false;

    const expiring = createInvite("boss", 1_000);
    const eightDaysLater = 1_000 + 8 * DAY_MS;
    expect((await registerUser("late", "password123", undefined, eightDaysLater, expiring.code)).ok).toBe(false);
    expect(listInvites(eightDaysLater)).toEqual([]);

    const revoked = createInvite("boss", 2_000);
    expect(revokeInvite(revoked.code)).toBe(true);
    expect((await registerUser("nope", "password123", undefined, 3_000, revoked.code)).ok).toBe(false);
  });

  it("deletes testers (with their sessions) but never admins", async () => {
    await registerUser("boss", "hunter2-hunter2", undefined, 1_000);
    const tester = await registerUser("rider", "password123", undefined, 2_000);
    expect(tester.ok).toBe(true);
    if (!tester.ok) return;

    expect(deleteUser("boss")).toMatchObject({ ok: false, error: expect.stringContaining("管理员") });
    expect(deleteUser("ghost").ok).toBe(false);

    expect(deleteUser("rider")).toEqual({ ok: true });
    expect(listUsers().map((user) => user.username)).toEqual(["boss"]);
    // The deleted tester's session died with the account.
    expect(sessionUser(tester.token, 3_000)).toBeNull();
  });
});

describe("accounts persistence", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("persists users and sessions across a relay restart", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-accounts-"));
    const file = path.join(tempDir, "accounts.json");
    vi.stubEnv("ACCOUNTS_FILE", file);

    vi.resetModules();
    const first = await import("../server/accounts");
    const registered = await first.registerUser("boss", "hunter2-hunter2", "QA Lead", 1_000);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    await first.flushAccounts();

    // "Restart": a fresh module instance loading the same file.
    vi.resetModules();
    const second = await import("../server/accounts");
    expect(second.authActive()).toBe(true);
    expect(second.sessionUser(registered.token, 2_000)?.username).toBe("boss");
    const login = await second.loginUser("boss", "hunter2-hunter2", 3_000);
    expect(login.ok).toBe(true);
  });
});
