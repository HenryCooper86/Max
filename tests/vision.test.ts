import { describe, expect, it, vi } from "vitest";
import { createDescriber, VISION_ENDPOINT } from "../server/vision";

function reply(text: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: text } }] })
  } as unknown as Response;
}

function describer(overrides: Partial<Parameters<typeof createDescriber>[0]> = {}) {
  const fetchImpl = vi.fn(async () => reply("前面是一条空路。"));
  const describe_ = createDescriber({
    apiKey: "key",
    model: "vision-model",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides
  });
  return { describe: describe_, fetchImpl };
}

describe("createDescriber", () => {
  it("returns the description", async () => {
    const { describe: run } = describer();
    expect(await run("AAAA")).toBe("前面是一条空路。");
  });

  it("sends the image as a data url and asks in Chinese", async () => {
    const { describe: run, fetchImpl } = describer();
    await run("AAAA");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // The default endpoint — ARK_BASE_URL + "/chat/completions" as measured in
    // Task 1's report — is used whenever a caller does not override it (as
    // server/providers/doubao.ts does when ARK_BASE_URL is configured).
    expect(url).toBe(VISION_ENDPOINT);
    const body = JSON.parse(String(init.body));
    const parts = body.messages[0].content;
    expect(parts.find((p: { type: string }) => p.type === "image_url").image_url.url).toBe(
      "data:image/jpeg;base64,AAAA"
    );
    expect(parts.find((p: { type: string }) => p.type === "text").text).toMatch(/描述/);
  });

  it("returns null without a key and never calls out", async () => {
    const fetchImpl = vi.fn();
    const run = createDescriber({ model: "m", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await run("AAAA")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when the service rejects", async () => {
    const { describe: run } = describer({
      fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
    });
    expect(await run("AAAA")).toBeNull();
  });

  it("returns null when the payload has no text", async () => {
    const { describe: run } = describer({
      fetchImpl: (async () => ({ ok: true, json: async () => ({ choices: [] }) })) as unknown as typeof fetch
    });
    expect(await run("AAAA")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const { describe: run } = describer({
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch
    });
    expect(await run("AAAA")).toBeNull();
  });

  it("reports a reason on each failure", async () => {
    const reasons: string[] = [];
    const { describe: run } = describer({
      onFailure: (reason) => reasons.push(reason),
      fetchImpl: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch
    });
    await run("AAAA");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("401");
  });

  it("never caches — every look is a new scene", async () => {
    const { describe: run, fetchImpl } = describer();
    await run("AAAA");
    await run("AAAA");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
