// A Max Cloud customer's password: changing it, signing out everywhere, and the
// link an operator makes for a customer who cannot log in
// (`npm run cloud:reset-password`).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCloudClock } from "../server/cloud/context";
import {
  changePassword,
  createPasswordReset,
  customerForToken,
  login,
  resetPassword,
  signup,
  verifyCurrentPassword
} from "../server/cloud/customers";
import { hashToken } from "../server/cloud/secrets";
import { deleteCustomerSessions, insertSessionIfPasswordMatches, resetCloudDatabase } from "../server/cloud/store";

const require = createRequire(import.meta.url);
const tsxImport = pathToFileURL(require.resolve("tsx")).href;

const START = Date.UTC(2026, 10, 18, 12, 0, 0);
const PASSWORD = "correct horse battery";
const INVALID_RESET = "This link is not valid: it may have been used or have expired. Ask for a new one.";
const ENV_NAMES = [
  "CLOUD_SECRET_KEY",
  "CLOUD_SIGNUP",
  "STUDIO_DIR",
  "CLOUD_PUBLIC_URL",
  "TELEPHONY_PUBLIC_URL",
  "PORT"
] as const;
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

let clock = START;
let directory = "";
let file = "";

beforeEach(() => {
  process.env.CLOUD_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.CLOUD_SIGNUP = "open";
  // A file, as on a relay: the reset script runs in its own process against the same database.
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-cloud-recovery-"));
  file = path.join(directory, "cloud.sqlite");
  resetCloudDatabase(file);
  clock = START;
  setCloudClock(() => clock);
});

afterEach(() => {
  resetCloudDatabase();
  setCloudClock();
  fs.rmSync(directory, { recursive: true, force: true });
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

async function newCustomer(email = `dev${randomBytes(3).toString("hex")}@example.com`) {
  const result = await signup(email, PASSWORD);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** What a second connection reads from the database file: only what is committed. */
function rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
  const opened = new DatabaseSync(file, { readOnly: true });
  try {
    return opened
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...row }));
  } finally {
    opened.close();
  }
}

/** Runs the operator's script in its own process, where the relay's data lives in `directory`. */
function runScript(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", tsxImport, "scripts/cloud-reset-password.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, STUDIO_DIR: directory, CLOUD_PUBLIC_URL: "", TELEPHONY_PUBLIC_URL: "", ...env },
    encoding: "utf8"
  });
}

describe("a password-reset link", () => {
  it("is stored only as a hash, works once, expires after an hour and is replaced by a newer one", async () => {
    const { token, customer } = await newCustomer();
    const link = createPasswordReset(customer.id);
    const hashed = hashToken(link.token);
    // Only the hash is stored; the same is true of the login sessions.
    expect(rows("SELECT token_hash, customer_id, expires_at FROM password_resets")).toEqual([
      { token_hash: hashed, customer_id: customer.id, expires_at: START + 60 * 60_000 }
    ]);
    expect(hashed).not.toBe(link.token);
    expect(JSON.stringify(rows("SELECT * FROM customer_sessions"))).not.toContain(token);

    // A new password that breaks the rule leaves the link unused.
    expect(await resetPassword(link.token, "short")).toMatchObject({ ok: false, status: 400 });
    expect(rows("SELECT token_hash FROM password_resets")).toEqual([{ token_hash: hashed }]);

    // One use: the link sets the password and disappears; a second use is refused.
    expect(await resetPassword(link.token, "a brand new password")).toEqual({
      ok: true,
      value: { email: customer.email }
    });
    expect(rows("SELECT * FROM password_resets")).toEqual([]);
    expect(await resetPassword(link.token, "yet another password")).toEqual({
      ok: false,
      status: 403,
      error: INVALID_RESET
    });

    // A newer link replaces the earlier one.
    const first = createPasswordReset(customer.id);
    const second = createPasswordReset(customer.id);
    expect(await resetPassword(first.token, "yet another password")).toEqual({
      ok: false,
      status: 403,
      error: INVALID_RESET
    });
    expect(await resetPassword(second.token, "yet another password")).toMatchObject({ ok: true });

    // An expired link is refused the same way.
    const last = createPasswordReset(customer.id);
    clock += 60 * 60_000;
    expect(await resetPassword(last.token, "one final password")).toEqual({
      ok: false,
      status: 403,
      error: INVALID_RESET
    });
  });
});

