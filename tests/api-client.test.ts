import { afterEach, describe, expect, it, vi } from "vitest";
import { requestJson } from "../src/lib/api-client";
import { adminAccountApi } from "../src/lib/auth";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("requestJson", () => {
  it("honors cancellation by its caller and releases timeout resources", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      (_path: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );
    const request = requestJson("/testing/summary", { signal: controller.signal });
    controller.abort();

    expect(await request).toMatchObject({ ok: false, error: { kind: "unavailable" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports malformed success responses instead of passing null to GUI consumers", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>proxy unavailable</html>", { status: 200 }));

    const result = await adminAccountApi.fetchOverview();
    expect(result).toMatchObject({ ok: false, error: { kind: "server", status: 200 } });
  });

  it("times out stalled requests so GUI actions can recover", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      (_path: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );
    const request = requestJson("/testing/operations");
    const settled = vi.fn();
    void request.then(settled);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toHaveBeenCalledWith({
      ok: false,
      error: { kind: "unavailable", message: "无法连接中继，请稍后重试。" }
    });
  });

  it("keeps the timeout active while the response body is stalled", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async (_path: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    }));
    const request = requestJson("/testing/summary");
    const settled = vi.fn();
    void request.then(settled);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toHaveBeenCalledWith({
      ok: false,
      error: { kind: "unavailable", message: "无法连接中继，请稍后重试。" }
    });
  });

  it("returns typed success data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: 7 })
      })
    );

    await expect(requestJson<{ ok: true; value: number }>("/testing/example")).resolves.toEqual({
      ok: true,
      data: { ok: true, value: 7 }
    });
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not-found"],
    [409, "conflict"],
    [400, "invalid"],
    [500, "server"]
  ] as const)("maps HTTP %s to %s and keeps the server message", async (status, kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        json: async () => ({ ok: false, error: "具体错误" })
      })
    );

    await expect(requestJson("/testing/example")).resolves.toEqual({
      ok: false,
      error: { kind, status, message: "具体错误" }
    });
  });

  it("distinguishes an unavailable relay from an HTTP rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(requestJson("/testing/example")).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable", message: "无法连接中继，请稍后重试。" }
    });
  });
});

describe("admin account API", () => {
  it("preserves the server's invite revocation result", async () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => (key === "max.authToken" ? "sess_admin" : null)
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, removed: false })
      })
    );

    await expect(adminAccountApi.revokeInvite("already-revoked")).resolves.toEqual({
      ok: true,
      data: { removed: false }
    });
  });
});
