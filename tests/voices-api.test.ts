import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64, voicesApi } from "../src/lib/voices-api";

afterEach(() => vi.unstubAllGlobals());

describe("voices api", () => {
  it("base64-encodes large arrays without overflowing the stack", () => {
    const bytes = new Uint8Array(3_000_000).map((_, i) => i % 251);
    const encoded = bytesToBase64(bytes);
    expect(encoded.length).toBe(Math.ceil(bytes.length / 3) * 4);
    expect(Uint8Array.from(Buffer.from(encoded, "base64"))).toEqual(bytes);
  });

  it("posts a clone as JSON with base64 audio", async () => {
    vi.stubGlobal("window", { location: { search: "" }, localStorage: { getItem: () => null } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "v_0123456789" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await voicesApi.cloneVoice({
      name: "Ann",
      gender: "female",
      languages: ["zh"],
      transcript: "  ",
      consentSpeaker: "Ann",
      consentStatement: "I, Ann, agree to this clone.",
      audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" })
    });
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/auth/admin/studio/voices");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Ann",
      gender: "female",
      languages: ["zh"],
      consent: true,
      consentStatement: "I, Ann, agree to this clone.",
      consentSpeaker: "Ann",
      audio: "AQID",
      audioType: "audio/wav"
    });
  });

  it("keeps the server's error code and returns blobs for audio routes", async () => {
    vi.stubGlobal("window", { location: { search: "" }, localStorage: { getItem: () => null } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, code: "reference_clipped", error: "clipped" }), { status: 400 })
      )
      .mockResolvedValueOnce(new Response("RIFF", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const failed = await voicesApi.previewVoice("v_0123456789");
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "reference_clipped", message: "clipped", kind: "invalid" }
    });
    const audio = await voicesApi.fetchReference("v_0123456789");
    expect(audio.ok && audio.data instanceof Blob).toBe(true);
    expect((fetchMock.mock.calls[1] as unknown[])[0]).toBe("/auth/admin/studio/voices/v_0123456789/reference");
  });
});
