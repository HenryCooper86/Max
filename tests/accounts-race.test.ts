import { afterEach, describe, expect, it, vi } from "vitest";

const hashing = vi.hoisted(() => ({ pausePassword: "", release: undefined as (() => void) | undefined }));

vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return {
    ...crypto,
    scrypt(password: string, salt: string, length: number, callback: (error: Error | null, key: Buffer) => void) {
      crypto.scrypt(password, salt, length, (error, key) => {
        if (password === hashing.pausePassword) {
          hashing.pausePassword = "";
          hashing.release = () => callback(error, key);
        } else callback(error, key);
      });
    }
  };
});

import { changePassword, loginUser, logoutSession, registerUser, resetAccounts, sessionUser } from "../server/accounts";

afterEach(() => {
  hashing.release?.();
  hashing.release = undefined;
  hashing.pausePassword = "";
  resetAccounts();
});

async function registered() {
  const result = await registerUser("rider", "original-password");
  if (!result.ok) throw new Error(result.error);
  return result;
}

async function waitForPausedHash() {
  await vi.waitFor(() => expect(hashing.release).toBeTypeOf("function"));
}

function releaseHash() {
  const release = hashing.release!;
  hashing.release = undefined;
  release();
}

describe("account credential mutation races", () => {
  it("rejects an old-password login completing after the password changed", async () => {
    const account = await registered();
    hashing.pausePassword = "original-password";
    const login = loginUser("rider", "original-password");
    await waitForPausedHash();
    expect(await changePassword(account.token, "original-password", "replacement-password")).toEqual({ ok: true });
    releaseHash();
    expect((await login).ok).toBe(false);
    expect((await loginUser("rider", "replacement-password")).ok).toBe(true);
  });

  it("rejects an older password change after another change has committed", async () => {
    const account = await registered();
    hashing.pausePassword = "first-replacement";
    const first = changePassword(account.token, "original-password", "first-replacement");
    await waitForPausedHash();
    expect(await changePassword(account.token, "original-password", "second-replacement")).toEqual({ ok: true });
    releaseHash();
    expect((await first).ok).toBe(false);
    expect((await loginUser("rider", "second-replacement")).ok).toBe(true);
    expect((await loginUser("rider", "first-replacement")).ok).toBe(false);
  });

  it("rejects a password change whose authorizing session was logged out during hashing", async () => {
    const account = await registered();
    hashing.pausePassword = "replacement-password";
    const change = changePassword(account.token, "original-password", "replacement-password");
    await waitForPausedHash();
    expect(logoutSession(account.token)).toBe(true);
    releaseHash();
    expect((await change).ok).toBe(false);
    expect(sessionUser(account.token)).toBeNull();
    expect((await loginUser("rider", "original-password")).ok).toBe(true);
  });
});
