import {
  REQUIRED_FIXTURES,
  validateManifest,
  validateWarningManifest,
  verifyFixture,
  type FixtureManifest,
  type WarningAsset
} from "./fixtures";
import type { Observation } from "./assertions";
import { closeForSyntheticOutage } from "./outage";
export const observations: Observation[] = [];
const listeners = new Set<() => void>();
export function observe(type: string, fields: Record<string, unknown> = {}) {
  observations.push({ at: Date.now(), type, ...fields });
  listeners.forEach((listener) => listener());
}
export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
let blockedUntil = 0;
let socket: WebSocket | null = null;
let streamContext: AudioContext | null = null;
let destination: MediaStreamAudioDestinationNode | null = null;
let cancelFixture: (() => void) | null = null;
const NativeAudioContext = window.AudioContext;
const active = new Set<AudioBufferSourceNode>();
const captureContexts = new Set<AudioContext>();
const sourceIds = new WeakMap<AudioBufferSourceNode, number>();
let sourceSerial = 0;
let utteranceSerial = 0;
const warningAssets = new Map<string, WarningAsset>();
const warningSources = new WeakSet<AudioBufferSourceNode>();
async function sha256(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
const playback = {
  started: 0,
  ended: 0,
  stopped: 0,
  active: 0,
  contextState: "none",
  speechStarted: 0,
  speechRequested: 0,
  speechCancelled: 0
};
class ObservedAudioContext extends NativeAudioContext {
  private playbackContext: boolean;
  constructor(options?: AudioContextOptions) {
    super(options);
    this.playbackContext = options?.sampleRate === 24000;
    if (!this.playbackContext) {
      captureContexts.add(this);
      this.addEventListener("statechange", () => {
        if (this.state === "closed") captureContexts.delete(this);
      });
    }
    if (this.playbackContext) {
      playback.contextState = this.state;
      observe("playback.context", { state: this.state });
      this.addEventListener("statechange", () => {
        playback.contextState = this.state;
        observe("playback.state", { state: this.state });
      });
    }
  }
  override createBufferSource() {
    const source = super.createBufferSource();
    if (this.playbackContext) {
      const sourceId = ++sourceSerial;
      sourceIds.set(source, sourceId);
      let interrupted = false;
      let warning = false;
      let ended = false;
      let analyser: AnalyserNode | null = null;
      const connect = source.connect.bind(source);
      source.connect = ((destination: AudioNode, output?: number, input?: number) => {
        if (!Reflect.get(source, Symbol.for("max.warningAudio"))) return connect(destination, output, input);
        analyser ??= this.createAnalyser();
        analyser.fftSize = 2048;
        connect(analyser, output);
        return analyser.connect(destination, 0, input);
      }) as typeof source.connect;
      const start = source.start.bind(source);
      const stop = source.stop.bind(source);
      source.start = (...args: Parameters<AudioBufferSourceNode["start"]>) => {
        const metadata = Reflect.get(source, Symbol.for("max.warningAudio")) as WarningAsset | undefined;
        warning = !!metadata;
        if (warning) warningSources.add(source);
        start(...args);
        active.add(source);
        playback.started++;
        playback.active = active.size;
        observe(warning ? "warning.audio.scheduled" : "playback.start", {
          sourceId,
          samples: source.buffer?.length,
          duration: source.buffer?.duration,
          active: active.size,
          state: this.state,
          ...(metadata ? { text: metadata.text, url: metadata.url, pcmSha256: metadata.pcmSha256 } : {})
        });
        if (metadata && source.buffer) {
          const buffer = source.buffer;
          const values = buffer.getChannelData(0);
          const pcm = new DataView(new ArrayBuffer(values.length * 2));
          values.forEach((value, index) =>
            pcm.setInt16(index * 2, Math.max(-32768, Math.min(32767, Math.round(value * 32768))), true)
          );
          void sha256(pcm.buffer as ArrayBuffer).then((hash) => {
            const expected = warningAssets.get(metadata.url);
            observe("warning.audio.verified", {
              sourceId,
              pcmSha256: hash,
              matchesManifest:
                !!expected &&
                expected.text === metadata.text &&
                expected.pcmSha256 === hash &&
                expected.samples === values.length &&
                buffer.sampleRate === 24000 &&
                buffer.numberOfChannels === 1
            });
          });
          const samples = new Float32Array(analyser?.fftSize ?? 2048);
          const inspectRender = () => {
            if (ended || interrupted || this.state === "closed") return;
            analyser?.getFloatTimeDomainData(samples);
            const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
            if (this.state === "running" && peak > 0)
              observe("warning.audio.rendered", { sourceId, peak, state: this.state });
            else requestAnimationFrame(inspectRender);
          };
          requestAnimationFrame(inspectRender);
        }
      };
      source.stop = (...args: Parameters<AudioBufferSourceNode["stop"]>) => {
        stop(...args);
        if (active.delete(source)) {
          interrupted = true;
          playback.stopped++;
          playback.active = active.size;
          observe(warning ? "warning.audio.stop" : "playback.stop", { sourceId, active: active.size });
        }
      };
      source.addEventListener("ended", () => {
        ended = true;
        active.delete(source);
        playback.ended++;
        playback.active = active.size;
        observe(warning ? "warning.audio.ended" : "playback.ended", { sourceId, interrupted, active: active.size });
        analyser?.disconnect();
      });
    }
    return source;
  }
}
window.AudioContext = ObservedAudioContext;
if ("speechSynthesis" in window) {
  const speak = window.speechSynthesis.speak.bind(window.speechSynthesis);
  const cancel = window.speechSynthesis.cancel.bind(window.speechSynthesis);
  window.speechSynthesis.speak = (utterance) => {
    const utteranceId = ++utteranceSerial;
    playback.speechRequested++;
    observe("speech.request", { utteranceId, text: utterance.text });
    utterance.addEventListener("start", () => {
      playback.speechStarted++;
      observe("speech.start", { utteranceId, text: utterance.text });
    });
    utterance.addEventListener("end", () => observe("speech.end", { utteranceId }));
    utterance.addEventListener("error", (event) => observe("speech.error", { utteranceId, error: event.error }));
    speak(utterance);
  };
  window.speechSynthesis.cancel = () => {
    const wasSpeaking = window.speechSynthesis.speaking;
    playback.speechCancelled++;
    observe("speech.cancel", { wasSpeaking });
    cancel();
  };
}
export async function acquireSyntheticStream(_constraints?: MediaStreamConstraints): Promise<MediaStream> {
  void _constraints;
  if (
    streamContext &&
    streamContext.state !== "closed" &&
    destination?.stream.getTracks().some((track) => track.readyState === "live")
  )
    return destination.stream;
  if (streamContext && streamContext.state !== "closed") await streamContext.close();
  streamContext = new NativeAudioContext({ sampleRate: 16000 });
  destination = streamContext.createMediaStreamDestination();
  const silence = streamContext.createBufferSource();
  silence.buffer = streamContext.createBuffer(1, 16000, 16000);
  silence.loop = true;
  silence.connect(destination);
  silence.start();
  await streamContext.resume();
  observe("synthetic.capture.created", {
    sampleRate: streamContext.sampleRate,
    tracks: destination.stream.getTracks().length
  });
  const ownedContext = streamContext;
  destination.stream.getTracks().forEach((track) =>
    track.addEventListener("ended", () => {
      void ownedContext.close();
      observe("synthetic.capture.ended");
    })
  );
  return destination.stream;
}
export async function releaseSyntheticContext() {
  cancelFixture?.();
  cancelFixture = null;
  if (streamContext && streamContext.state !== "closed") await streamContext.close();
  destination = null;
  streamContext = null;
  observe("synthetic.context.released");
}
const verifiedFixtures = new Map<string, ArrayBuffer>();
let verifiedManifest: FixtureManifest | null = null;
let cohort = "synthetic-standard";
export function syntheticNetworkType() {
  return cohort;
}
export function setSyntheticCohort(
  caseId: string,
  context: { networkCohorts?: { standard?: string; wind?: string; degraded?: string } }
) {
  cohort =
    caseId === "wind-noise-robustness"
      ? context.networkCohorts?.wind || "synthetic-wind-12db"
      : caseId === "degraded-network-recovery"
        ? context.networkCohorts?.degraded || "synthetic-degraded-outage"
        : context.networkCohorts?.standard || "synthetic-standard";
  observe("synthetic.cohort", { networkType: cohort });
}
export async function preflightFixtures(): Promise<void> {
  verifiedFixtures.clear();
  verifiedManifest = null;
  resetObservations();
  observe("fixtures.preflight.started");
  const response = await fetch("/qa-manifest");
  if (!response.ok) throw new Error("Fixture manifest unavailable");
  const manifest = validateManifest(await response.json());
  for (const name of REQUIRED_FIXTURES) {
    const fixture = manifest.fixtures[name]!;
    const response = await fetch(`/qa-fixture/${fixture.file}`);
    if (!response.ok) throw new Error(`Missing fixture: ${name}`);
    const data = await response.arrayBuffer();
    await verifyFixture(fixture, data);
    verifiedFixtures.set(name, data);
  }
  verifiedManifest = manifest;
  warningAssets.clear();
  const warningResponse = await fetch("/audio/adas/manifest.json");
  if (!warningResponse.ok) throw new Error("Canonical warning audio manifest unavailable");
  const assets = validateWarningManifest(await warningResponse.json());
  for (const asset of assets) {
    const response = await fetch(asset.url);
    if (!response.ok || (await sha256(await response.arrayBuffer())) !== asset.sha256)
      throw new Error("Canonical warning asset hash mismatch");
    warningAssets.set(asset.url, asset);
  }
  observe("warning.assets.preflight", { assets: warningAssets.size });
  observe("fixtures.preflight.complete", {
    fixtures: REQUIRED_FIXTURES.length,
    sampleRate: 16000,
    channels: 1,
    format: "s16le"
  });
}
export async function playFixture(name: string): Promise<void> {
  if (!streamContext || !destination) throw new Error("Start production hands-free before emitting fixture");
  const fixture = verifiedManifest?.fixtures[name];
  const data = verifiedFixtures.get(name);
  if (!fixture || !data) throw new Error("Fixture has not passed preflight");
  const hash = fixture.sha256;
  const values = new Int16Array(data);
  const buffer = streamContext.createBuffer(1, values.length, 16000);
  const channel = buffer.getChannelData(0);
  values.forEach((value, index) => (channel[index] = value / 32768));
  const source = streamContext.createBufferSource();
  source.buffer = buffer;
  source.connect(destination);
  observe("fixture.start", {
    name,
    sha256: hash,
    durationSeconds: buffer.duration,
    text: fixture.text,
    bytes: data.byteLength
  });
  return new Promise((resolve) => {
    cancelFixture = () => {
      observe("fixture.cancelled", { name });
      resolve();
    };
    source.addEventListener("ended", () => {
      cancelFixture = null;
      observe("fixture.end", { name });
      resolve();
    });
    source.start();
  });
}
export function createAgentSocket(): WebSocket {
  const blocked = Date.now() < blockedUntil;
  const next = new WebSocket(`ws://${window.location.host}/${blocked ? "qa-blocked" : "agent"}`);
  socket = next;
  observe("socket.created", { blocked });
  next.binaryType = "arraybuffer";
  next.addEventListener("open", () => observe("socket.open", { blocked }));
  next.addEventListener("close", (event) =>
    observe("socket.close", { code: event.code, reason: event.reason, wasClean: event.wasClean })
  );
  next.addEventListener("error", () => observe("socket.error", { blocked }));
  next.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      observe("audio.received", { bytes: event.data.byteLength });
      return;
    }
    try {
      const payload = JSON.parse(event.data);
      observe("relay.event", {
        event: payload,
        ...(payload.type === "hazard.alert" ? { playbackBefore: currentPlayback() } : {})
      });
    } catch {
      observe("relay.invalid");
    }
  });
  const send = next.send.bind(next);
  let frames = 0;
  next.send = (data) => {
    if (typeof data === "string") {
      observe("client.event", { event: JSON.parse(data) });
    } else {
      frames++;
      if (frames % 50 === 0)
        observe("capture.frames", { frames, bytes: data instanceof ArrayBuffer ? data.byteLength : 0 });
    }
    send(data);
  };
  return next;
}
export function injectOutage(durationMs = 4500) {
  blockedUntil = Date.now() + durationMs;
  observe("outage.start", { durationMs });
  if (socket) closeForSyntheticOutage(socket);
  window.setTimeout(() => observe("outage.end"), durationMs);
}
export function resetObservations() {
  observations.length = 0;
  observe("case.reset");
  observe("fixtures.preflight.current", {
    allVerified: verifiedFixtures.size === REQUIRED_FIXTURES.length,
    fixtures: [...verifiedFixtures.keys()]
  });
}
export function currentPlayback() {
  return {
    ...playback,
    active: active.size,
    activeSourceIds: [...active].map((source) => sourceIds.get(source)!),
    activeProviderSourceIds: [...active]
      .filter((source) => !warningSources.has(source))
      .map((source) => sourceIds.get(source)!),
    browserSpeaking: window.speechSynthesis?.speaking ?? false
  };
}

export function currentCaptureResources() {
  const productionContexts = [...captureContexts].filter((context) => context.state !== "closed").length;
  const syntheticContextRunning = !!streamContext && streamContext.state !== "closed";
  const liveSyntheticTracks =
    destination?.stream.getTracks().filter((track) => track.readyState === "live").length ?? 0;
  return {
    productionContexts,
    syntheticContextRunning,
    liveSyntheticTracks,
    captureActive: productionContexts > 0 || syntheticContextRunning || liveSyntheticTracks > 0
  };
}
