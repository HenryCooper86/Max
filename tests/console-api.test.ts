import { describe, expect, it } from "vitest";
import { ApiError, createCloudApi, type FetchLike } from "../src/console/api";
import { formatMinutes, formatYuan, wholeMinutes } from "../src/console/format";
import { shouldKeepPolling, toMillis } from "../src/console/poll";
import { CONSOLE_PATH, resolveRoute } from "../src/lib/routes";

type Call = { url: string; init?: RequestInit };

function fake(status: number, body: unknown): { fetcher: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetcher, calls };
}

const headerOf = (call: Call, name: string) => (call.init?.headers as Record<string, string> | undefined)?.[name];

describe("console routes", () => {
  it("maps /console and below to the console surface", () => {
    expect(CONSOLE_PATH).toBe("/console");
    expect(resolveRoute({ pathname: "/console", hash: "" })).toEqual({ surface: "console" });
    expect(resolveRoute({ pathname: "/console/", hash: "" })).toEqual({ surface: "console" });
    expect(resolveRoute({ pathname: "/console/x", hash: "#usage" })).toEqual({ surface: "console" });
    expect(resolveRoute({ pathname: "/consoles", hash: "" })).toEqual({ surface: "landing" });
  });
});

describe("formatting", () => {
  it("formats fen as yuan", () => {
    expect(formatYuan(5000)).toBe("¥50.00");
    expect(formatYuan(0)).toBe("¥0.00");
    expect(formatYuan(5)).toBe("¥0.05");
    expect(formatYuan(100000)).toBe("¥1,000.00");
    expect(formatYuan(-4)).toBe("-¥0.04");
  });

  it("formats minutes", () => {
    expect(wholeMinutes(60_000)).toBe(1000);
    expect(wholeMinutes(-5)).toBe(0);
    expect(formatMinutes(1.5)).toBe("1.5");
    expect(formatMinutes(3)).toBe("3");
  });
});

describe("top-up polling", () => {
  it("stops on paid, closed and past expiry", () => {
    expect(shouldKeepPolling("pending", 10_000, 5_000)).toBe(true);
    expect(shouldKeepPolling(undefined, 10_000, 5_000)).toBe(true);
    expect(shouldKeepPolling("paid", 10_000, 5_000)).toBe(false);
    expect(shouldKeepPolling("closed", 10_000, 5_000)).toBe(false);
    expect(shouldKeepPolling("pending", 10_000, 10_000)).toBe(false);
  });

  it("reads second timestamps as milliseconds", () => {
    expect(toMillis(1_800_000_000)).toBe(1_800_000_000_000);
    expect(toMillis(1_800_000_000_000)).toBe(1_800_000_000_000);
  });
});

describe("cloud api client", () => {
  it("signs up without a token", async () => {
    const { fetcher, calls } = fake(201, { token: "mcs_1", customer: { id: "c", email: "a@b.c", createdAt: 1 } });
    const result = await createCloudApi(fetcher).signup("a@b.c", "longenough1");
    expect(result.token).toBe("mcs_1");
    expect(calls[0].url).toBe("/cloud/api/signup");
    expect(calls[0].init?.method).toBe("POST");
    expect(headerOf(calls[0], "authorization")).toBeUndefined();
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ email: "a@b.c", password: "longenough1" });
  });

  it("sends the bearer token with the right path and method for each call", async () => {
    const { fetcher, calls } = fake(200, {});
    const api = createCloudApi(fetcher);
    await api.me("mcs_t");
    await api.updateProject("mcs_t", "p 1", { modelKey: "" });
    await api.rotateKey("mcs_t", "p1");
    await api.deleteProject("mcs_t", "p1");
    await api.usage("mcs_t", "2026-11");
    await api.createTopup("mcs_t", "cny50", "wechat");
    await api.topupStatus("mcs_t", "o1");
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      "GET /cloud/api/me",
      "PATCH /cloud/api/projects/p%201",
      "POST /cloud/api/projects/p1/rotate-key",
      "DELETE /cloud/api/projects/p1",
      "GET /cloud/api/usage?month=2026-11",
      "POST /cloud/api/topups",
      "GET /cloud/api/topups/o1"
    ]);
    for (const call of calls) expect(headerOf(call, "authorization")).toBe("Bearer mcs_t");
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ modelKey: "" });
    expect(JSON.parse(String(calls[5].init?.body))).toEqual({ pack: "cny50", provider: "wechat" });
  });

  it("asks for a project's usage per user with the month and the console's page size", async () => {
    const { fetcher, calls } = fake(200, {});
    await createCloudApi(fetcher).projectUsage("mcs_t", "p 1", "2026-11");
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      "GET /cloud/api/projects/p%201/usage?month=2026-11&limit=50"
    ]);
    expect(headerOf(calls[0]!, "authorization")).toBe("Bearer mcs_t");
  });

  it("changes the password, signs out everywhere and sets a password with a reset link", async () => {
    const { fetcher, calls } = fake(200, { ok: true, email: "a@b.c" });
    const api = createCloudApi(fetcher);
    await api.changePassword("mcs_t", "old password", "new password");
    await api.logoutEverywhere("mcs_t");
    await api.resetPassword("mcr_link", "new password");
    expect(calls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
      "POST /cloud/api/password",
      "POST /cloud/api/logout-everywhere",
      "POST /cloud/api/reset-password"
    ]);
    expect(headerOf(calls[0], "authorization")).toBe("Bearer mcs_t");
    expect(headerOf(calls[1], "authorization")).toBe("Bearer mcs_t");
    // A reset link is not a session: it goes in the body, and that call is anonymous.
    expect(headerOf(calls[2], "authorization")).toBeUndefined();
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      currentPassword: "old password",
      newPassword: "new password"
    });
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ token: "mcr_link", newPassword: "new password" });
  });

  it("maps 401, 503, other errors and network failures", async () => {
    const unauthorized = await createCloudApi(fake(401, { ok: false, error: "Sign in again" }).fetcher)
      .me("x")
      .catch((e: unknown) => e);
    expect(unauthorized).toBeInstanceOf(ApiError);
    expect(unauthorized).toMatchObject({ kind: "unauthorized", status: 401, message: "Sign in again" });

    const off = await createCloudApi(fake(503, { ok: false, error: "Max Cloud is not configured" }).fetcher)
      .packs(null)
      .catch((e: unknown) => e);
    expect(off).toMatchObject({ kind: "unavailable", status: 503 });

    const bad = await createCloudApi(fake(409, { ok: false, error: "Email already in use" }).fetcher)
      .signup("a", "b")
      .catch((e: unknown) => e);
    expect(bad).toMatchObject({ kind: "request", status: 409, message: "Email already in use" });

    const down = await createCloudApi(async () => {
      throw new TypeError("offline");
    })
      .me("x")
      .catch((e: unknown) => e);
    expect(down).toMatchObject({ kind: "network" });
  });
});