describe("changing the password", () => {
  it("ends every other session and keeps the one that asked", async () => {
    const { token, customer } = await newCustomer();
    const second = await login(customer.email, PASSWORD);
    const third = await login(customer.email, PASSWORD);
    if (!second.ok || !third.ok) throw new Error("login failed");
    const stranger = await newCustomer();

    expect(await verifyCurrentPassword(token, "wrong password")).toEqual({
      ok: false,
      status: 400,
      error: "The current password is wrong."
    });
    const verified = await verifyCurrentPassword(token, PASSWORD);
    if (!verified.ok) throw new Error("verify failed");
    expect(await changePassword(token, "short", verified.value)).toMatchObject({ ok: false, status: 400 });
    // Refusals change nothing.
    expect(customerForToken(second.value.token)?.id).toBe(customer.id);

    expect(await changePassword(token, "a brand new password", verified.value)).toEqual({
      ok: true,
      value: { ok: true }
    });
    expect(customerForToken(token)?.id).toBe(customer.id);
    expect(customerForToken(second.value.token)).toBeUndefined();
    expect(customerForToken(third.value.token)).toBeUndefined();
    expect(customerForToken(stranger.token)?.id).toBe(stranger.customer.id);
    expect((await login(customer.email, PASSWORD)).ok).toBe(false);
    expect(await login(customer.email, "a brand new password")).toMatchObject({ ok: true });
    expect(await verifyCurrentPassword("mcs_not-a-real-token", PASSWORD)).toMatchObject({
      ok: false,
      status: 401
    });
  });

  it("does not overwrite a password changed while the new one was being hashed", async () => {
    const { token } = await newCustomer();
    const verified = await verifyCurrentPassword(token, PASSWORD);
    if (!verified.ok) throw new Error("verify failed");
    const raceA = changePassword(token, "first new password", verified.value);
    const raceB = changePassword(token, "second new password", verified.value);
    const outcomes = await Promise.all([raceA, raceB]);
    expect(outcomes.map((outcome) => outcome.ok).sort()).toEqual([false, true]);
    expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses a change whose session expired while the new password was being hashed", async () => {
    const { token, customer } = await newCustomer();
    const verified = await verifyCurrentPassword(token, PASSWORD);
    if (!verified.ok) throw new Error("verify failed");
    const pending = changePassword(token, "a brand new password", verified.value);
    clock += 30 * 86_400_000;
    expect(await pending).toMatchObject({ ok: false, status: 401 });
    expect((await login(customer.email, PASSWORD)).ok).toBe(true);
  });

  it("does not apply a reset whose link expired while the new password was being hashed", async () => {
    const { token, customer } = await newCustomer();
    const link = createPasswordReset(customer.id);
    const pending = resetPassword(link.token, "a brand new password");
    clock += 60 * 60_000;
    expect(await pending).toEqual({ ok: false, status: 403, error: INVALID_RESET });
    expect((await login(customer.email, PASSWORD)).ok).toBe(true);
    expect(customerForToken(token)?.id).toBe(customer.id);
  });
});

describe("a login racing a change or reset", () => {
  it("mints a session only while the verified password still stands", async () => {
    const { customer } = await newCustomer();
    const [verified] = rows(
      "SELECT password_hash AS hash, password_salt AS salt FROM customers WHERE id = ?",
      customer.id
    ) as Array<{
      hash: string;
      salt: string;
    }>;
    // A login read the customer and verified the old password, then a reset committed before it inserted its session.
    expect(
      insertSessionIfPasswordMatches(hashToken(`mcs_${"b".repeat(43)}`), customer.id, clock + 60_000, clock, verified)
    ).toBe(true);
    await resetPassword(createPasswordReset(customer.id).token, "a brand new password");
    // The same stale password must no longer mint a session: the late login is refused, and none survives the revoke.
    expect(
      insertSessionIfPasswordMatches(hashToken(`mcs_${"c".repeat(43)}`), customer.id, clock + 60_000, clock, verified)
    ).toBe(false);
    expect(rows("SELECT token_hash FROM customer_sessions")).toEqual([]);
  });
});

