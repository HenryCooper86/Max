import { afterEach, describe, expect, it, vi } from "vitest";
import { authToken, fetchCurrentUser } from "../src/lib/auth";

function stubStorage(initialToken = "sess_valid") {
  const values = new Map<string, string>([["max.authToken", initialToken]]);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }
  });
  return values;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("current-user revalidation", () => {
  it("keeps the stored session when the relay is temporarily unavailable", async () => {
    stubStorage();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(fetchCurrentUser()).resolves.toEqual({ status: "unavailable" });
    expect(authToken()).toBe("sess_valid");
  });

  it("clears the stored session only when the relay explicitly returns 401", async () => {
    stubStorage();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    await expect(fetchCurrentUser()).resolves.toEqual({ status: "unauthenticated" });
    expect(authToken()).toBe("");
  });

  it("returns the authenticated user on a valid session", async () => {
    stubStorage();
    const user = {
      id: "u1",
      username: "rider",
      displayName: "Rider",
      role: "tester" as const,
      createdAt: 1,
      lastLoginAt: 2
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, user }) })
    );

    await expect(fetchCurrentUser()).resolves.toEqual({ status: "authenticated", user });
  });
});
