import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { useMicCapture } from "../src/hooks/useMicCapture";
import type { WorkletMessage } from "../src/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: ReactTestRenderer | undefined;
let mic: ReturnType<typeof useMicCapture>;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function renderMic(onFrameRms: (rms: number) => void = vi.fn()) {
  const params = {
    socketRef: { current: null },
    transmittingRef: { current: false },
    providerReadyRef: { current: false },
    onFrameRms
  };
  function Harness() {
    mic = useMicCapture(params);
    return null;
  }
  act(() => {
    renderer = create(<Harness />);
  });
}

it("an abandoned mic setup cannot invalidate a newer pending microphone request", async () => {
  const pending: Array<(error: Error) => void> = [];
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>((_resolve, reject) => {
        pending.push(reject);
      })
  );
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  renderMic();

  const first = mic.ensureMic().catch(() => {});
  act(() => mic.releaseMic());
  const second = mic.ensureMic().catch(() => {});
  pending[0]!(new Error("Old permission request cancelled"));
  await first;
  const retry = mic.ensureMic().catch(() => {});

  const allocations = getUserMedia.mock.calls.length;
  pending.slice(1).forEach((reject) => reject(new Error("Test cleanup")));
  await Promise.all([second, retry]);
  expect(allocations).toBe(2);
});

it("an abandoned worklet failure cannot overwrite the newer microphone processing readout", async () => {
  let rejectOldModule!: (error: Error) => void;
  let contextCount = 0;
  const track = {
    stop: () => {},
    getSettings: () => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 16_000 })
  };
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] })
    }
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      destination = {};
      audioWorklet = {
        addModule: () =>
          ++contextCount === 1
            ? new Promise<void>((_resolve, reject) => {
                rejectOldModule = reject;
              })
            : Promise.resolve()
      };
      createMediaStreamSource() {
        return { connect: () => {} };
      }
      async close() {
        this.state = "closed";
      }
    }
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = { onmessage: null };
      connect() {}
      disconnect() {}
    }
  );
  renderMic();
  let first!: Promise<void>;
  await act(async () => {
    first = mic.ensureMic().catch(() => {});
  });
  act(() => mic.releaseMic());
  await act(async () => {
    await mic.ensureMic();
  });
  await act(async () => {
    rejectOldModule(new Error("Old module load failed"));
    await first;
  });

  expect(mic.audioProcessing).toEqual({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: 16_000
  });
  act(() => mic.releaseMic());
});

it("tells the barge-in witness how loud every captured frame is, sent or dropped", async () => {
  const track = { stop: () => {}, getSettings: () => ({}) };
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) }
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      destination = {};
      audioWorklet = { addModule: () => Promise.resolve() };
      createMediaStreamSource() {
        return { connect: () => {} };
      }
      async close() {
        this.state = "closed";
      }
    }
  );
  let workletPort: { onmessage: ((event: { data: WorkletMessage }) => void) | null } | null = null;
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = { onmessage: null };
      constructor() {
        workletPort = this.port;
      }
      connect() {}
      disconnect() {}
    }
  );
  const onFrameRms = vi.fn();
  renderMic(onFrameRms);
  await act(async () => {
    await mic.ensureMic();
  });
  const frame = (sample: (index: number) => number) => {
    const pcm = new Int16Array(320);
    for (let index = 0; index < pcm.length; index += 1) pcm[index] = sample(index);
    return pcm.buffer;
  };
  const captured = (pcm: ArrayBuffer) => act(() => workletPort?.onmessage?.({ data: { type: "frame", pcm } }));

  // Hands-free is off, so neither frame leaves for the relay.
  captured(frame(() => 3000));
  // A square wave switching between 6000 and silence: 6000 / √2.
  captured(frame((index) => (index % 2 ? 0 : 6000)));
  act(() => mic.releaseMic());

  expect(onFrameRms.mock.calls.map(([rms]) => Math.round(rms))).toEqual([3000, 4243]);
});
