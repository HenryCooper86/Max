import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserAudio } from "../sdk/src/audio";

/** Just enough AudioContext for the playback path; `resume()` stays pending until `allow()`. */
function fakeContext(initial: "suspended" | "running" = "suspended") {
  const listeners: Array<() => void> = [];
  let release: () => void = () => undefined;
  const node = () => ({
    connect: () => undefined,
    gain: { value: 1 },
    threshold: { value: 0 },
    knee: { value: 0 },
    ratio: { value: 0 },
    attack: { value: 0 },
    release: { value: 0 },
    fftSize: 0
  });
  const context = {
    state: initial as string,
    currentTime: 0,
    destination: {},
    createGain: node,
    createDynamicsCompressor: node,
    createAnalyser: node,
    createBuffer: (_c: number, length: number) => ({ duration: length / 24000, copyToChannel: () => undefined }),
    createBufferSource: () => ({ connect: () => undefined, start: () => undefined, stop: () => undefined }),
    addEventListener: (_type: string, listener: () => void) => void listeners.push(listener),
    removeEventListener: (_type: string, listener: () => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    resume: () =>
      new Promise<void>((resolve) => {
        release = () => {
          context.state = "running";
          resolve();
        };
      })
  };
  return {
    context: context as unknown as AudioContext,
    listenerCount: () => listeners.length,
    /** What the browser does once the user taps. */
    allow: () => {
      release();
      context.state = "running";
      listeners.forEach((l) => l());
    }
  };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("blocked audio", () => {
  it("leaves no listener on a page's own AudioContext after close()", async () => {
    const { context, allow, listenerCount } = fakeContext();
    for (let client = 0; client < 3; client += 1) {
      const audio = createBrowserAudio({ audioContext: context, onPlayingChange: () => undefined });
      const prepared = audio.prepare();
      allow();
      await prepared;
      expect(listenerCount()).toBe(1);
      audio.close();
      expect(listenerCount()).toBe(0);
    }
  });

  it("reports a context that stays suspended after prepare(), and clears it when it runs", async () => {
    const { context, allow } = fakeContext();
    const changes: boolean[] = [];
    const audio = createBrowserAudio({
      audioContext: context,
      onPlayingChange: () => undefined,
      onBlockedChange: (b) => changes.push(b)
    });
    const prepared = audio.prepare();
    await vi.advanceTimersByTimeAsync(999);
    expect(changes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await prepared;
    expect(changes).toEqual([true]);
    allow();
    expect(changes).toEqual([true, false]);
  });

  it("does not report a context that resumes in time", async () => {
    const { context } = fakeContext("running");
    const changes: boolean[] = [];
    const audio = createBrowserAudio({
      audioContext: context,
      onPlayingChange: () => undefined,
      onBlockedChange: (b) => changes.push(b)
    });
    await audio.prepare();
    await vi.advanceTimersByTimeAsync(5000);
    expect(changes).toEqual([]);
  });

  it("flags audio queued into a suspended context, and resume() from a gesture fixes it", async () => {
    const { context, allow } = fakeContext();
    const changes: boolean[] = [];
    const audio = createBrowserAudio({
      audioContext: context,
      onPlayingChange: () => undefined,
      onBlockedChange: (b) => changes.push(b)
    });
    audio.playPcm16(new Int16Array(240).buffer);
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toEqual([true]);
    const resumed = audio.resume();
    allow();
    expect(await resumed).toBe(true);
    expect(changes).toEqual([true, false]);
  });
});

describe("agent voice as a media stream", () => {
  /** Records every call on a gain's `gain` param. */
  function param() {
    const calls: Array<[string, number]> = [];
    return {
      value: 1,
      calls,
      cancelScheduledValues: (t: number) => void calls.push(["cancel", t]),
      setValueAtTime: (v: number, t: number) => void calls.push(["set", v, t] as unknown as [string, number])
    };
  }

  function streamContext() {
    const loud = { value: false };
    const gains: Array<{ gain: ReturnType<typeof param>; connect: () => void; disconnect: ReturnType<typeof vi.fn> }> =
      [];
    const sources: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; stream: unknown }> =
      [];
    const meters: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
    const plain = () => ({
      connect: () => undefined,
      disconnect: vi.fn(),
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 }
    });
    const context = {
      state: "running",
      currentTime: 10,
      sampleRate: 48000,
      destination: {},
      createGain: () => {
        const g = { ...plain(), gain: param() };
        gains.push(g);
        return g;
      },
      createDynamicsCompressor: plain,
      createAnalyser: () => {
        const meter = {
          ...plain(),
          fftSize: 0,
          getFloatTimeDomainData: (samples: Float32Array) => samples.fill(loud.value ? 0.2 : 0)
        };
        meters.push(meter);
        return meter;
      },
      createMediaStreamSource: (stream: unknown) => {
        const source = { connect: vi.fn(), disconnect: vi.fn(), stream };
        sources.push(source);
        return source;
      },
      createScriptProcessor: () => ({ connect: () => undefined, disconnect: () => undefined, onaudioprocess: null }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      resume: () => Promise.resolve()
    };
    return { context: context as unknown as AudioContext, loud, gains, sources, meters };
  }

  class FakeAudioElement {
    static instances: FakeAudioElement[] = [];
    muted = false;
    srcObject: unknown = undefined;
    paused = false;
    play = vi.fn(() => Promise.resolve());
    pause = () => void (this.paused = true);
    constructor() {
      FakeAudioElement.instances.push(this);
    }
  }

  beforeEach(() => {
    FakeAudioElement.instances = [];
    vi.stubGlobal("Audio", FakeAudioElement);
    vi.stubGlobal("AudioWorkletNode", class {});
  });
  afterEach(() => void vi.unstubAllGlobals());

  function setup() {
    const fakes = streamContext();
    const changes: boolean[] = [];
    const audio = createBrowserAudio({ audioContext: fakes.context, onPlayingChange: (p) => changes.push(p) });
    const stream = { id: "remote" } as unknown as MediaStream;
    return { ...fakes, audio, changes, stream };
  }

  it("plays the stream through the graph and reports playing while the meter is loud, then quiet after the hold time", async () => {
    const { audio, stream, sources, loud, changes } = setup();
    audio.playStream!(stream);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.stream).toBe(stream);
    expect(sources[0]!.connect).toHaveBeenCalledTimes(2);
    // The element exists only so Chrome feeds the stream to Web Audio; it must stay muted.
    expect(FakeAudioElement.instances[0]).toMatchObject({ muted: true, srcObject: stream });

    await vi.advanceTimersByTimeAsync(200);
    expect(changes).toEqual([]);
    loud.value = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(changes).toEqual([true]);
    expect(audio.levels().output).toBeGreaterThan(0);

    loud.value = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(changes).toEqual([true]);
    await vi.advanceTimersByTimeAsync(100);
    expect(changes).toEqual([true, false]);
    expect(audio.levels().output).toBe(0);
  });

  it("stopStream with the current stream disconnects it and reports not playing", async () => {
    const { audio, stream, sources, loud, changes } = setup();
    audio.playStream!(stream);
    loud.value = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(changes).toEqual([true]);
    audio.stopStream!(stream);
    expect(changes).toEqual([true, false]);
    expect(sources[0]!.disconnect).toHaveBeenCalled();
    expect(FakeAudioElement.instances[0]).toMatchObject({ paused: true, srcObject: null });
    // The meter timer is gone: loud input no longer reports anything.
    await vi.advanceTimersByTimeAsync(500);
    expect(changes).toEqual([true, false]);
  });

  it("stopStream with a different stream does nothing", async () => {
    const { audio, stream, sources, loud, changes } = setup();
    audio.playStream!(stream);
    loud.value = true;
    await vi.advanceTimersByTimeAsync(50);
    audio.stopStream!({} as MediaStream);
    expect(sources[0]!.disconnect).not.toHaveBeenCalled();
    expect(changes).toEqual([true]);
  });

  it("close() stops the stream", async () => {
    const { audio, stream, sources } = setup();
    audio.playStream!(stream);
    audio.close();
    expect(sources[0]!.disconnect).toHaveBeenCalled();
  });

  it("clearPlayback() mutes the playing stream now and unmutes it shortly after", () => {
    const { audio, stream, gains } = setup();
    audio.playStream!(stream);
    // gains[0] is the playback gain made with the context; gains[1] is the stream's mute gain.
    const mute = gains[1]!.gain;
    audio.clearPlayback();
    expect(mute.calls).toEqual([
      ["cancel", 10],
      ["set", 0, 10],
      ["set", 1, 10.15]
    ]);
  });

  it("clearPlayback() after the stream stopped leaves the gains alone", () => {
    const { audio, stream, gains } = setup();
    audio.playStream!(stream);
    audio.stopStream!(stream);
    audio.clearPlayback();
    for (const g of gains) expect(g.gain.calls).toEqual([]);
  });

  it("micTrack() is the microphone's first audio track once the microphone is open, and undefined before", async () => {
    const { audio } = setup();
    const track = { stop: vi.fn(), enabled: true };
    const media = { getAudioTracks: () => [track], getTracks: () => [track] };
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => media) } });
    expect(audio.micTrack!()).toBeUndefined();
    await audio.startMic(() => undefined);
    expect(audio.micTrack!()).toBe(track);
    audio.releaseMic();
    expect(audio.micTrack!()).toBeUndefined();
  });
});
