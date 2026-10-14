import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authToken,
  fetchCurrentUser,
  fetchUserMemorySummary,
  forgetUserMemory,
  loginAccount,
  logoutAccount
} from "../src/lib/auth";

function stubStorage(initialToken = "sess_valid") {
  const values = new Map<string, string>([["max.authToken", initialToken]]);
  vi.stubGlobal("window", {
    location: { search: "" },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }
  });
  return values;
}

afterEach(async () => {
  // Leave page-local fallback state through the same logout path as the GUI.
  vi.stubGlobal("window", { localStorage: { getItem: () => null, removeItem: () => {} } });
  await logoutAccount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("current-user revalidation", () => {
  it("keeps the login locked when the relay returns an incomplete account", async () => {
    stubStorage();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, user: { id: "u1" } })));

    await expect(fetchCurrentUser()).resolves.toEqual({ status: "unavailable" });
    expect(authToken()).toBe("sess_valid");
  });

  it("does not clear a newer login when an older session poll returns 401", async () => {
    const storage = stubStorage("sess_old");
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        })
    );
    const request = fetchCurrentUser();
    storage.set("max.authToken", "sess_new");
    resolve(new Response(JSON.stringify({ ok: false, error: "expired" }), { status: 401 }));

    await expect(request).resolves.toEqual({ status: "unavailable" });
    expect(authToken()).toBe("sess_new");
  });

  it("does not restore an old account after a newer login", async () => {
    const storage = stubStorage("sess_old");
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        })
    );
    const request = fetchCurrentUser();
    storage.set("max.authToken", "sess_new");
    resolve(
      new Response(
        JSON.stringify({
          ok: true,
          user: {
            id: "old-user",
            username: "old-rider",
            displayName: "Old rider",
            role: "tester",
            createdAt: 1,
            lastLoginAt: 2
          }
        }),
        { status: 200 }
      )
    );

    await expect(request).resolves.toEqual({ status: "unavailable" });
    expect(authToken()).toBe("sess_new");
  });

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

describe("storage-unavailable login", () => {
  it("does not unlock the GUI or replace a login with an incomplete success payload", async () => {
    stubStorage();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, user: { id: "u1" } })));

    expect((await loginAccount("rider", "password")).ok).toBe(false);
    expect(authToken()).toBe("sess_valid");
  });

  it("keeps the credential for this page and clears it on logout", async () => {
    vi.stubGlobal("window", {
      location: { search: "" },
      localStorage: {
        getItem: () => {
          throw new Error("Storage disabled");
        },
        setItem: () => {
          throw new Error("Storage disabled");
        },
        removeItem: () => {
          throw new Error("Storage disabled");
        }
      }
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            token: "sess_private",
            user: { id: "rider", username: "rider", displayName: "Rider", role: "tester", createdAt: 1, lastLoginAt: 2 }
          })
        )
    );
    try {
      expect((await loginAccount("rider", "password")).ok).toBe(true);
      expect(authToken()).toBe("sess_private");
    } finally {
      await logoutAccount();
    }
    expect(authToken()).toBe("");
  });
});

describe("user memory controls", () => {
  it("fetches metadata without exposing raw history and clears with the login token", async () => {
    stubStorage();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, memory: { enabled: true, updatedAt: 10, turnCount: 4, factCount: 1 } })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, removed: true }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUserMemorySummary()).resolves.toEqual({
      enabled: true,
      updatedAt: 10,
      turnCount: 4,
      factCount: 1
    });
    await expect(forgetUserMemory()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/auth/memory", {
      signal: expect.any(AbortSignal),
      headers: { Authorization: "Bearer sess_valid" }
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/auth/memory", {
      signal: expect.any(AbortSignal),
      method: "DELETE",
      headers: { Authorization: "Bearer sess_valid" }
    });
  });
});
