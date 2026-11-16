import { describe, expect, it } from "vitest";
import { localEnv, LOCAL_STAGES, mergeEnv, serverResponds, type LocalAnswers } from "../scripts/setup";

describe("setup wizard env merge", () => {
  it("replaces managed keys in place and leaves everything else untouched", () => {
    const before = "# keys\nAMAP_API_KEY=abc\nVOICE_PROVIDER=mock\n# OPENAI_API_KEY=\n\n";
    expect(mergeEnv(before, { VOICE_PROVIDER: "grok", XAI_API_KEY: "k" })).toBe(
      "# keys\nAMAP_API_KEY=abc\nVOICE_PROVIDER=grok\n# OPENAI_API_KEY=\nXAI_API_KEY=k\n"
    );
  });

  it("creates a file from nothing", () => {
    expect(mergeEnv("", { VOICE_PROVIDER: "openai" })).toBe("VOICE_PROVIDER=openai\n");
  });
});

describe("setup wizard local models", () => {
  const defaults: LocalAnswers = {
    STT: { baseUrl: "http://localhost:8000/v1", model: "Systran/faster-whisper-small" },
    LLM: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
    TTS: { baseUrl: "http://localhost:8880/v1", model: "kokoro" },
    voice: "af_heart",
    voiceMale: "am_michael"
  };

  it("asks about speech-to-text, the chat model and text-to-speech", () => {
    expect(LOCAL_STAGES.map((stage) => stage.key)).toEqual(["STT", "LLM", "TTS"]);
  });

  it("turns the local backend on and writes only what was changed", () => {
    expect(localEnv(defaults, defaults)).toEqual({ LOCAL_VOICE: "on" });
    expect(
      localEnv(
        {
          ...defaults,
          LLM: { baseUrl: "http://gpu-box.local:8001/v1/", model: "gemma3:12b" },
          TTS: { ...defaults.TTS, model: "piper" },
          voice: "bf_emma"
        },
        defaults
      )
    ).toEqual({
      LOCAL_VOICE: "on",
      LOCAL_LLM_BASE_URL: "http://gpu-box.local:8001/v1",
      LOCAL_LLM_MODEL: "gemma3:12b",
      LOCAL_TTS_MODEL: "piper",
      LOCAL_TTS_VOICE: "bf_emma"
    });
  });

  it("reports whether a local server answers, whatever its reply", async () => {
    const calls: string[] = [];
    const answering = (async (url: string) => {
      calls.push(url);
      return new Response("unauthorized", { status: 401 });
    }) as unknown as typeof fetch;
    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await serverResponds("http://localhost:11434/v1/", answering)).toBe(true);
    expect(calls).toEqual(["http://localhost:11434/v1/models"]);
    expect(await serverResponds("http://localhost:11434/v1", dead)).toBe(false);
  });
});
