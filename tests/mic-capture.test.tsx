import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { useMicCapture } from "../src/hooks/useMicCapture";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: ReactTestRenderer | undefined;
let mic: ReturnType<typeof useMicCapture>;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function renderMic() {
  const params = {
    socketRef: { current: null },
    transmittingRef: { current: false },
    providerReadyRef: { current: false }
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
