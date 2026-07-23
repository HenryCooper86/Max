import { afterEach, describe, expect, it, vi } from "vitest";
import { requestJson } from "../src/lib/api-client";

afterEach(() => vi.unstubAllGlobals());

describe("requestJson", () => {
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
