import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BASE64_CHARS } from "../shared/agent";
import { CLIENT_EVENT_TYPES } from "../shared/generated/agent-protocol";
import { voiceCapabilities } from "../server/providers/catalog";
import { openAiModelTakesImages } from "../server/providers/live/openai-realtime";
import { AgentSessionController, parseClientEvent } from "../server/session-controller";
import type { AgentProvider } from "../server/providers/types";

const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1]);
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const jpeg = JPEG_HEAD.toString("base64");
const png = PNG_HEAD.toString("base64");

function parse(event: Record<string, unknown>) {
  return parseClientEvent(Buffer.from(JSON.stringify({ type: "image.input", ...event })));
}

describe("image.input validation", () => {
  it("is a known client event", () => {
    expect(CLIENT_EVENT_TYPES).toContain("image.input");
  });

  it("accepts a JPEG and a PNG", () => {
    expect(parse({ image: jpeg, mimeType: "image/jpeg" })).toEqual({
      type: "image.input",
      image: jpeg,
      mimeType: "image/jpeg"
    });
    expect(parse({ image: png, mimeType: "image/png" })).toMatchObject({ mimeType: "image/png" });
  });

  it("trims the text, and treats empty or blank text as absent", () => {
    expect(parse({ image: jpeg, mimeType: "image/jpeg", text: "  what is this?  " })).toMatchObject({
      text: "what is this?"
    });
    expect(parse({ image: jpeg, mimeType: "image/jpeg", text: "   " })).not.toHaveProperty("text");
    expect(parse({ image: jpeg, mimeType: "image/jpeg", text: "" })).not.toHaveProperty("text");
  });

  it("applies text.input's limit to the text", () => {
    expect(() => parse({ image: jpeg, mimeType: "image/jpeg", text: "a".repeat(2_001) })).toThrow(/text/);
    expect(parse({ image: jpeg, mimeType: "image/jpeg", text: "a".repeat(2_000) })).toHaveProperty("text");
    expect(() => parse({ image: jpeg, mimeType: "image/jpeg", text: 5 })).toThrow(/text/);
  });

  it("rejects any other media type", () => {
    for (const mimeType of ["image/gif", "image/webp", "text/plain", undefined, 7]) {
      expect(() => parse({ image: jpeg, mimeType })).toThrow(/mimeType/);
    }
  });

  it("rejects a missing or non-string image", () => {
    expect(() => parse({ mimeType: "image/jpeg" })).toThrow(/image/);
    expect(() => parse({ image: "", mimeType: "image/jpeg" })).toThrow(/image/);
    expect(() => parse({ image: [1, 2], mimeType: "image/jpeg" })).toThrow(/image/);
  });

  it("rejects text that is not base64", () => {
    expect(() => parse({ image: `${jpeg.slice(0, 8)}!!!!`, mimeType: "image/jpeg" })).toThrow(/base64/);
    // A data: prefix is not part of the base64.
    expect(() => parse({ image: `data:image/jpeg;base64,${jpeg}`, mimeType: "image/jpeg" })).toThrow(/base64/);
    // Not a multiple of four characters.
    expect(() => parse({ image: jpeg.slice(0, -1), mimeType: "image/jpeg" })).toThrow(/base64/);
  });

  it("rejects bytes that are not what the media type says", () => {
    expect(() => parse({ image: png, mimeType: "image/jpeg" })).toThrow(/JPEG/);
    expect(() => parse({ image: jpeg, mimeType: "image/png" })).toThrow(/PNG/);
    expect(() => parse({ image: Buffer.from("GIF89a-not-a-jpeg").toString("base64"), mimeType: "image/jpeg" })).toThrow(
      /JPEG/
    );
    // A PNG signature cut short.
    expect(() => parse({ image: PNG_HEAD.subarray(0, 6).toString("base64"), mimeType: "image/png" })).toThrow(/PNG/);
  });

  it("accepts the longest allowed picture and refuses one character more", () => {
    // 180,000 bytes are exactly 240,000 base64 characters.
    const longest = Buffer.concat([JPEG_HEAD, Buffer.alloc(180_000 - JPEG_HEAD.length)]).toString("base64");
    expect(longest).toHaveLength(MAX_IMAGE_BASE64_CHARS);
    expect(parse({ image: longest, mimeType: "image/jpeg" })).toHaveProperty("image");
    expect(() => parse({ image: `${longest}AAAA`, mimeType: "image/jpeg" })).toThrow(/too large/);
  });

  it("keeps the biggest message under the relay's 256 KiB limit", () => {
    const body = JSON.stringify({
      type: "image.input",
      image: "A".repeat(MAX_IMAGE_BASE64_CHARS),
      mimeType: "image/jpeg",
      text: "é".repeat(2_000)
    });
    expect(Buffer.byteLength(body)).toBeLessThan(256 * 1024);
  });
});

