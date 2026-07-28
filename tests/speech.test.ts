import { describe, expect, it, vi } from "vitest";
import { createSpeaker, createSynthesizer, TTS_ENDPOINT, TTS_RATE } from "../server/speech";

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
    expect(url).toBe(TTS_ENDPOINT);
    const body = JSON.parse(String(init.body));
    expect(body.request.text).toBe("拍好了。");
    expect(body.audio).toMatchObject({ encoding: "pcm", rate: TTS_RATE });
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

  it("calls onFailure when the service rejects the request", async () => {
    // A wrong appid/token must be distinguishable in the logs from the
    // missing-credentials (configured-off) state — both return null to the
    // caller identically, so onFailure is the only signal.
    const onFailure = vi.fn();
    const { synthesize } = synth({
      fetchImpl: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch,
      onFailure
    });
    expect(await synthesize("拍好了。")).toBeNull();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toEqual(expect.any(String));
  });

  it("calls onFailure when fetch throws", async () => {
    const onFailure = vi.fn();
    const { synthesize } = synth({
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      onFailure
    });
    expect(await synthesize("拍好了。")).toBeNull();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("does not call onFailure repeatedly when credentials are absent", async () => {
    // Missing credentials is the documented configured-off state, not a
    // failure. Every call would otherwise hit this branch, and logging it on
    // every confirmation would drown out a real failure.
    const onFailure = vi.fn();
    const fetchImpl = vi.fn();
    const synthesize = createSynthesizer({ fetchImpl: fetchImpl as unknown as typeof fetch, onFailure });
    await synthesize("拍好了。");
    await synthesize("拍好了。");
    await synthesize("开始录像。");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function speaker(overrides: Partial<Parameters<typeof createSpeaker>[0]> = {}) {
  const sent: Buffer[] = [];
  const made = createSpeaker({
    synthesize: async () => Buffer.from("pcm"),
    sendAudio: (pcm) => sent.push(pcm),
    platform: () => "embedded",
    ...overrides
  });
  return { speak: made.speak, sent };
}

describe("createSpeaker", () => {
  it("sends audio to an embedded client", async () => {
    const { speak, sent } = speaker();
    await speak("拍好了。");
    expect(sent.map((b) => b.toString("utf8"))).toEqual(["pcm"]);
  });

  it("sends nothing to a web client", async () => {
    // Web and mobile speak the transcript themselves via useBrowserSpeech.
    // Sending audio too would say every confirmation twice.
    const { speak, sent } = speaker({ platform: () => "web" });
    await speak("拍好了。");
    expect(sent).toEqual([]);
  });

  it("sends nothing when the platform is not yet known", async () => {
    const { speak, sent } = speaker({ platform: () => undefined });
    await speak("拍好了。");
    expect(sent).toEqual([]);
  });

  it("does not synthesise at all for a web client", async () => {
    // No point paying for audio nobody will play.
    const synthesize = vi.fn(async () => Buffer.from("pcm"));
    const { speak } = speaker({ platform: () => "web", synthesize });
    await speak("拍好了。");
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("stays silent when synthesis fails", async () => {
    const { speak, sent } = speaker({ synthesize: async () => null });
    await speak("拍好了。");
    expect(sent).toEqual([]);
  });

  it("never throws when synthesis rejects", async () => {
    // This sits on the device-confirmation path. An exception here would take
    // out the reconciliation that tells the rider the truth.
    const errors: unknown[] = [];
    const { speak, sent } = speaker({
      synthesize: async () => {
        throw new Error("boom");
      },
      onError: (error) => errors.push(error)
    });
    await expect(speak("拍好了。")).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("never throws when the send fails", async () => {
    const { speak } = speaker({
      sendAudio: () => {
        throw new Error("socket closed");
      }
    });
    await expect(speak("拍好了。")).resolves.toBeUndefined();
  });

  it("ignores empty text", async () => {
    const synthesize = vi.fn(async () => Buffer.from("pcm"));
    const { speak, sent } = speaker({ synthesize });
    await speak("   ");
    expect(synthesize).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("chunks audio larger than one chunk into 960-byte sendAudio calls", async () => {
    // The board's pump() (rdk/agent/src/audio/playback.ts) tests MAX_QUEUE_MS
    // before shifting a chunk off its queue, so it cannot subdivide a chunk —
    // one client.send must already be at most 20 ms (960 bytes at 24 kHz
    // mono PCM16), or the board's pacing cap cannot meter it.
    const CHUNK_BYTES = 960;
    const remainder = 400;
    const bigPcm = Buffer.alloc(CHUNK_BYTES * 2 + remainder);
    for (let i = 0; i < bigPcm.length; i += 1) bigPcm[i] = i % 256;
    const { speak, sent } = speaker({ synthesize: async () => bigPcm });

    await speak("拍好了。");

    expect(sent).toHaveLength(3);
    expect(sent[0]).toHaveLength(CHUNK_BYTES);
    expect(sent[1]).toHaveLength(CHUNK_BYTES);
    // The final partial chunk is still sent, not dropped.
    expect(sent[2]).toHaveLength(remainder);
    // Concatenating every sent chunk reproduces the original buffer exactly.
    expect(Buffer.concat(sent)).toEqual(bigPcm);
  });

  it("sends one chunk, not many, when audio already fits in one", async () => {
    const { speak, sent } = speaker();
    await speak("拍好了。");
    expect(sent).toHaveLength(1);
  });
});
