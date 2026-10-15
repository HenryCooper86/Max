import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADAS_SCENARIOS } from "../shared/adas";
import { createWarningAudioPlayer, getWarningClip, WARNING_AUDIO_SOURCE } from "../src/lib/warning-audio";

class Source {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

function context() {
  const sources: Source[] = [];
  const made = {
    state: "running",
    currentTime: 10,
    resume: vi.fn(async () => {}),
    createBuffer: vi.fn((channels: number, length: number, sampleRate: number) => {
      const channel = new Float32Array(length);
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: () => channel
      } as AudioBuffer;
    }),
    decodeAudioData: vi.fn(async () => ({ duration: 3, length: 72000, sampleRate: 24000 }) as AudioBuffer),
    createBufferSource: vi.fn(() => {
      const source = new Source();
      sources.push(source);
      return source;
    })
  };
  return { audio: made as unknown as AudioContext, made, sources };
}

function fetchAssets() {
  return vi.fn(
    async (url: string) =>
      ({
        ok: true,
        arrayBuffer: async () => {
          const bytes = readFileSync(`public${new URL(String(url), "https://max.example").pathname}`);
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        }
      }) as Response
  );
}

const scenario = ADAS_SCENARIOS[0];
const warning = `${scenario.message} ${scenario.advice}`;
afterEach(() => vi.unstubAllGlobals());

describe("exact warning clips", () => {
  it("matches both full canonical sentences and selected gender, never threat guesses", () => {
    expect(getWarningClip(warning, "female")).toMatchObject({
      threat: scenario.threat,
      gender: "female",
      text: warning
    });
    expect(getWarningClip(warning, "male")).toMatchObject({ threat: scenario.threat, gender: "male", text: warning });
    expect(getWarningClip(scenario.message, "female")).toBeUndefined();
    expect(getWarningClip(`${scenario.message} Changed advice`, "female")).toBeUndefined();
    expect(getWarningClip(` ${warning}`, "female")).toBeUndefined();
  });
});

describe("warning WebAudio lifecycle", () => {
  it("preloads once and schedules real audio independently of an unavailable speech backend", async () => {
    const nativeSpeak = vi.fn();
    vi.stubGlobal("window", { speechSynthesis: { getVoices: () => [], speak: nativeSpeak } });
    const load = fetchAssets();
    const player = createWarningAudioPlayer({ fetchImpl: load as unknown as typeof fetch });
    const { audio, made, sources } = context();
    expect(await player.preload(audio)).toBe(true);
    const loaded = load.mock.calls.length;
    expect(loaded).toBe(18);
    const output = {} as AudioNode;
    const scheduled = vi.fn();
    expect(await player.play(audio, warning, "male", output, scheduled)).toBe("scheduled");
    expect(load).toHaveBeenCalledTimes(loaded);
    expect(made.createBuffer).toHaveBeenCalledTimes(loaded);
    expect(made.decodeAudioData).not.toHaveBeenCalled();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.buffer).toBeTruthy();
    expect(sources[0]!.connect).toHaveBeenCalledWith(output);
    expect(sources[0]!.start).toHaveBeenCalledWith(10);
    expect(Reflect.get(sources[0]!, WARNING_AUDIO_SOURCE)).toMatchObject({ text: warning, gender: "male" });
    expect(scheduled).toHaveBeenCalledWith(10, getWarningClip(warning, "male")!.durationSeconds);
    expect(nativeSpeak).not.toHaveBeenCalled();
    expect(player.isActive()).toBe(true);
    sources[0]!.onended?.();
    expect(player.isActive()).toBe(false);
    expect(sources[0]!.disconnect).toHaveBeenCalled();
  });

  it("preserves exact PCM16 samples despite a platform decoder using another normalization", async () => {
    const clip = getWarningClip(warning, "female")!;
    const { audio, made, sources } = context();
    const original = readFileSync(`public/audio/adas/${clip.file}`);
    // The native Chrome decoder observed in the diagnostic normalized signed
    // PCM by 32767, so rounding it back to PCM16 changes some genuine samples.
    made.decodeAudioData.mockImplementation(async () => {
      const buffer = made.createBuffer(1, clip.samples, 24000);
      const dataAt = original.indexOf(Buffer.from("data")) + 8;
      for (let i = 0; i < clip.samples; i += 1)
        buffer.getChannelData(0)[i] = original.readInt16LE(dataAt + i * 2) / 32767;
      return buffer;
    });
    const player = createWarningAudioPlayer({ fetchImpl: fetchAssets() as unknown as typeof fetch });
    expect(await player.play(audio, warning, "female", {} as AudioNode)).toBe("scheduled");
    const buffer = sources[0]!.buffer!;
    const reconstructed = Buffer.alloc(buffer.length * 2);
    buffer
      .getChannelData(0)
      .forEach((sample, index) =>
        reconstructed.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), index * 2)
      );
    expect(createHash("sha256").update(reconstructed).digest("hex")).toBe(clip.pcmSha256);
    expect(made.decodeAudioData).not.toHaveBeenCalled();
  });

  it("stops a playing warning and does not let its late completion clear a newer warning", async () => {
    const player = createWarningAudioPlayer({ fetchImpl: fetchAssets() as unknown as typeof fetch });
    const { audio, sources } = context();
    await player.preload(audio);
    await player.play(audio, warning, "female", {} as AudioNode);
    const oldEnded = sources[0]!.onended;
    await player.play(audio, warning, "male", {} as AudioNode);
    expect(sources[0]!.stop).toHaveBeenCalledOnce();
    oldEnded?.();
    expect(player.isActive()).toBe(true);
    player.stop();
    expect(sources[1]!.stop).toHaveBeenCalledOnce();
    expect(player.isActive()).toBe(false);
  });

  it("cannot resurrect playback when a pending fetch finishes after stop or close", async () => {
    for (const ending of ["stop", "close"] as const) {
      let resolve!: (value: Response) => void;
      const response = new Promise<Response>((done) => {
        resolve = done;
      });
      const player = createWarningAudioPlayer({ fetchImpl: vi.fn(() => response) as unknown as typeof fetch });
      const { audio, sources } = context();
      const pending = player.play(audio, warning, "female", {} as AudioNode);
      player[ending]();
      resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(44) } as Response);
      expect(await pending).toBe("cancelled");
      expect(sources).toHaveLength(0);
      expect(player.isActive()).toBe(false);
    }
  });

  it("reports failed loads and unknown messages without playing another warning", async () => {
    const player = createWarningAudioPlayer({
      fetchImpl: vi.fn(async () => ({ ok: false })) as unknown as typeof fetch
    });
    const { audio, sources } = context();
    expect(await player.preload(audio)).toBe(false);
    expect(await player.play(audio, warning, "female", {} as AudioNode)).toBe("unavailable");
    expect(await player.play(audio, `${warning}!`, "female", {} as AudioNode)).toBe("unknown");
    expect(sources).toHaveLength(0);
  });

  it("can retry a failed preparation after connectivity recovers", async () => {
    const successful = fetchAssets();
    let available = false;
    const fetchImpl = vi.fn((url: string) =>
      available ? successful(url) : Promise.resolve({ ok: false } as Response)
    );
    const player = createWarningAudioPlayer({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const { audio } = context();
    expect(await player.preload(audio)).toBe(false);
    available = true;
    expect(await player.preload(audio)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(36);
    expect(await player.preload(audio)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(36);
  });
});
