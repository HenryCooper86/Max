import manifest from "../../public/audio/adas/manifest.json";
import type { VoiceGender } from "../types";
import { decodeWarningWav } from "./warning-wav";

/** Diagnostic identity only: QA verifies the actual buffer/rendered samples. */
export const WARNING_AUDIO_SOURCE = Symbol.for("max.warningAudio");
type WarningClip = (typeof manifest.assets)[number];
type WarningAudioResult = "scheduled" | "unknown" | "unavailable" | "cancelled";

export function getWarningClip(text: string, gender: VoiceGender): WarningClip | undefined {
  return manifest.assets.find((asset) => asset.text === text && asset.gender === gender);
}

/** The finite safety vocabulary is independent of the browser's TTS backend.
 * Loading/decoding happens at playback unlock; cancellation never starts a new
 * context or lets a late load resurrect speech after barge-in or teardown. */
export function createWarningAudioPlayer(
  options: {
    fetchImpl?: typeof fetch;
    onEnded?: () => void;
  } = {}
) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const buffers = new Map<string, AudioBuffer>();
  const loading = new Map<string, Promise<AudioBuffer | undefined>>();
  let loadGeneration = 0;
  let generation = 0;
  let abort = new AbortController();
  let active = false;
  let source: AudioBufferSourceNode | null = null;

  function load(context: AudioContext, clip: WarningClip): Promise<AudioBuffer | undefined> {
    const ready = buffers.get(clip.url);
    if (ready) return Promise.resolve(ready);
    const pending = loading.get(clip.url);
    if (pending) return pending;
    const owner = loadGeneration;
    const request = new AbortController();
    const lifetime = abort.signal;
    const cancel = () => request.abort();
    lifetime.addEventListener("abort", cancel, { once: true });
    const timeout = globalThis.setTimeout(cancel, 5000);
    const signal = request.signal;
    const isCurrent = () => owner === loadGeneration && !signal.aborted && context.state !== "closed";
    const result = (async () => {
      try {
        const response = await fetchImpl(clip.url, { signal, cache: "force-cache" });
        if (!response.ok) return undefined;
        const bytes = await response.arrayBuffer();
        if (!isCurrent()) return undefined;
        const decoded = decodeWarningWav(context, bytes, clip.samples);
        if (!isCurrent()) return undefined;
        buffers.set(clip.url, decoded);
        return decoded;
      } catch {
        return undefined;
      } finally {
        globalThis.clearTimeout(timeout);
        lifetime.removeEventListener("abort", cancel);
      }
    })();
    const settled = result.finally(() => {
      // A timeout must not poison every retry. A late old load must also not
      // remove a newer session's in-flight request for the same clip.
      if (owner === loadGeneration && loading.get(clip.url) === settled) loading.delete(clip.url);
    });
    loading.set(clip.url, settled);
    return settled;
  }

  function stop() {
    generation += 1;
    active = false;
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* already ended */
    }
    source.disconnect();
    source = null;
  }

  function schedule(
    context: AudioContext,
    clip: WarningClip,
    buffer: AudioBuffer,
    output: AudioNode,
    owner: number,
    onScheduled?: (startAt: number, duration: number) => void,
    requestedStart?: number
  ): WarningAudioResult {
    if (owner !== generation) return "cancelled";
    if (context.state !== "running") {
      active = false;
      return "unavailable";
    }
    try {
      const current = context.createBufferSource();
      source = current;
      current.buffer = buffer;
      Object.defineProperty(current, WARNING_AUDIO_SOURCE, {
        value: Object.freeze({
          ...clip,
          sampleRate: manifest.sampleRate,
          channels: manifest.channels,
          sampleFormat: manifest.sampleFormat
        })
      });
      current.connect(output);
      current.onended = () => {
        current.disconnect();
        if (owner !== generation || source !== current) return;
        source = null;
        active = false;
        options.onEnded?.();
      };
      const startAt = Math.max(context.currentTime, requestedStart ?? context.currentTime);
      current.start(startAt);
      onScheduled?.(startAt, buffer.duration);
      return "scheduled";
    } catch {
      stop();
      return "unavailable";
    }
  }

  return {
    async preload(context: AudioContext): Promise<boolean> {
      const loaded = await Promise.all(manifest.assets.map((clip) => load(context, clip)));
      return loaded.every(Boolean);
    },
    play(
      context: AudioContext,
      text: string,
      gender: VoiceGender,
      output: AudioNode,
      onScheduled?: (startAt: number, duration: number) => void,
      requestedStart?: number
    ): Promise<WarningAudioResult> {
      const clip = getWarningClip(text, gender);
      if (!clip) return Promise.resolve("unknown");
      stop();
      const owner = generation;
      active = true;
      // Preserve synchronous scheduling for already-warm safety clips.
      const ready = buffers.get(clip.url);
      if (ready) return Promise.resolve(schedule(context, clip, ready, output, owner, onScheduled, requestedStart));
      return load(context, clip).then((buffer) => {
        if (owner !== generation) return "cancelled";
        if (!buffer) {
          active = false;
          return "unavailable";
        }
        return schedule(context, clip, buffer, output, owner, onScheduled, requestedStart);
      });
    },
    stop,
    close() {
      stop();
      loadGeneration += 1;
      abort.abort();
      abort = new AbortController();
      buffers.clear();
      loading.clear();
    },
    isActive: () => active
  };
}
