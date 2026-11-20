import { describe, expect, it, vi } from "vitest";
import { createWavRecorder, downmix, encodeWav, rms, type RecorderEnvironment } from "../src/lib/wav-recorder";

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

describe("WAV helpers", () => {
  it("encodes a mono 16-bit PCM header and clamped samples", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 16_000);
    const view = new DataView(wav.buffer);
    expect(wav.length).toBe(44 + 6 * 2);
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(ascii(wav, 8, 8)).toBe("WAVEfmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(wav, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(12);
    expect([0, 1, 2, 3, 4, 5].map((i) => view.getInt16(44 + i * 2, true))).toEqual([
      0, 32767, -32768, 32767, -32768, 16384
    ]);
  });

  it("averages channels and tolerates uneven lengths", () => {
    expect(Array.from(downmix([new Float32Array([1, 0.5]), new Float32Array([0, 0.5, 9])]))).toEqual([0.5, 0.5]);
    const only = new Float32Array([0.25]);
    expect(downmix([only])).toBe(only);
    expect(downmix([]).length).toBe(0);
  });

  it("measures RMS", () => {
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(new Float32Array([0, 0, 0]))).toBe(0);
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
  });
});

type Port = { onmessage: ((event: MessageEvent) => void) | null };

function fakeEnvironment(worklet: boolean) {
  const port: Port = { onmessage: null };
  const processor: { onaudioprocess: ((event: unknown) => void) | null; connect: () => void; disconnect: () => void } =
    {
      onaudioprocess: null,
      connect: vi.fn(),
      disconnect: vi.fn()
    };
  const context = {
    sampleRate: 8000,
    state: "running",
    destination: {},
    audioWorklet: worklet ? { addModule: vi.fn(async () => undefined) } : undefined,
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
    createScriptProcessor: () => processor,
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  };
  const environment: RecorderEnvironment = {
    createContext: () => context as unknown as AudioContext,
    createWorkletNode: () => ({ port, connect: vi.fn(), disconnect: vi.fn() }) as unknown as AudioWorkletNode
  };
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const frame = (samples: number[]) =>
    port.onmessage?.({ data: { type: "samples", samples: Float32Array.from(samples) } } as MessageEvent);
  return { environment, context, processor, track, stream, frame };
}

describe("createWavRecorder", () => {
  it("records worklet samples at the context's native rate and releases the microphone", async () => {
    const fake = fakeEnvironment(true);
    const progress = vi.fn();
    const recorder = createWavRecorder({ environment: fake.environment, onProgress: progress });
    await recorder.start(fake.stream);
    fake.frame(new Array(4000).fill(0.5));
    fake.frame(new Array(4000).fill(-0.5));
    expect(progress).toHaveBeenCalled();
    expect(progress.mock.calls.some(([value]) => value.level > 0)).toBe(true);
    const recording = await recorder.stop();
    expect(recording.seconds).toBe(1);
    expect(recording.blob.type).toBe("audio/wav");
    const bytes = new Uint8Array(await recording.blob.arrayBuffer());
    expect(bytes.length).toBe(44 + 8000 * 2);
    // The fake context runs at 8 kHz: the WAV keeps that rate, nothing is resampled.
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(8000);
    expect(fake.context.audioWorklet!.addModule).toHaveBeenCalledWith("/wav-capture-worklet.js");
    expect(fake.track.stop).toHaveBeenCalled();
    expect(fake.context.close).toHaveBeenCalled();
    // Stopping twice returns the same recording.
    expect(await recorder.stop()).toBe(recording);
  });

  it("stops itself at the time limit and ignores later audio", async () => {
    const fake = fakeEnvironment(true);
    const onAutoStop = vi.fn();
    const recorder = createWavRecorder({ environment: fake.environment, maxSeconds: 1, onAutoStop });
    await recorder.start(fake.stream);
    fake.frame(new Array(6000).fill(0.1));
    expect(onAutoStop).not.toHaveBeenCalled();
    fake.frame(new Array(6000).fill(0.1));
    expect(onAutoStop).toHaveBeenCalledOnce();
    expect(onAutoStop.mock.calls[0]![0].seconds).toBe(1);
    expect(fake.track.stop).toHaveBeenCalled();
    fake.frame(new Array(100).fill(0.1));
    expect((await recorder.stop()).seconds).toBe(1);
  });

  it("falls back to a script processor at the context's rate, mixing channels down", async () => {
    const fake = fakeEnvironment(false);
    const recorder = createWavRecorder({ environment: fake.environment });
    await recorder.start(fake.stream);
    const left = new Float32Array(4000).fill(1);
    const right = new Float32Array(4000).fill(0);
    fake.processor.onaudioprocess?.({
      inputBuffer: { numberOfChannels: 2, getChannelData: (index: number) => (index === 0 ? left : right) }
    });
    const recording = await recorder.stop();
    expect(recording.seconds).toBe(0.5);
    const bytes = new Uint8Array(await recording.blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getInt16(44, true)).toBe(16384);
  });

  it("frees the stream when setup fails", async () => {
    const fake = fakeEnvironment(true);
    fake.context.audioWorklet!.addModule = vi.fn(async () => {
      throw new Error("blocked");
    });
    const recorder = createWavRecorder({ environment: fake.environment });
    await expect(recorder.start(fake.stream)).rejects.toThrow("blocked");
    expect(fake.track.stop).toHaveBeenCalled();
  });
});
