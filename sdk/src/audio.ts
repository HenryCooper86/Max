/**
 * Browser audio for the voice agent: microphone capture (AudioWorklet with a
 * ScriptProcessor fallback), gapless PCM16 playback, barge-in, and a browser
 * speech fallback. Internal; the public surface is {@link VoiceAgent}.
 */

import { DOWNLINK_SAMPLE_RATE, FRAME_SAMPLES, PcmFramer, meterLevel, pcm16ToFloat32, rms } from "./protocol.js";
import type { VoiceGender } from "./protocol.js";

/**
 * Resumes a suspended context, but never waits for it longer than `ms`.
 * Outside a user gesture, browsers leave `resume()` pending until the next
 * one; blocking on it would hang `start()` forever. The context still
 * resumes on its own once the page is allowed to play sound. A context that
 * is still suspended after the wait is reported through `onBlocked`, so the
 * page can ask the user for a tap instead of staying silent.
 */
async function resumeWithin(context: AudioContext, onBlocked: () => void, ms = 1000): Promise<void> {
  await Promise.race([
    context.resume().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ms))
  ]);
  if (context.state === "suspended") onBlocked();
}

/** Everything the client needs from audio hardware; fakeable in tests. */
export interface AudioIO {
  /** Creates or resumes contexts. Call synchronously from a user gesture. */
  prepare(): Promise<void>;
  /** Opens the microphone and delivers 20 ms PCM16 frames until {@link releaseMic}. */
  startMic(onFrame: (pcm: ArrayBuffer) => void): Promise<void>;
  /** Enables or disables the mic track without tearing the graph down. */
  setMicEnabled(enabled: boolean): void;
  /** Stops the mic and frees its tracks. */
  releaseMic(): void;
  /** Queues agent voice (PCM16 mono 24 kHz) for gapless playback. */
  playPcm16(data: ArrayBuffer): void;
  /** Speaks text with the browser's speech synthesis. */
  speak(text: string): void;
  /** Drops all queued and in-flight agent audio (barge-in). */
  clearPlayback(): void;
  /** Current meter levels, 0..1. */
  levels(): { mic: number; output: number };
  /** Resumes suspended audio. Call from a user gesture. Resolves to whether audio is running. */
  resume(): Promise<boolean>;
  /** Releases everything. */
  close(): void;
}

/** Options for {@link createBrowserAudio}. */
export type BrowserAudioOptions = {
  audioContext?: AudioContext;
  language?: string;
  voice?: VoiceGender;
  /** Called when agent audio starts or finishes playing. */
  onPlayingChange(playing: boolean): void;
  /** Called when the browser keeps audio suspended (`true`) and when it runs again (`false`). */
  onBlockedChange?(blocked: boolean): void;
};

/**
 * AudioWorklet processor source. Downsamples to 16 kHz with a streaming
 * box-average, emits 320-sample PCM16 frames, and reports a smoothed RMS level.
 * Inlined and loaded through a Blob URL so the SDK needs no extra file.
 */
const WORKLET_SOURCE = `
const TARGET_RATE = 16000;
const FRAME_SAMPLES = ${FRAME_SAMPLES};
const LEVEL_EVERY = 8;
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.windowRemaining = this.ratio;
    this.sum = 0;
    this.weight = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.fill = 0;
    this.level = 0;
    this.counter = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    let squares = 0;
    for (let i = 0; i < channel.length; i += 1) squares += channel[i] * channel[i];
    this.level = this.level * 0.68 + Math.min(1, Math.sqrt(squares / channel.length) * 6) * 0.32;
    this.counter += 1;
    if (this.counter >= LEVEL_EVERY) {
      this.counter = 0;
      this.port.postMessage({ type: "level", value: this.level });
    }
    for (let index = 0; index < channel.length; index += 1) {
      let inputRemaining = 1;
      while (inputRemaining > 0) {
        const w = Math.min(inputRemaining, this.windowRemaining);
        this.sum += channel[index] * w;
        this.weight += w;
        inputRemaining -= w;
        this.windowRemaining -= w;
        if (this.windowRemaining <= 1e-9) {
          const avg = this.weight > 0 ? this.sum / this.weight : 0;
          const s = Math.max(-1, Math.min(1, avg));
          this.frame[this.fill++] = s < 0 ? s * 0x8000 : s * 0x7fff;
          this.windowRemaining = this.ratio;
          this.sum = 0;
          this.weight = 0;
          if (this.fill === FRAME_SAMPLES) {
            const out = this.frame;
            this.port.postMessage({ type: "frame", pcm: out.buffer }, [out.buffer]);
            this.frame = new Int16Array(FRAME_SAMPLES);
            this.fill = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCaptureProcessor);
`;

