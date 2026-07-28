import { describe, expect, it, vi } from "vitest";
import { createSynthesizer } from "../server/speech";

function okResponse(pcm: string) {
  return {
    ok: true,
    json: async () => ({ data: Buffer.from(pcm, "utf8").toString("base64") })
  } as unknown as Response;
}

function synth(overrides: Partial<Parameters<typeof createSynthesizer>[0]> = {}) {
  const fetchImpl = vi.fn(async () => okResponse("audio-bytes"));
  const synthesize = createSynthesizer({
    appid: "app",
    token: "tok",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides
  });
  return { synthesize, fetchImpl };
}

describe("createSynthesizer", () => {
  it("returns the decoded pcm", async () => {
    const { synthesize } = synth();
    expect((await synthesize("拍好了。"))?.toString("utf8")).toBe("audio-bytes");
  });

  it("posts the text and the proven request shape", async () => {
    const { synthesize, fetchImpl } = synth();
    await synthesize("拍好了。");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openspeech.bytedance.com/api/v1/tts");
    const body = JSON.parse(String(init.body));
    expect(body.request.text).toBe("拍好了。");
    expect(body.audio).toMatchObject({ encoding: "pcm", rate: 24_000 });
    expect(body.app).toMatchObject({ appid: "app", token: "tok", cluster: "volcano_tts" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer;tok");
  });

  it("synthesises a repeated phrase only once", async () => {
    // The confirmation vocabulary is tiny and fixed, so after first use this
    // takes the network off the common path entirely.
    const { synthesize, fetchImpl } = synth();
    await synthesize("拍好了。");
    await synthesize("拍好了。");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats different text as a different entry", async () => {
    const { synthesize, fetchImpl } = synth();
    await synthesize("拍好了。");
    await synthesize("开始录像。");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry past its bound", async () => {
    const { synthesize, fetchImpl } = synth({ maxEntries: 2 });
    await synthesize("one");
    await synthesize("two");
    await synthesize("three");
    await synthesize("one");
    // "one" was evicted, so it costs a second call — the cache cannot grow
    // without limit if a future caller passes dynamic text.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("returns null without credentials and never calls out", async () => {
    const fetchImpl = vi.fn();
    const synthesize = createSynthesizer({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await synthesize("拍好了。")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when the service rejects", async () => {
    const { synthesize } = synth({
      fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
    });
    expect(await synthesize("拍好了。")).toBeNull();
  });

  it("returns null when the payload has no data field", async () => {
    const { synthesize } = synth({
      fetchImpl: (async () => ({ ok: true, json: async () => ({ code: 3000 }) })) as unknown as typeof fetch
    });
    expect(await synthesize("拍好了。")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const { synthesize } = synth({
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch
    });
    expect(await synthesize("拍好了。")).toBeNull();
  });

  it("does not cache a failure", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return okResponse("audio-bytes");
    });
    const synthesize = createSynthesizer({
      appid: "app",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(await synthesize("拍好了。")).toBeNull();
    expect((await synthesize("拍好了。"))?.toString("utf8")).toBe("audio-bytes");
  });
});
