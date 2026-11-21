import { afterEach, describe, expect, it } from "vitest";
import {
  assistantProfileFrom,
  assistantSummary,
  basePersonaPrompt,
  DEFAULT_ASSISTANT_PROFILE,
  setAssistantProfileForTests
} from "../server/assistant";
import {
  createEqualizer,
  equalizerCurve,
  equalizerOptions,
  EQUALIZER_PRESETS,
  normalizeEqualizer
} from "../server/audio-eq";
import { EQUALIZER_FREQUENCIES } from "../shared/agent";
import { DEVICE_PRESETS, devicePreset, isKnownDevice } from "../server/device-presets";
import { resolveVoiceProviderId, voiceProviderSummaries } from "../server/providers/catalog";
import { localRealtimeDialect } from "../server/providers/live/openai-realtime";
import { localPipelineEnabled, localPipelineSettings, speechToPcm } from "../server/providers/live/pipeline";
import { sessionEqualizer } from "../server/session-equalizer";

afterEach(() => setAssistantProfileForTests());

describe("device presets", () => {
  it("covers the embodied devices the framework targets", () => {
    expect(DEVICE_PRESETS.map((preset) => preset.id)).toEqual([
      "motorcycle-helmet",
      "bicycle-helmet",
      "sunglasses",
      "smart-glasses",
      "assistive-glasses",
      "ar-headset",
      "vr-headset",
      "wearable",
      "app"
    ]);
    // Every preset names a real equaliser preset and has both languages filled in.
    for (const preset of DEVICE_PRESETS) {
      expect(EQUALIZER_PRESETS.some((eq) => eq.id === preset.equalizer)).toBe(true);
      expect(preset.label.zh && preset.label.en && preset.scope.zh && preset.scope.en).toBeTruthy();
    }
  });

  it("resolves ids, aliases and the three legacy families", () => {
    expect(devicePreset("helmet").id).toBe("motorcycle-helmet");
    expect(devicePreset("glasses").id).toBe("smart-glasses");
    expect(devicePreset("other").id).toBe("wearable");
    expect(devicePreset("Bicycle Helmet").id).toBe("bicycle-helmet");
    expect(devicePreset("visually_impaired").id).toBe("assistive-glasses");
    expect(devicePreset("vr").family).toBe("other");
    expect(devicePreset("toaster").id).toBe("motorcycle-helmet");
    expect(isKnownDevice("ar")).toBe(true);
    expect(isKnownDevice("toaster")).toBe(false);
  });

  it("keeps the original Max helmet untouched", () => {
    expect(DEFAULT_ASSISTANT_PROFILE.preset.id).toBe("motorcycle-helmet");
    expect(DEFAULT_ASSISTANT_PROFILE.equalizer).toEqual({ preset: "flat" });
    expect(assistantSummary(true)).toMatchObject({
      device: "helmet",
      deviceProfile: "motorcycle-helmet",
      deviceLabel: "摩托车头盔",
      template: "visor",
      templateSwitching: true
    });
  });

  it("gives assistive glasses spoken-only, safety-first conduct and their own defaults", () => {
    const profile = assistantProfileFrom({ name: "Iris", device: "assistive-glasses", languages: ["en"] });
    const persona = basePersonaPrompt(profile);
    expect(profile.device).toBe("glasses");
    expect(persona).toContain("blind or has low vision");
    expect(persona).toContain("clock directions");
    expect(persona).toContain("never guess");
    expect(profile.template).toBe("beacon");
    expect(profile.equalizer).toEqual({ preset: "clarity" });
    setAssistantProfileForTests(profile);
    expect(assistantSummary(false)).toMatchObject({
      deviceProfile: "assistive-glasses",
      deviceLabel: "assistive glasses"
    });
  });

  it("writes a cycling persona in Chinese and a VR one that minds the room", () => {
    expect(basePersonaPrompt(assistantProfileFrom({ name: "小风", device: "bicycle" }))).toContain(
      "骑行者需要听到周围的车流"
    );
    expect(basePersonaPrompt(assistantProfileFrom({ name: "Vee", device: "vr", languages: ["en"] }))).toContain(
      "cannot see the real room"
    );
  });

  it("accepts a template, validated theme overrides and an equaliser from config", () => {
    const profile = assistantProfileFrom({
      name: "Nova",
      device: "sunglasses",
      template: "Ember",
      templateSwitching: false,
      theme: {
        accent: "#ff8800",
        "radius-card": "20px",
        bg: "rgb(10, 12, 14)",
        "bad key!": "#fff",
        text: "url(javascript:alert(1))",
        "surface-1": "red; background: url(x)"
      },
      visualizer: "ring",
      voice: { equalizer: { preset: "wind", preamp: -30 } }
    });
    expect(profile.template).toBe("ember");
    expect(profile.templateSwitching).toBe(false);
    expect(profile.theme).toEqual({ accent: "#ff8800", "radius-card": "20px", bg: "rgb(10, 12, 14)" });
    expect(profile.equalizer).toEqual({ preset: "wind", preamp: -12 });
    expect(profile.visualizer).toBe("ring");
    // An unknown style falls back to the device's own.
    expect(assistantProfileFrom({ device: "vr", visualizer: "lasers" }).visualizer).toBe("ring");
    expect(assistantProfileFrom({ device: "sunglasses" }).visualizer).toBe("bars");
  });
});