const PLAYBACK_GAIN = 2;
const LOCALES: Record<string, string> = { zh: "zh-CN", en: "en-US" };

type WorkletMessage = { type: "frame"; pcm: ArrayBuffer } | { type: "level"; value: number };

/** Creates the real browser implementation of {@link AudioIO}. */
export function createBrowserAudio(options: BrowserAudioOptions): AudioIO {
  let micContext: AudioContext | undefined;
  let ownsMicContext = false;
  let stream: MediaStream | undefined;
  let micNodes: AudioNode[] = [];
  let micLevel = 0;
  let micGeneration = 0;
  let micSetup: Promise<void> | undefined;

  let playContext: AudioContext | undefined;
  let ownsPlayContext = false;
  let gain: GainNode | undefined;
  let analyser: AnalyserNode | undefined;
  let analyserBuffer: Float32Array<ArrayBuffer> | undefined;
  let cursor = 0;
  let sources: AudioBufferSourceNode[] = [];
  let speaking = false;
  let playing = false;

  const setPlaying = () => {
    const next = sources.length > 0 || speaking;
    if (next === playing) return;
    playing = next;
    options.onPlayingChange(next);
  };

  let blocked = false;
  // Set by close(): a late timer or statechange must not report to a client that is gone.
  let closed = false;
  const setBlocked = (next: boolean) => {
    if (closed || next === blocked) return;
    blocked = next;
    options.onBlockedChange?.(next);
  };
  // A context that runs again, for any reason, clears the warning. The
  // listeners are removed on close: a page may hand in a context that outlives
  // this client, and a listener left on it would keep the client in memory.
  const watched: Array<() => void> = [];
  const watching = new Set<AudioContext>();
  const watch = (context: AudioContext) => {
    if (closed || !context.addEventListener || watching.has(context)) return;
    watching.add(context);
    const onStateChange = () => {
      if (context.state === "running") setBlocked(false);
    };
    context.addEventListener("statechange", onStateChange);
    watched.push(() => {
      context.removeEventListener?.("statechange", onStateChange);
      watching.delete(context);
    });
  };

  const ensurePlayContext = (): AudioContext => {
    if (playContext && playContext.state !== "closed") return playContext;
    if (options.audioContext) {
      playContext = options.audioContext;
      ownsPlayContext = false;
    } else {
      playContext = new AudioContext({ sampleRate: DOWNLINK_SAMPLE_RATE });
      ownsPlayContext = true;
    }
    const ctx = playContext;
    watch(ctx);
    gain = ctx.createGain();
    gain.gain.value = PLAYBACK_GAIN;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.05;
    gain.connect(limiter);
    limiter.connect(ctx.destination);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyserBuffer = new Float32Array(analyser.fftSize);
    limiter.connect(analyser);
    cursor = 0;
    return ctx;
  };

  const buildMic = async (onFrame: (pcm: ArrayBuffer) => void): Promise<void> => {
    const generation = micGeneration;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot access a microphone");
    const media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } }
    });
    if (generation !== micGeneration) {
      media.getTracks().forEach((track) => track.stop());
      throw new Error("Microphone released while starting");
    }
    let context: AudioContext | undefined;
    let owns = false;
    const nodes: AudioNode[] = [];
    try {
      if (options.audioContext) context = options.audioContext;
      else {
        context = new AudioContext();
        owns = true;
      }
      // The microphone's context can be a different one from playback's, and
      // can be the one the browser keeps suspended.
      watch(context);
      if (context.state === "suspended") await resumeWithin(context, () => setBlocked(true));
      const source = context.createMediaStreamSource(media);
      nodes.push(source);
      if (context.audioWorklet && typeof Blob !== "undefined" && typeof URL.createObjectURL === "function") {
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
        try {
          await context.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        const node = new AudioWorkletNode(context, "pcm-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: "explicit"
        });
        node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
          if (event.data.type === "frame") onFrame(event.data.pcm);
          else micLevel = event.data.value;
        };
        nodes.push(node);
      } else {
        const framer = new PcmFramer(context.sampleRate);
        const node = context.createScriptProcessor(2048, 1, 1);
        node.onaudioprocess = (event) => {
          const block = event.inputBuffer.getChannelData(0);
          micLevel = micLevel * 0.5 + meterLevel(rms(block)) * 0.5;
          for (const frame of framer.push(block)) onFrame(frame.buffer as ArrayBuffer);
        };
        nodes.push(node);
      }
      if (generation !== micGeneration) throw new Error("Microphone released while starting");
      // The capture node must reach a destination to be pulled; its output is silent.
      source.connect(nodes[1]!);
      nodes[1]!.connect(context.destination);
      stream = media;
      micContext = context;
      ownsMicContext = owns;
      micNodes = nodes;
    } catch (error) {
      media.getTracks().forEach((track) => track.stop());
      for (const node of nodes) {
        try {
          node.disconnect();
        } catch {
          /* never attached */
        }
      }
      if (owns && context && context.state !== "closed") await context.close().catch(() => undefined);
      throw error;
    }
  };

  const speak = (text: string) => {
    if (typeof speechSynthesis === "undefined" || !text.trim()) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const lang = options.language ? (LOCALES[options.language] ?? options.language) : undefined;
    if (lang) utterance.lang = lang;
    if (options.voice === "male") utterance.pitch = 0.8;
    const finish = () => {
      speaking = false;
      setPlaying();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    speaking = true;
    setPlaying();
    speechSynthesis.speak(utterance);
  };

  return {
    async prepare() {
      const ctx = ensurePlayContext();
      if (ctx.state === "suspended") await resumeWithin(ctx, () => setBlocked(true));
    },
    async resume() {
      const contexts = [playContext, micContext].filter((c): c is AudioContext => c !== undefined);
      await Promise.all(contexts.map((c) => (c.state === "suspended" ? c.resume().catch(() => undefined) : undefined)));
      const running = contexts.every((c) => c.state === "running");
      if (running) setBlocked(false);
      return running;
    },
    startMic(onFrame) {
      if (stream) return Promise.resolve();
      micSetup ??= buildMic(onFrame).catch((error: unknown) => {
        micSetup = undefined;
        throw error;
      });
      return micSetup;
    },
    setMicEnabled(enabled) {
      stream?.getAudioTracks().forEach((track) => (track.enabled = enabled));
      if (!enabled) micLevel = 0;
    },
    releaseMic() {
      micGeneration += 1;
      micSetup = undefined;
      for (const node of micNodes) {
        if (node instanceof AudioWorkletNode) node.port.onmessage = null;
        if ("onaudioprocess" in node) (node as ScriptProcessorNode).onaudioprocess = null;
        try {
          node.disconnect();
        } catch {
          /* already detached */
        }
      }
      micNodes = [];
      stream?.getTracks().forEach((track) => track.stop());
      stream = undefined;
      if (micContext && ownsMicContext && micContext.state !== "closed") void micContext.close();
      micContext = undefined;
      micLevel = 0;
    },
    playPcm16(data) {
      if (!data.byteLength || data.byteLength % 2 !== 0) return;
      const samples = pcm16ToFloat32(new Int16Array(data));
      const ctx = ensurePlayContext();
      const buffer = ctx.createBuffer(1, samples.length, DOWNLINK_SAMPLE_RATE);
      buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain!);
      if (ctx.state === "suspended") {
        void ctx.resume().catch(() => undefined);
        // Audio queued while suspended is silent; surface it if the page never gets the gesture.
        setTimeout(() => {
          if (ctx.state === "suspended") setBlocked(true);
        }, 1000);
      }
      source.onended = () => {
        sources = sources.filter((item) => item !== source);
        setPlaying();
      };
      sources.push(source);
      const startAt = Math.max(ctx.currentTime, cursor);
      source.start(startAt);
      cursor = startAt + buffer.duration;
      setPlaying();
    },
    speak,
    clearPlayback() {
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
      speaking = false;
      for (const source of sources) {
        try {
          source.onended = null;
          source.stop();
        } catch {
          /* already finished */
        }
      }
      sources = [];
      if (playContext) cursor = playContext.currentTime;
      setPlaying();
    },
    levels() {
      let output = 0;
      if (analyser && analyserBuffer && sources.length > 0) {
        analyser.getFloatTimeDomainData(analyserBuffer);
        output = meterLevel(rms(analyserBuffer));
      }
      return { mic: micLevel, output };
    },
    close() {
      this.releaseMic();
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
      sources = [];
      speaking = false;
      closed = true;
      for (const unwatch of watched.splice(0)) unwatch();
      if (playContext && ownsPlayContext && playContext.state !== "closed") void playContext.close();
      playContext = undefined;
      gain = undefined;
      analyser = undefined;
      cursor = 0;
      setPlaying();
    }
  };
}
