import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADAS_SCENARIOS } from "../shared/adas";
import { useAudioPlayback } from "../src/hooks/useAudioPlayback";
import { getWarningClip, WARNING_AUDIO_SOURCE } from "../src/lib/warning-audio";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class Source {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}
const contexts: Context[] = [];
class Context {
  state = "running";
  currentTime = 10;
  sources: Source[] = [];
  destination = {};
  constructor() {
    contexts.push(this);
  }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createBufferSource() {
    const source = new Source();
    this.sources.push(source);
    return source;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return {
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length)
    } as AudioBuffer;
  }
  decodeAudioData = vi.fn(async () => this.createBuffer(1, 72000, 24000));
  createGain() {
    return { context: this, gain: { value: 1 }, connect: vi.fn() };
  }
  createDynamicsCompressor() {
    return {
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
      connect: vi.fn()
    };
  }
}

let renderer: ReactTestRenderer | undefined;
function setup(failedLoad = false) {
  contexts.length = 0;
  const speech = { speaking: false, cancel: vi.fn(), speak: vi.fn(), getVoices: () => [] };
  vi.stubGlobal("window", { speechSynthesis: speech });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      constructor(public text: string) {}
    }
  );
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: !failedLoad,
      arrayBuffer: async () => {
        const bytes = readFileSync(`public${new URL(String(url), "https://max.example").pathname}`);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
    }))
  );
  const voiceGenderRef = { current: "female" as "female" | "male" };
  const interrupted = vi.fn();
  let playback!: ReturnType<typeof useAudioPlayback>;
  function Probe() {
    playback = useAudioPlayback({ voiceGenderRef, transmittingRef: { current: true }, onInterrupted: interrupted });
    return null;
  }
  act(() => {
    renderer = create(createElement(Probe));
  });
  return { playback, speech, interrupted, voiceGenderRef };
}
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
const warning = `${ADAS_SCENARIOS[0].message} ${ADAS_SCENARIOS[0].advice}`;

describe("production warning playback", () => {
  it("cuts queued provider audio, plays exact selected-gender warning, then schedules late PCM after it", async () => {
    const { playback, speech, voiceGenderRef } = setup();
    await playback.ensurePlaybackContext();
    playback.playPcm16(new ArrayBuffer(960));
    const context = contexts[0]!;
    const provider = context.sources[0]!;
    playback.stopAgentSpeech();
    voiceGenderRef.current = "male";
    expect(await playback.speakWarning(warning)).toBe("scheduled");
    const safety = context.sources[1]!;
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(Reflect.get(safety, WARNING_AUDIO_SOURCE)).toMatchObject({ text: warning, gender: "male" });
    expect(safety.start).toHaveBeenCalledWith(10);
    playback.playPcm16(new ArrayBuffer(960));
    expect(context.sources[2]!.start).toHaveBeenCalledWith(10 + getWarningClip(warning, "male")!.durationSeconds);
    expect(speech.speak).not.toHaveBeenCalled();
    playback.stopAgentSpeech();
    expect(safety.stop).toHaveBeenCalledOnce();
    expect(context.sources[2]!.stop).toHaveBeenCalledOnce();
  });

  it("defers ordinary browser speech until the warning completes and barge-in cancels the deferred reply", async () => {
    const { playback, speech } = setup();
    await playback.ensurePlaybackContext();
    await playback.speakWarning(warning);
    playback.speak("later reply");
    expect(speech.speak).not.toHaveBeenCalled();
    contexts[0]!.sources[0]!.onended?.();
    expect(speech.speak).toHaveBeenCalledOnce();
    expect(speech.speak.mock.calls[0]![0].text).toBe("later reply");
    await playback.speakWarning(warning);
    playback.speak("cancel this reply");
    const oldEnded = contexts[0]!.sources[1]!.onended;
    playback.stopAgentSpeech();
    oldEnded?.();
    expect(speech.speak).toHaveBeenCalledOnce();
  });

  it("keeps ordinary replies and unknown warning text on browser TTS without substituting a clip", async () => {
    const { playback, speech } = setup();
    await playback.ensurePlaybackContext();
    playback.speak("普通回复。");
    expect(speech.speak.mock.calls[0]![0].text).toBe("普通回复。");
    expect(await playback.speakWarning("前车急刹。新建议。")).toBe("unknown");
    expect(speech.speak.mock.calls[1]![0].text).toBe("前车急刹。新建议。");
    expect(contexts[0]!.sources).toHaveLength(0);
  });

  it("does not resurrect a failed native fallback after stop or close", async () => {
    for (const ending of ["stopAgentSpeech", "closePlayback"] as const) {
      const { playback, speech } = setup();
      await playback.ensurePlaybackContext();
      contexts[0]!.state = "suspended";
      const pending = playback.speakWarning(warning);
      playback[ending]();
      expect(await pending).toBe("cancelled");
      expect(speech.speak).not.toHaveBeenCalled();
      act(() => renderer?.unmount());
      renderer = undefined;
    }
  });

  it("reports unavailable recorded audio honestly and keeps the original browser fallback", async () => {
    const { playback, speech } = setup(true);
    expect(await playback.ensurePlaybackContext()).toBe(false);
    expect(await playback.speakWarning(warning)).toBe("unavailable");
    expect(speech.speak.mock.calls[0]![0].text).toBe(warning);
    expect(contexts[0]!.sources).toHaveLength(0);
  });
});