describe("imageInput capability", () => {
  const KEYS = [
    "LOCAL_LLM_IMAGES",
    "PIPELINE_LLM_IMAGES",
    "OPENAI_REALTIME_MODEL",
    "LOCAL_LLM_MODEL",
    "MAX_SPEECH",
    "VOICE_PROVIDER"
  ];
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("is off everywhere that cannot take pictures", () => {
    for (const key of KEYS) delete process.env[key];
    expect(voiceCapabilities("mock").imageInput).toBe(false);
    expect(voiceCapabilities("doubao").imageInput).toBe(false);
    expect(voiceCapabilities("grok").imageInput).toBe(false);
    expect(voiceCapabilities("local-realtime").imageInput).toBe(false);
  });

  it("is on for Gemini Live and for OpenAI Realtime models that are not previews", () => {
    for (const key of KEYS) delete process.env[key];
    expect(voiceCapabilities("gemini").imageInput).toBe(true);
    expect(voiceCapabilities("openai").imageInput).toBe(true);
    process.env.OPENAI_REALTIME_MODEL = "gpt-realtime-2";
    expect(voiceCapabilities("openai").imageInput).toBe(true);
    process.env.OPENAI_REALTIME_MODEL = "gpt-4o-realtime-preview-2024-12-17";
    expect(voiceCapabilities("openai").imageInput).toBe(false);
    expect(openAiModelTakesImages("gpt-4o-mini-realtime-PREVIEW")).toBe(false);
  });

  it("is on for the chat-model backends only when their switch is on", () => {
    for (const key of KEYS) delete process.env[key];
    for (const id of ["pipeline", "local", "max-speech"] as const) expect(voiceCapabilities(id).imageInput).toBe(false);

    process.env.PIPELINE_LLM_IMAGES = "on";
    expect(voiceCapabilities("pipeline").imageInput).toBe(true);
    expect(voiceCapabilities("local").imageInput).toBe(false);

    delete process.env.PIPELINE_LLM_IMAGES;
    process.env.LOCAL_LLM_IMAGES = "on";
    expect(voiceCapabilities("local").imageInput).toBe(true);
    expect(voiceCapabilities("max-speech").imageInput).toBe(true);
    expect(voiceCapabilities("pipeline").imageInput).toBe(false);

    process.env.LOCAL_LLM_IMAGES = "off";
    expect(voiceCapabilities("local").imageInput).toBe(false);
  });

  it("keeps every other capability as the backend declares it", () => {
    for (const key of KEYS) delete process.env[key];
    expect(voiceCapabilities("local")).toMatchObject({ tools: true, textInput: true });
    expect(voiceCapabilities("doubao")).toMatchObject({ tools: false, textInput: false });
  });
});

describe("image.input dispatch", () => {
  async function run(provider: Partial<AgentProvider>, event: Record<string, unknown>) {
    const send = vi.fn();
    const client = { readyState: 1, OPEN: 1, send, close: vi.fn() } as never;
    const controller = new AgentSessionController(client, () => ({
      start: async () => undefined,
      startAudio: async () => undefined,
      sendAudio: async () => undefined,
      stopAudio: async () => undefined,
      close: async () => undefined,
      ...provider
    }));
    const message = (value: unknown) => controller.handleMessage(Buffer.from(JSON.stringify(value)), false);
    await message({ type: "session.start", sampleRate: 16000, channels: 1 });
    await message({ type: "image.input", ...event });
    await controller.close();
    return send.mock.calls.map(([payload]) => JSON.parse(String(payload)) as Record<string, unknown>);
  }

  it("hands the provider the picture and the words", async () => {
    const imageInput = vi.fn(async () => undefined);
    const sent = await run({ imageInput }, { image: jpeg, mimeType: "image/jpeg", text: " hi " });
    expect(imageInput).toHaveBeenCalledWith({ data: jpeg, mimeType: "image/jpeg" }, "hi");
    expect(sent.filter((event) => event.type === "error")).toEqual([]);
  });

  it("answers with an error when the provider has no image input or declines", async () => {
    for (const provider of [{}, { imageInput: async () => false }]) {
      const sent = await run(provider, { image: jpeg, mimeType: "image/jpeg" });
      expect(sent.filter((event) => event.type === "error")).toEqual([
        { type: "error", message: "This voice backend does not take pictures." }
      ]);
    }
  });

  it("answers an invalid picture with an error and does not reach the provider", async () => {
    const imageInput = vi.fn(async () => undefined);
    const sent = await run({ imageInput }, { image: png, mimeType: "image/jpeg" });
    expect(imageInput).not.toHaveBeenCalled();
    expect(sent.filter((event) => event.type === "error")).toHaveLength(1);
  });
});