/** RMS gain in dB of a sine through the equaliser, after it has settled. */
function gainAt(frequency: number, settings: Parameters<typeof createEqualizer>[0], rate = 24_000): number {
  const equalizer = createEqualizer(settings, rate);
  const samples = rate; // one second
  const input = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    input.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * index) / rate) * 3000), index * 2);
  }
  const output = equalizer.process(input);
  let inSum = 0;
  let outSum = 0;
  for (let index = samples / 2; index < samples; index += 1) {
    inSum += input.readInt16LE(index * 2) ** 2;
    outSum += output.readInt16LE(index * 2) ** 2;
  }
  return 10 * Math.log10(outSum / inSum);
}

/** Ten flat bands with one of them moved. */
function only(index: number, gain: number): { bands: number[] } {
  const bands = new Array<number>(10).fill(0);
  bands[index] = gain;
  return { bands };
}

describe("voice equaliser", () => {
  it("is a ten-band graphic equaliser laid out inside the speech bandwidth", () => {
    expect([...EQUALIZER_FREQUENCIES]).toEqual([60, 125, 250, 500, 1000, 2000, 3000, 4000, 6000, 9000]);
    expect(EQUALIZER_PRESETS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(EQUALIZER_PRESETS.map((preset) => preset.id)).size).toBe(EQUALIZER_PRESETS.length);
    for (const preset of EQUALIZER_PRESETS) {
      expect(preset.bands).toHaveLength(10);
      expect(preset.bands.every((gain) => Math.abs(gain) <= 12)).toBe(true);
      expect(Math.abs(preset.preamp)).toBeLessThanOrEqual(12);
    }
    for (const id of [
      "flat",
      "wind",
      "open-ear",
      "bass-boost",
      "treble-boost",
      "radio",
      "telephone",
      "loud",
      "night"
    ]) {
      expect(EQUALIZER_PRESETS.some((preset) => preset.id === id)).toBe(true);
    }
  });

  it("is a true bypass when flat", () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5]);
    expect(createEqualizer(undefined).bypass).toBe(true);
    expect(createEqualizer({ preset: "flat" }).process(pcm)).toBe(pcm);
    expect(createEqualizer({ bands: new Array<number>(10).fill(0), preamp: 0 }).bypass).toBe(true);
  });

  it("moves each band at its own frequency and leaves distant ones alone", () => {
    EQUALIZER_FREQUENCIES.forEach((frequency, index) => {
      // The end bands are shelves, so they are measured a little past their corner.
      const probe = index === 0 ? 40 : index === 9 ? 11_000 : frequency;
      expect(gainAt(probe, only(index, 6)), `${frequency} Hz boost`).toBeGreaterThan(4.5);
      expect(gainAt(probe, only(index, -6)), `${frequency} Hz cut`).toBeLessThan(-4.5);
    });
    expect(gainAt(3000, only(1, 9))).toBeLessThan(0.6);
    expect(gainAt(125, only(6, 9))).toBeLessThan(0.6);
    expect(gainAt(1000, only(9, 9))).toBeLessThan(0.6);
    expect(gainAt(1000, { preamp: -6 })).toBeCloseTo(-6, 1);
  });

  it("shapes speech the way its presets describe", () => {
    expect(gainAt(80, { preset: "wind" })).toBeLessThan(-4);
    expect(gainAt(3000, { preset: "wind" })).toBeGreaterThan(5);
    expect(gainAt(100, { preset: "bass-boost" })).toBeGreaterThan(5);
    expect(gainAt(8000, { preset: "treble-boost" })).toBeGreaterThan(5);
    // A telephone line: the middle survives, both ends do not.
    expect(gainAt(1500, { preset: "telephone" })).toBeGreaterThan(2);
    expect(gainAt(100, { preset: "telephone" })).toBeLessThan(-9);
    expect(gainAt(8000, { preset: "telephone" })).toBeLessThan(-9);
  });

  it("limits instead of wrapping when boosted speech would clip", () => {
    const equalizer = createEqualizer({ preamp: 12 });
    const loud = Buffer.alloc(2000);
    for (let index = 0; index < 1000; index += 1) {
      loud.writeInt16LE(Math.round(Math.sin(index / 5) * 30_000), index * 2);
    }
    const output = equalizer.process(loud);
    let peak = 0;
    for (let index = 0; index < 1000; index += 1) {
      // A wrapped sample would flip sign against its input.
      const before = loud.readInt16LE(index * 2);
      const after = output.readInt16LE(index * 2);
      if (Math.abs(before) > 2000) expect(Math.sign(after)).toBe(Math.sign(before));
      peak = Math.max(peak, Math.abs(after));
    }
    expect(peak).toBeLessThanOrEqual(32767);
    expect(peak).toBeGreaterThan(28_000);
  });

  it("carries a split sample across chunks without losing or inventing bytes", () => {
    const whole = createEqualizer(only(6, 4));
    const split = createEqualizer(only(6, 4));
    const pcm = Buffer.alloc(400);
    for (let index = 0; index < 200; index += 1) pcm.writeInt16LE(Math.round(Math.sin(index / 3) * 8000), index * 2);
    const expected = whole.process(pcm);
    const pieces = [
      split.process(pcm.subarray(0, 101)),
      split.process(pcm.subarray(101, 250)),
      split.process(pcm.subarray(250))
    ];
    expect(pieces[0]!.length).toBe(100);
    expect(Buffer.concat(pieces).equals(expected)).toBe(true);
  });

  it("sanitises untrusted settings", () => {
    expect(normalizeEqualizer({ preset: "wind", bands: [40, -40, 1.26, 0, 0, 0, 0, 0, 0, 0], preamp: -3.26 })).toEqual({
      preset: "wind",
      bands: [12, -12, 1.3, 0, 0, 0, 0, 0, 0, 0],
      preamp: -3.3
    });
    // The wrong number of bands, or a non-number among them, is dropped whole.
    expect(normalizeEqualizer({ preset: "warm", bands: [1, 2, 3] })).toEqual({ preset: "warm" });
    expect(normalizeEqualizer({ bands: [0, 0, 0, 0, "x", 0, 0, 0, 0, 0] })).toBeUndefined();
    expect(normalizeEqualizer({ preset: "nope" })).toBeUndefined();
    expect(normalizeEqualizer([1, 2])).toBeUndefined();
    expect(normalizeEqualizer("wind")).toBeUndefined();
    expect(equalizerCurve({ preset: "wind", preamp: 0 })).toMatchObject({ preamp: 0 });
    expect(equalizerCurve({ preset: "wind" }).bands[0]).toBe(-12);
  });

  it("still understands a config written for the earlier five-band equaliser", () => {
    const converted = normalizeEqualizer({ bass: -8, presence: 4, gain: 2 })!;
    expect(converted.bands).toHaveLength(10);
    expect(converted.bands![0]).toBe(-8);
    expect(converted.bands![6]).toBe(4);
    expect(converted.preamp).toBe(2);
  });

  it("gives a session the wearer's settings, or the profile's default", () => {
    setAssistantProfileForTests(assistantProfileFrom({ name: "Nova", device: "bicycle-helmet" }));
    expect(sessionEqualizer({}).bypass).toBe(false); // the bicycle preset defaults to "wind"
    expect(sessionEqualizer({ equalizer: { preset: "flat" } }).bypass).toBe(true);
    const options = equalizerOptions({ preset: "wind" }, true);
    expect(options).toMatchObject({ default: { preset: "wind" }, adjustable: true });
    expect(options.frequencies).toHaveLength(10);
    expect(options.presets.map((preset) => preset.id)).toContain("open-ear");
  });
});

