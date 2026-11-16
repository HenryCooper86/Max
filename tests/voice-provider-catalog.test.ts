import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVoiceProviderId, voiceProviderSummaries } from "../server/providers/catalog";
import { chooseVoiceProvider, createSelectableProvider } from "../server/providers/factory";
import type { AgentProvider, SessionStartEvent } from "../server/providers/types";

const KEYS = ["OPENAI_API_KEY", "XAI_API_KEY", "GROK_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "PIPELINE_API_KEY"];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function clearKeys() {
  for (const key of KEYS) delete process.env[key];
}

describe("voice provider catalog", () => {
  it("resolves ids and friendly aliases", () => {
    expect(resolveVoiceProviderId("OpenAI")).toBe("openai");
    expect(resolveVoiceProviderId("xai")).toBe("grok");
    expect(resolveVoiceProviderId("whisper")).toBe("pipeline");
    expect(resolveVoiceProviderId("gemini-live")).toBe("gemini");
    expect(resolveVoiceProviderId("alexa")).toBeUndefined();
    expect(resolveVoiceProviderId("")).toBeUndefined();
  });

  it("reports which backends have credentials", () => {
    clearKeys();
    const before = Object.fromEntries(voiceProviderSummaries().map((entry) => [entry.id, entry.configured]));
    expect(before).toMatchObject({ mock: true, openai: false, grok: false, gemini: false, pipeline: false });

    process.env.XAI_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-key";
    const after = Object.fromEntries(voiceProviderSummaries().map((entry) => [entry.id, entry.configured]));
    // The pipeline defaults to OpenAI's endpoints, so the OpenAI key enables it too.
    expect(after).toMatchObject({ openai: true, grok: true, gemini: false, pipeline: true });
    expect(voiceProviderSummaries().map((entry) => entry.kind)).toEqual([
      "demo",
      "live",
      "live",
      "live",
      "live",
      "pipeline",
      "pipeline",
      "live"
    ]);
  });

  it("gives a session the backend it asks for only when allowed and configured", () => {
    clearKeys();
    process.env.OPENAI_API_KEY = "test-key";
    const on = { fallback: "mock", switching: true } as const;
    expect(chooseVoiceProvider("openai", on)).toBe("openai");
    expect(chooseVoiceProvider("chatgpt", on)).toBe("openai");
    expect(chooseVoiceProvider("grok", on)).toBe("mock");
    expect(chooseVoiceProvider("nonsense", on)).toBe("mock");
    expect(chooseVoiceProvider(undefined, on)).toBe("mock");
    expect(chooseVoiceProvider("openai", { fallback: "mock", switching: false })).toBe("mock");
  });

  it("defers the choice of backend until session.start", async () => {
    const inner: AgentProvider = {
      start: vi.fn(async () => undefined),
      startAudio: vi.fn(async () => undefined),
      sendAudio: vi.fn(async () => undefined),
      stopAudio: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      speakNavLine: vi.fn()
    };
    const create = vi.fn(() => inner);
    const provider = createSelectableProvider(create);

    // Nothing exists yet: audio before start is dropped, not a crash.
    await provider.sendAudio(Buffer.alloc(4));
    await provider.close();
    expect(create).not.toHaveBeenCalled();

    const event: SessionStartEvent = { type: "session.start", sampleRate: 16000, channels: 1, voiceProvider: "grok" };
    await provider.start(event);
    expect(create).toHaveBeenCalledWith("grok");
    expect(inner.start).toHaveBeenCalledWith(event, undefined);

    await provider.startAudio();
    provider.speakNavLine?.("前方右转");
    await provider.deviceResult?.({ type: "device.result", commandId: "x", status: "ok" });
    expect(inner.startAudio).toHaveBeenCalledOnce();
    expect(inner.speakNavLine).toHaveBeenCalledWith("前方右转");
  });
});
