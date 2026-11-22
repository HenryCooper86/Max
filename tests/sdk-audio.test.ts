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