function wav(samples: number[], rate: number, channels = 1, float = false): Buffer {
  const bytes = float ? 4 : 2;
  const data = Buffer.alloc(samples.length * bytes);
  samples.forEach((sample, index) =>
    float ? data.writeFloatLE(sample, index * 4) : data.writeInt16LE(sample, index * 2)
  );
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(float ? 3 : 1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * bytes, 28);
  header.writeUInt16LE(channels * bytes, 32);
  header.writeUInt16LE(bytes * 8, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("local open-weight backends", () => {
  const KEYS = ["LOCAL_VOICE", "LOCAL_LLM_MODEL", "LOCAL_TTS_BASE_URL", "LOCAL_REALTIME_URL", "LOCAL_REALTIME_MODEL"];
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("is offered only once the owner says the local stack is there", () => {
    for (const key of KEYS) delete process.env[key];
    const entry = () => voiceProviderSummaries().find((provider) => provider.id === "local")!;
    expect(localPipelineEnabled()).toBe(false);
    expect(entry()).toMatchObject({ configured: false, local: true, kind: "pipeline" });
    process.env.LOCAL_VOICE = "on";
    expect(entry().configured).toBe(true);
    delete process.env.LOCAL_VOICE;
    process.env.LOCAL_LLM_MODEL = "llama3.2";
    expect(entry().configured).toBe(true);
    expect(resolveVoiceProviderId("ollama")).toBe("local");
    expect(resolveVoiceProviderId("open-weight")).toBe("local");
  });

  it("defaults to keyless local servers and lets each stage be re-pointed", () => {
    for (const key of KEYS) delete process.env[key];
    const defaults = localPipelineSettings();
    expect(defaults.stt.baseUrl).toBe("http://localhost:8000/v1");
    expect(defaults.llm).toMatchObject({ baseUrl: "http://localhost:11434/v1", apiKey: "" });
    expect(defaults.tts).toMatchObject({ baseUrl: "http://localhost:8880/v1", model: "kokoro", format: "wav" });
    expect(defaults.tts.voice("male")).toBe("am_michael");
    process.env.LOCAL_TTS_BASE_URL = "http://voicebox.local:5002/v1/";
    process.env.LOCAL_LLM_MODEL = "gemma3:12b";
    expect(localPipelineSettings().tts.baseUrl).toBe("http://voicebox.local:5002/v1");
    expect(localPipelineSettings().llm.model).toBe("gemma3:12b");
  });

  it("turns off hidden reasoning for local replies unless told otherwise", () => {
    const saved = process.env.LOCAL_LLM_REASONING_EFFORT;
    try {
      delete process.env.LOCAL_LLM_REASONING_EFFORT;
      expect(localPipelineSettings().llm.reasoningEffort).toBe("none");
      process.env.LOCAL_LLM_REASONING_EFFORT = "LOW";
      expect(localPipelineSettings().llm.reasoningEffort).toBe("low");
      process.env.LOCAL_LLM_REASONING_EFFORT = "default";
      expect(localPipelineSettings().llm).not.toHaveProperty("reasoningEffort");
    } finally {
      if (saved === undefined) delete process.env.LOCAL_LLM_REASONING_EFFORT;
      else process.env.LOCAL_LLM_REASONING_EFFORT = saved;
    }
  });

  it("reads WAV speech at any rate, channel count or sample type", () => {
    // 16 kHz mono int16 → 24 kHz.
    const mono = speechToPcm(wav(new Array(160).fill(1000), 16_000), 24_000);
    expect(mono.length).toBe(480);
    expect(mono.readInt16LE(100)).toBe(1000);
    // 24 kHz stereo is mixed down.
    const stereo = speechToPcm(wav([1000, 3000, 1000, 3000], 24_000, 2), 24_000);
    expect(stereo.length).toBe(4);
    expect(stereo.readInt16LE(0)).toBe(2000);
    // 32-bit float.
    const float = speechToPcm(wav([0.5, -0.5], 24_000, 1, true), 24_000);
    expect(float.readInt16LE(0)).toBe(16384);
    expect(Math.abs(float.readInt16LE(2) + 16384)).toBeLessThanOrEqual(1);
    // A streaming server that never filled in the sizes.
    const streamed = wav([7, 8, 9], 24_000);
    streamed.writeUInt32LE(0xffffffff, 40);
    expect(speechToPcm(streamed, 24_000).length).toBe(6);
    // Raw PCM is passed through at the configured rate.
    expect(speechToPcm(Buffer.alloc(320), 16_000).length).toBe(480);
  });

  it("speaks the flat realtime session shape self-hosted servers expect", () => {
    process.env.LOCAL_REALTIME_URL = "ws://localhost:8000/v1/realtime/";
    process.env.LOCAL_REALTIME_MODEL = "qwen2.5:7b";
    const dialect = localRealtimeDialect();
    expect(dialect.url).toBe("ws://localhost:8000/v1/realtime?model=qwen2.5%3A7b");
    expect(dialect.apiKey).toBe("local");
    expect(dialect.sessionType).toBeUndefined();
    const session = dialect.session(
      { instructions: "hi", voiceGender: "female", manualResponse: true, languages: ["en"], keyterms: [], tools: [] },
      dialect.voice("female")
    );
    expect(session).toMatchObject({
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      voice: "af_heart",
      turn_detection: { type: "server_vad", create_response: false }
    });
    expect(voiceProviderSummaries().find((provider) => provider.id === "local-realtime")).toMatchObject({
      configured: true,
      local: true,
      kind: "live"
    });
  });
});
