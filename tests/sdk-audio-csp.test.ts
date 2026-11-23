import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserAudio } from "../sdk/src/audio";

type ScriptNode = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onaudioprocess: ((event: unknown) => void) | null;
};

function setup(addModule: (url: string) => Promise<void>, workletUrl?: string) {
  const scriptNodes: ScriptNode[] = [];
  const context = {
    state: "running",
    sampleRate: 16_000,
    destination: {},
    audioWorklet: { addModule: vi.fn(addModule) },
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
    createScriptProcessor: () => {
      const node: ScriptNode = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
      scriptNodes.push(node);
      return node;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  };
  const track = { stop: vi.fn(), enabled: true };
  const media = { getAudioTracks: () => [track], getTracks: () => [track] };
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => media) } });
  const audio = createBrowserAudio({
    audioContext: context as unknown as AudioContext,
    onPlayingChange: () => undefined,
    ...(workletUrl ? { workletUrl } : {})
  });
  return { audio, context, scriptNodes, track };
}

const refused = () => Promise.reject(new DOMException("Refused by Content-Security-Policy", "AbortError"));

describe("microphone capture under a strict Content-Security-Policy", () => {
  let workletNodes: unknown[];
  let createObjectURL: ReturnType<typeof vi.spyOn>;
  let revokeObjectURL: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workletNodes = [];
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        port = { onmessage: null };
        connect = vi.fn();
        disconnect = vi.fn();
        constructor() {
          workletNodes.push(this);
        }
      }
    );
    createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:capture");
    revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("captures on the main thread when the policy refuses the blob worklet", async () => {
    const { audio, scriptNodes, track } = setup(refused);
    const frames: ArrayBuffer[] = [];

    await expect(audio.startMic((pcm) => frames.push(pcm))).resolves.toBeUndefined();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:capture");
    expect(workletNodes).toHaveLength(0);
    expect(scriptNodes).toHaveLength(1);
    expect(track.stop).not.toHaveBeenCalled();
    scriptNodes[0]!.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(640).fill(0.25) } });
    expect(frames).toHaveLength(2);
    expect(frames[0]!.byteLength).toBe(640);
    audio.releaseMic();
  });

  it("loads a same-origin worklet without creating a blob", async () => {
    const { audio, context, scriptNodes } = setup(() => Promise.resolve(), "/pcm-worklet.js");

    await audio.startMic(() => undefined);

    expect(context.audioWorklet.addModule).toHaveBeenCalledExactlyOnceWith("/pcm-worklet.js");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(workletNodes).toHaveLength(1);
    expect(scriptNodes).toHaveLength(0);
    audio.releaseMic();
  });

  it("still opens the microphone when the same-origin worklet cannot load", async () => {
    const { audio, scriptNodes, track } = setup(refused, "/pcm-worklet.js");

    await audio.startMic(() => undefined);

    expect(scriptNodes).toHaveLength(1);
    expect(track.stop).not.toHaveBeenCalled();
    audio.releaseMic();
  });

  it("still opens the microphone when the loaded file registers no capture processor", async () => {
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        constructor() {
          throw new DOMException("not registered", "InvalidStateError");
        }
      }
    );
    const { audio, scriptNodes } = setup(() => Promise.resolve(), "/pcm-worklet.js");

    await audio.startMic(() => undefined);

    expect(scriptNodes).toHaveLength(1);
    audio.releaseMic();
  });

  it("still reports a refused microphone as an error", async () => {
    const { audio } = setup(() => Promise.resolve());
    const denied = new DOMException("Permission denied", "NotAllowedError");
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(denied) } });

    await expect(audio.startMic(() => undefined)).rejects.toBe(denied);
  });
});

describe("the served capture worklet", () => {
  it("is the processor the SDK expects: 20 ms PCM16 frames from pcm-capture", () => {
    const registered = new Map<string, new () => { process(inputs: Float32Array[][]): boolean }>();
    const messages: Array<{ type: string; pcm?: ArrayBuffer }> = [];
    class AudioWorkletProcessor {
      port = { postMessage: (message: { type: string; pcm?: ArrayBuffer }) => void messages.push(message) };
    }
    vm.runInNewContext(readFileSync(new URL("../public/pcm-worklet.js", import.meta.url), "utf8"), {
      AudioWorkletProcessor,
      Int16Array,
      Math,
      sampleRate: 48_000,
      registerProcessor: (name: string, processor: new () => { process(inputs: Float32Array[][]): boolean }) =>
        registered.set(name, processor)
    });

    const Processor = registered.get("pcm-capture");
    expect(Processor).toBeDefined();
    const processor = new Processor!();
    for (let block = 0; block < 8; block += 1) processor.process([[new Float32Array(128).fill(0.5)]]);

    const frames = messages.filter((message) => message.type === "frame");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.pcm!.byteLength).toBe(640);
  });
});
