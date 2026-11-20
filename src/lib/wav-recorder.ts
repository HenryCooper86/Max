// Browser-side recording for voice cloning: capture mono PCM from a
// MediaStream and encode it as a 16-bit WAV, so the relay and speech server
// get one plain format whatever the browser records. The pure helpers
// (downmix, rms, encodeWav) have no browser dependencies; the capture part
// takes its Web Audio objects from `RecorderEnvironment` so tests can fake it.

/** The reference clip's length limits, shared with the form and the server. */
export const RECORDING_MAX_SECONDS = 30;

/** A pass-through worklet (public/wav-capture-worklet.js): samples at the context's own rate,
 *  not the live mic's 16 kHz box-average, which has no anti-aliasing. */
const WORKLET_URL = "/wav-capture-worklet.js";

/** Average any number of channels into one. */
export function downmix(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1 && channels[0]) return channels[0];
  const length = Math.min(...channels.map((channel) => channel.length));
  const mixed = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i += 1) mixed[i] = (mixed[i] ?? 0) + (channel[i] ?? 0);
  for (let i = 0; i < length; i += 1) mixed[i] = (mixed[i] ?? 0) / channels.length;
  return mixed;
}

/** Root-mean-square level of a block, 0 to 1 for samples in -1..1. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

/** Mono 16-bit PCM WAV bytes (44-byte header). Samples are clamped. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
  }
  return bytes;
}

export function wavBlob(samples: Float32Array, sampleRate: number): Blob {
  return new Blob([encodeWav(samples, sampleRate)], { type: "audio/wav" });
}

type Recording = { blob: Blob; seconds: number };

export type RecorderProgress = {
  /** Smoothed loudness for a meter, 0 to 1. */
  level: number;
  seconds: number;
};

type WorkletMessage = { type: "samples"; samples: Float32Array };

/** The Web Audio pieces the recorder needs; faked in tests. */
export type RecorderEnvironment = {
  createContext: () => AudioContext;
  createWorkletNode: (context: AudioContext) => AudioWorkletNode;
};

const browserEnvironment: RecorderEnvironment = {
  createContext: () => new AudioContext(),
  createWorkletNode: (context) =>
    new AudioWorkletNode(context, "wav-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit"
    })
};

export type WavRecorder = {
  /** Starts capturing from the stream; resolves once audio is flowing. */
  start: (stream: MediaStream) => Promise<void>;
  /** Stops, releases the microphone and returns the WAV. Safe to repeat. */
  stop: () => Promise<Recording>;
  /** Stops and discards. */
  cancel: () => void;
};

type RecorderOptions = {
  maxSeconds?: number;
  onProgress?: (progress: RecorderProgress) => void;
  /** Called after the recorder stopped itself at maxSeconds. */
  onAutoStop?: (recording: Recording) => void;
  environment?: RecorderEnvironment;
};

export function createWavRecorder(options: RecorderOptions = {}): WavRecorder {
  const maxSeconds = options.maxSeconds ?? RECORDING_MAX_SECONDS;
  const environment = options.environment ?? browserEnvironment;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let teardown: Array<() => void> = [];
  let chunks: Float32Array[] = [];
  let total = 0;
  let rate = 16_000;
  let level = 0;
  let lastReported = { level: -1, seconds: -1 };
  let finished: Recording | null = null;
  let running = false;

  const push = (samples: Float32Array) => {
    if (!running) return;
    const room = Math.max(0, Math.floor(maxSeconds * rate) - total);
    const taken = samples.length > room ? samples.subarray(0, room) : samples;
    if (taken.length) {
      chunks.push(taken.slice());
      total += taken.length;
    }
    level = level * 0.6 + Math.min(1, rms(samples) * 8) * 0.4;
    const reported = { level: Math.round(level * 50) / 50, seconds: Math.floor(total / rate) };
    if (reported.level !== lastReported.level || reported.seconds !== lastReported.seconds) {
      lastReported = reported;
      options.onProgress?.(reported);
    }
    if (total >= Math.floor(maxSeconds * rate)) {
      const recording = release();
      options.onAutoStop?.(recording);
    }
  };

  const release = (): Recording => {
    if (finished) return finished;
    running = false;
    for (const step of teardown) {
      try {
        step();
      } catch {
        /* a node that never attached has nothing to undo */
      }
    }
    teardown = [];
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
    context = null;
    const samples = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    chunks = [];
    finished = { blob: wavBlob(samples, rate), seconds: total / rate };
    options.onProgress?.({ level: 0, seconds: Math.floor(finished.seconds) });
    return finished;
  };

  return {
    async start(media) {
      stream = media;
      try {
        const audio = environment.createContext();
        context = audio;
        const source = audio.createMediaStreamSource(media);
        if (audio.audioWorklet) {
          await audio.audioWorklet.addModule(WORKLET_URL);
          const node = environment.createWorkletNode(audio);
          rate = audio.sampleRate;
          node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
            const message = event.data;
            if (message.type !== "samples") return;
            push(message.samples);
          };
          source.connect(node);
          node.connect(audio.destination);
          teardown.push(() => {
            node.port.onmessage = null;
            node.disconnect();
            source.disconnect();
          });
        } else {
          // Old browsers without AudioWorklet: the deprecated main-thread node.
          rate = audio.sampleRate;
          const processor = audio.createScriptProcessor(4096, 1, 1);
          processor.onaudioprocess = (event) => {
            const channels = Array.from({ length: event.inputBuffer.numberOfChannels }, (_, index) =>
              event.inputBuffer.getChannelData(index)
            );
            push(downmix(channels));
          };
          // The node only runs while connected to an output; silence it.
          const mute = audio.createGain();
          mute.gain.value = 0;
          source.connect(processor);
          processor.connect(mute);
          mute.connect(audio.destination);
          teardown.push(() => {
            processor.onaudioprocess = null;
            processor.disconnect();
            mute.disconnect();
            source.disconnect();
          });
        }
        if (audio.state === "suspended") await audio.resume();
        running = true;
      } catch (error) {
        release();
        throw error;
      }
    },
    async stop() {
      return release();
    },
    cancel() {
      release();
    }
  };
}