describe("a reset link that outlives its purpose", () => {
  it("is killed by a password change and by signing out everywhere", async () => {
    const { token, customer } = await newCustomer();
    const link = createPasswordReset(customer.id);
    const verified = await verifyCurrentPassword(token, PASSWORD);
    if (!verified.ok) throw new Error("verify failed");
    await changePassword(token, "a brand new password", verified.value);
    expect(await resetPassword(link.token, "yet another password")).toEqual({
      ok: false,
      status: 403,
      error: INVALID_RESET
    });

    const second = createPasswordReset(customer.id);
    deleteCustomerSessions(customer.id);
    expect(await resetPassword(second.token, "yet another password")).toEqual({
      ok: false,
      status: 403,
      error: INVALID_RESET
    });
  });
});

describe("the reset script", () => {
  it("prints a link with CLOUD_PUBLIC_URL that works once, and replaces the earlier one", async () => {
    setCloudClock(); // The child process runs on the real clock; pinning is for in-process tests.
    const { token, customer } = await newCustomer();
    const first = runScript([customer.email.toUpperCase()], { CLOUD_PUBLIC_URL: "https://max.example.com/" });
    expect(first.status).toBe(0);
    const link = /^ {2}(https:\/\/max\.example\.com\/console\/reset\?token=mcr_[A-Za-z0-9_-]{43})$/m.exec(first.stdout);
    expect(link).not.toBeNull();
    expect(first.stdout).toContain(`Password reset link for ${customer.email}, for one use until `);
    expect(first.stdout).toContain("The relay sends no email");
    const token1 = link![1].split("token=")[1]!;
    expect(rows("SELECT token_hash FROM password_resets")).toEqual([{ token_hash: hashToken(token1) }]);

    // A second run replaces the first link, which then refuses while the new one works.
    const second = runScript([customer.email], { CLOUD_PUBLIC_URL: "https://max.example.com/" });
    expect(second.status).toBe(0);
    const token2 = /token=(mcr_[A-Za-z0-9_-]{43})/.exec(second.stdout)![1]!;
    expect(await resetPassword(token1, "a brand new password")).toMatchObject({ ok: false, status: 403 });
    expect(await resetPassword(token2, "a brand new password")).toEqual({ ok: true, value: { email: customer.email } });
    expect(customerForToken(token)).toBeUndefined();
  });

  it("uses TELEPHONY_PUBLIC_URL when CLOUD_PUBLIC_URL is unset, and names this machine otherwise", async () => {
    setCloudClock();
    const { customer } = await newCustomer();
    const telephony = runScript([customer.email], { TELEPHONY_PUBLIC_URL: "https://voice.example.com/" });
    expect(telephony.status).toBe(0);
    expect(telephony.stdout).toContain("https://voice.example.com/console/reset?token=mcr_");
    const local = runScript([customer.email], { PORT: "9123" });
    expect(local.status).toBe(0);
    expect(local.stdout).toContain("http://localhost:9123/console/reset?token=mcr_");
    expect(local.stdout).toContain("Neither CLOUD_PUBLIC_URL nor TELEPHONY_PUBLIC_URL is set");
  });

  it("refuses a customer it does not know, a missing database, and no argument", async () => {
    setCloudClock();
    await newCustomer(); // the database must exist for the unknown-email case to reach the lookup
    const unknown = runScript(["nobody@example.com"]);
    expect([unknown.status, unknown.stderr]).toEqual([
      1,
      expect.stringContaining("No Max Cloud customer with the email nobody@example.com.")
    ]);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "max-cloud-recovery-empty-"));
    try {
      const missing = runScript(["nobody@example.com"], { STUDIO_DIR: empty });
      expect([missing.status, missing.stderr]).toEqual([
        1,
        expect.stringContaining("There is no Max Cloud database at")
      ]);
      expect(fs.readdirSync(empty)).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
    const usage = runScript([]);
    expect([usage.status, usage.stderr]).toEqual([
      1,
      expect.stringContaining("Usage: npm run cloud:reset-password -- <customer email>")
    ]);
  });
});
