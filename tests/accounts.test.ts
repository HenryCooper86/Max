import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authActive,
  changePassword,
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
  setUserRole,
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

  it("does not treat an arbitrary invite string as authorization on a protected registration route", async () => {
    // The HTTP route sets requireInvite when RELAY_AUTH_TOKEN is configured
    // but the request did not present it. Previously, merely making
    // inviteCode a string (including "fake") passed the route guard and open
    // registration admitted the account anyway.
    config.authRegistration = true;
    const forged = await registerUser("intruder", "password123", undefined, 1_000, "fake", {
      requireInvite: true
    });
    expect(forged).toMatchObject({ ok: false, error: expect.stringContaining("邀请") });
    expect(userCount()).toBe(0);

    const bootstrap = await registerUser("boss", "hunter2-hunter2", undefined, 2_000);
    expect(bootstrap.ok).toBe(true);
    const invite = createInvite("boss", 2_500);
    const invited = await registerUser("rider", "password123", undefined, 3_000, invite.code, {
      requireInvite: true
    });
    expect(invited.ok).toBe(true);
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
  it("supports reviewer roles while protecting the last administrator", async () => {
    await registerUser("boss", "hunter2-hunter2", undefined, 1_000);
    await registerUser("reviewer", "password123", undefined, 2_000);
    expect(setUserRole("reviewer", "reviewer")).toMatchObject({ ok: true, user: { role: "reviewer" } });
    expect(setUserRole("boss", "tester")).toMatchObject({ ok: false, error: expect.stringContaining("管理员") });

    await registerUser("backup-admin", "password123", undefined, 3_000);
    expect(setUserRole("backup-admin", "admin").ok).toBe(true);
    expect(setUserRole("boss", "reviewer")).toMatchObject({ ok: true, user: { role: "reviewer" } });
  });

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

describe("hardening regressions", () => {
  it("a single-use invite admits exactly ONE of two concurrent registrations", async () => {
    await registerUser("boss", "hunter2-hunter2", undefined, 1_000);
    config.authRegistration = false;
    const invite = createInvite("boss", 1_500);

    // Both requests validate the invite before the scrypt await — only one
    // may survive the post-hash re-check.
    const [first, second] = await Promise.all([
      registerUser("rider-one", "password123", undefined, 2_000, invite.code),
      registerUser("rider-two", "password123", undefined, 2_001, invite.code)
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(userCount()).toBe(2); // boss + exactly one invitee
  });

  it("a revoked invite cannot admit a registration already past validation", async () => {
    await registerUser("boss", "hunter2-hunter2", undefined, 1_000);
    config.authRegistration = false;
    const invite = createInvite("boss", 1_500);

    const [attempt] = await Promise.all([
      registerUser("rider", "password123", undefined, 2_000, invite.code),
      Promise.resolve(revokeInvite(invite.code)) // races the scrypt hash
    ]);
    expect(attempt.ok).toBe(false);
  });

  it("login racing an admin deletion fails instead of minting a dead token", async () => {
    await registerUser("boss", "hunter2-hunter2", undefined, 1_000);
    await registerUser("rider", "password123", undefined, 2_000);

    const loginPromise = loginUser("rider", "password123", 3_000);
    expect(deleteUser("rider").ok).toBe(true); // lands mid-hash
    const result = await loginPromise;
    expect(result.ok).toBe(false);
  });

  it("caps live sessions per user at 20, dropping the oldest", async () => {
    const registered = await registerUser("rider", "password123", undefined, 1_000);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    let latest = "";
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const login = await loginUser("rider", "password123", 2_000 + attempt);
      expect(login.ok).toBe(true);
      if (login.ok) latest = login.token;
    }
    // Newest still valid; the registration session (oldest) was evicted.
    expect(sessionUser(latest, 3_000)?.username).toBe("rider");
    expect(sessionUser(registered.token, 3_000)).toBeNull();
  });

  it("changes the password, revoking every other session but keeping the caller's", async () => {
    const registered = await registerUser("rider", "password123", undefined, 1_000);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const other = await loginUser("rider", "password123", 2_000);
    expect(other.ok).toBe(true);
    if (!other.ok) return;

    expect((await changePassword(registered.token, "wrong-password", "new-password-1", 2_500)).ok).toBe(false);
    expect((await changePassword(registered.token, "password123", "short", 2_600)).ok).toBe(false);
    expect((await changePassword(registered.token, "password123", "new-password-1", 2_700)).ok).toBe(true);

    // Caller's session survives; the other one died with the old password.
    expect(sessionUser(registered.token, 3_000)?.username).toBe("rider");
    expect(sessionUser(other.token, 3_000)).toBeNull();
    expect((await loginUser("rider", "password123", 4_000)).ok).toBe(false);
    expect((await loginUser("rider", "new-password-1", 5_000)).ok).toBe(true);
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

  it("fails CLOSED when the accounts file exists but is corrupt", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-accounts-"));
    const file = path.join(tempDir, "accounts.json");
    fs.writeFileSync(file, "{ this is not json");
    vi.stubEnv("ACCOUNTS_FILE", file);

    vi.resetModules();
    const accounts = await import("../server/accounts");
    // Gates lock (corruption must not silently reopen transcripts/voice)…
    expect(accounts.authActive()).toBe(true);
    // …and a stranger can't become the "first" admin over the broken state.
    const attempt = await accounts.registerUser("intruder", "password123");
    expect(attempt.ok).toBe(false);
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
