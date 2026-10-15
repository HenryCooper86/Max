import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export type NativeLong = string | number;
export type WarningClipIdentity = {
  threat: string;
  text: string;
  gender: string;
  wavSha256: string;
  pcmSha256: string;
  samples: number;
};
export type WarningRequest = {
  sessionEpoch: NativeLong;
  hazardGeneration: number;
  clip: WarningClipIdentity;
  playbackEpoch: NativeLong;
  playbackGeneration: number;
  requestedAtNanos: NativeLong;
};
type WarningProgress = {
  playbackEpoch: NativeLong;
  playbackGeneration: number;
  writtenSamples: number;
  hardwarePlayedSamples: number;
  firstNonzeroSample: number;
  actualWrittenPcmSha256: string;
  expectedWrittenPcmSha256: string;
  actualWrittenPcmBase64: string;
  outputGain: number;
  observedAtNanos: NativeLong;
};
export type WarningRenderProof = { request: WarningRequest; progress: WarningProgress; capturedAtNanos: NativeLong };
type WarningRetirement = { request: WarningRequest; retiredAtNanos: NativeLong };
export type WarningProofContext = {
  sessionEpoch: NativeLong;
  hazardGeneration: number;
  clip: WarningClipIdentity;
  observedBeforeNanos: NativeLong;
  currentRequest: WarningRequest | null;
  retiredRequests: WarningRetirement[];
};
export type TrustedWarningAsset = { identity: WarningClipIdentity; wav: Buffer };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const requireProof: (ok: unknown, reason: string) => asserts ok = (ok, reason) => {
  if (!ok) throw new Error(`Warning render proof rejected: ${reason}`);
};
const integer = (n: number, min = 0) => Number.isSafeInteger(n) && n >= min;
const nativeLong = (n: NativeLong): bigint => {
  requireProof(
    (typeof n === "string" && /^(?:0|[1-9]\d*)$/.test(n)) || (typeof n === "number" && integer(n)),
    "invalid native epoch/timestamp"
  );
  return BigInt(n);
};
const sameIdentity = (a: WarningClipIdentity, b: WarningClipIdentity) =>
  ["threat", "text", "gender", "wavSha256", "pcmSha256", "samples"].every(
    (k) => a[k as keyof WarningClipIdentity] === b[k as keyof WarningClipIdentity]
  );
const sameRequest = (a: WarningRequest, b: WarningRequest) =>
  nativeLong(a.sessionEpoch) === nativeLong(b.sessionEpoch) &&
  a.hazardGeneration === b.hazardGeneration &&
  sameIdentity(a.clip, b.clip) &&
  nativeLong(a.playbackEpoch) === nativeLong(b.playbackEpoch) &&
  a.playbackGeneration === b.playbackGeneration &&
  nativeLong(a.requestedAtNanos) === nativeLong(b.requestedAtNanos);

/** Independent RIFF/PCM decoding; this never calls the Android production catalog. */
export function decodeWarningWav(wav: Buffer, samples: number): Buffer {
  requireProof(
    integer(samples, 1) &&
      wav.length >= 12 &&
      wav.toString("ascii", 0, 4) === "RIFF" &&
      wav.toString("ascii", 8, 12) === "WAVE" &&
      wav.readUInt32LE(4) + 8 === wav.length,
    "invalid source WAV"
  );
  let at = 12,
    format = false,
    pcm: Buffer | undefined;
  while (at < wav.length) {
    requireProof(at + 8 <= wav.length, "truncated WAV chunk");
    const size = wav.readUInt32LE(at + 4),
      start = at + 8,
      end = start + size;
    requireProof(end + (size % 2) <= wav.length, "WAV chunk exceeds file");
    const tag = wav.toString("ascii", at, at + 4);
    if (tag === "fmt ") {
      requireProof(
        !format &&
          size >= 16 &&
          wav.readUInt16LE(start) === 1 &&
          wav.readUInt16LE(start + 2) === 1 &&
          wav.readUInt32LE(start + 4) === 24000 &&
          wav.readUInt32LE(start + 8) === 48000 &&
          wav.readUInt16LE(start + 12) === 2 &&
          wav.readUInt16LE(start + 14) === 16,
        "unsupported warning PCM format"
      );
      format = true;
    } else if (tag === "data") {
      requireProof(!pcm && size === samples * 2, "warning source sample count mismatch");
      pcm = Buffer.from(wav.subarray(start, end));
    }
    at = end + (size % 2);
  }
  requireProof(format && pcm && pcm.some((b) => b !== 0), "missing or silent source PCM");
  return pcm;
}

/** Implements the published gain/limiter contract independently using explicit IEEE float32 steps. */
export function processWarningPcm(pcm: Buffer, gain: number): Buffer {
  requireProof(Number.isFinite(gain) && gain >= 0.5 && gain <= 4, "invalid output gain");
  gain = Math.fround(gain); // JSONObject renders Float with its shortest round-tripping decimal.
  requireProof(pcm.length > 0 && pcm.length % 2 === 0, "invalid source PCM length");
  if (gain === 1) return Buffer.from(pcm);
  const f = Math.fround,
    threshold = f(0.7),
    headroom = f(1 - threshold),
    out = Buffer.alloc(pcm.length);
  for (let at = 0; at < pcm.length; at += 2) {
    const sample = f(f(pcm.readInt16LE(at) / 32768) * gain),
      magnitude = Math.abs(sample);
    const limited =
      magnitude <= threshold
        ? sample
        : (sample < 0 ? -1 : 1) *
          f(threshold + f(headroom * f(1 - f(Math.exp(-f(f(magnitude - threshold) / headroom))))));
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.trunc(f(limited * 32767)))), at);
  }
  return out;
}

/** Trusted identities are independently loaded from the repository's canonical asset manifest. */
export function loadCanonicalWarningAssets(directory: string): TrustedWarningAsset[] {
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")) as {
    version: number;
    sampleRate: number;
    channels: number;
    sampleFormat: string;
    assets: Array<{
      threat: string;
      text: string;
      gender: string;
      file: string;
      sha256: string;
      pcmSha256: string;
      samples: number;
    }>;
  };
  requireProof(
    manifest.version === 1 &&
      manifest.sampleRate === 24000 &&
      manifest.channels === 1 &&
      manifest.sampleFormat === "s16le" &&
      manifest.assets.length === 18,
    "canonical warning manifest shape"
  );
  const threats = new Set([
      "rear_approach",
      "forward_collision",
      "left_blind_spot",
      "right_blind_spot",
      "lane_departure",
      "left_cross_traffic",
      "right_cross_traffic",
      "pedestrian_ahead",
      "tailgating"
    ]),
    keys = new Set<string>();
  const assets = manifest.assets.map((a) => {
    requireProof(
      threats.has(a.threat) &&
        ["male", "female"].includes(a.gender) &&
        a.text.trim() &&
        a.file === `${a.gender}/${a.threat}.wav` &&
        !keys.has(a.file),
      "unknown or duplicate canonical warning"
    );
    keys.add(a.file);
    const identity = {
        threat: a.threat,
        text: a.text,
        gender: a.gender,
        wavSha256: a.sha256,
        pcmSha256: a.pcmSha256,
        samples: a.samples
      },
      wav = readFileSync(path.join(directory, a.file));
    requireProof(
      hash(wav) === a.sha256 && hash(decodeWarningWav(wav, a.samples)) === a.pcmSha256,
      "canonical source asset hash mismatch"
    );
    return { identity, wav };
  });
  for (const threat of threats)
    requireProof(
      new Set(assets.filter((a) => a.identity.threat === threat).map((a) => a.identity.text)).size === 1,
      "gender warning text mismatch"
    );
  return assets;
}

export function verifyWarningRenderProof(
  proof: WarningRenderProof,
  context: WarningProofContext,
  assets: readonly TrustedWarningAsset[]
) {
  const r = proof.request,
    p = proof.progress;
  requireProof(
    nativeLong(r.sessionEpoch) > 0n &&
      nativeLong(r.sessionEpoch) === nativeLong(context.sessionEpoch) &&
      r.hazardGeneration === context.hazardGeneration &&
      integer(r.hazardGeneration, 1),
    "stale session or wrong hazard generation"
  );
  requireProof(sameIdentity(r.clip, context.clip), "warning identity differs from exact provider-cut hazard");
  const trusted = assets.find((a) => sameIdentity(a.identity, r.clip));
  requireProof(trusted, "untrusted warning identity");
  requireProof(hash(trusted.wav) === r.clip.wavSha256, "source WAV hash mismatch");
  const source = decodeWarningWav(trusted.wav, r.clip.samples);
  requireProof(hash(source) === r.clip.pcmSha256, "source PCM hash mismatch");
  requireProof(
    nativeLong(r.playbackEpoch) > 0n &&
      nativeLong(r.playbackEpoch) === nativeLong(p.playbackEpoch) &&
      integer(r.playbackGeneration) &&
      r.playbackGeneration === p.playbackGeneration,
    "wrong playback epoch/generation"
  );
  requireProof(
    integer(p.writtenSamples, 1) &&
      p.writtenSamples <= r.clip.samples &&
      integer(p.hardwarePlayedSamples, 1) &&
      p.hardwarePlayedSamples <= p.writtenSamples,
    "hardware/accepted write count mismatch"
  );
  requireProof(
    typeof p.actualWrittenPcmBase64 === "string" &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.actualWrittenPcmBase64),
    "missing actual accepted write bytes"
  );
  const actual = Buffer.from(p.actualWrittenPcmBase64, "base64");
  requireProof(
    actual.length === p.writtenSamples * 2 && actual.toString("base64") === p.actualWrittenPcmBase64,
    "accepted prefix length/base64 mismatch"
  );
  const processed = processWarningPcm(source, p.outputGain),
    expected = processed.subarray(0, actual.length),
    expectedHash = hash(expected);
  requireProof(
    actual.equals(expected) &&
      hash(actual) === p.actualWrittenPcmSha256 &&
      expectedHash === p.expectedWrittenPcmSha256 &&
      /^[0-9a-f]{64}$/.test(p.actualWrittenPcmSha256),
    "actual write bytes or hashes differ from independently processed source prefix"
  );
  let first = -1,
    playedNonzero = 0;
  for (let i = 0; i < expected.length / 2; i++) {
    if (expected.readInt16LE(i * 2) !== 0) {
      if (first < 0) first = i;
      if (i < p.hardwarePlayedSamples) playedNonzero++;
    }
  }
  requireProof(
    first >= 0 && first === p.firstNonzeroSample && p.hardwarePlayedSamples > first && playedNonzero > 0,
    "hardware did not pass independently verified nonzero PCM"
  );
  const requested = nativeLong(r.requestedAtNanos),
    observed = nativeLong(p.observedAtNanos),
    captured = nativeLong(proof.capturedAtNanos),
    snapshot = nativeLong(context.observedBeforeNanos);
  requireProof(
    requested > 0n && requested <= observed && observed <= captured && captured <= snapshot,
    "invalid render observation ordering"
  );
  const retired = context.retiredRequests.filter((x) => sameRequest(x.request, r));
  requireProof(retired.length <= 1, "ambiguous retirement ownership");
  if (retired.length)
    requireProof(captured < nativeLong(retired[0]!.retiredAtNanos), "render first observed after supersession");
  else
    requireProof(
      context.currentRequest && sameRequest(context.currentRequest, r),
      "no current or retired request owns progress"
    );
  return {
    verified: true as const,
    sessionEpoch: r.sessionEpoch,
    hazardGeneration: r.hazardGeneration,
    playbackEpoch: r.playbackEpoch,
    playbackGeneration: r.playbackGeneration,
    firstNonzeroSample: first,
    hardwarePlayedNonzeroSamples: playedNonzero,
    verifiedPrefixSha256: expectedHash,
    writtenSamples: p.writtenSamples,
    hardwarePlayedSamples: p.hardwarePlayedSamples,
    clip: r.clip
  };
}

type ProviderPlaybackSnapshot = {
  running: boolean;
  queuedSamples: number;
  playbackSamples: number;
  generation: number;
  pendingBuffers: number;
  writtenSamples: number;
  lastFlushSucceeded: boolean;
  totalDiscardedSamples: number;
};
type NativeHazardEvidence = {
  type: string;
  hazardGeneration: number;
  warningSessionEpoch: NativeLong;
  warningText: string;
  warningThreat: string;
  warningGender: string;
  providerPlaybackBefore: ProviderPlaybackSnapshot;
  providerPlaybackAfter: ProviderPlaybackSnapshot;
};
type WarningDiagnostics = {
  sessionEpoch: NativeLong;
  prepared: boolean;
  current: WarningRequest | null;
  snapshotAtNanos: NativeLong;
  output: { active: boolean; running: boolean; pendingBuffers: number };
  proofs: WarningRenderProof[];
  retiredRequests: WarningRetirement[];
};
export type AndroidWarningCaseEvidence = {
  case: string;
  round: number;
  passed: boolean;
  warningEvidenceVersion: number;
  warningPreparedAtReady: boolean;
  warningSessionEpoch: NativeLong;
  warningDiagnosticsBeforeStop: WarningDiagnostics;
  warningDiagnosticsAfterStop: WarningDiagnostics;
  events: NativeHazardEvidence[];
  totalQueuedSamples: number;
  totalPlayedSamples: number;
  adasDiscardedSamples: number;
  sameHazardDiscardedSamples: number;
  unaddressedWarningQueuedSamples?: number;
  unaddressedWarningProofs?: number;
};

/** Replays raw native proof, not the harness's "verified" booleans or TTS request/start counters. */
export function verifyAndroidWarningCase(raw: AndroidWarningCaseEvidence, assets: readonly TrustedWarningAsset[]) {
  requireProof(
    raw.passed === true && raw.warningEvidenceVersion === 2 && raw.warningPreparedAtReady === true,
    "failed/legacy case has no new warning hardware evidence"
  );
  const before = raw.warningDiagnosticsBeforeStop,
    after = raw.warningDiagnosticsAfterStop;
  requireProof(
    before && after && before.prepared && nativeLong(before.sessionEpoch) === nativeLong(raw.warningSessionEpoch),
    "warning session was not prepared/current before production stop"
  );
  requireProof(
    after.prepared === false &&
      after.current === null &&
      after.output.active === false &&
      after.output.running === false &&
      after.output.pendingBuffers === 0,
    "production stop left warning output active"
  );
  if (raw.case === "wake-word-addressed-only")
    requireProof(
      raw.unaddressedWarningQueuedSamples === 0 && raw.unaddressedWarningProofs === 0,
      "unaddressed input rendered or queued bundled warning audio"
    );
  if (raw.case !== "adas-alert-interrupt")
    return { case: raw.case, round: raw.round, verifiedProviderCuts: 0, warningOutputReleased: true };
  requireProof(
    Array.isArray(raw.events) && Array.isArray(before.proofs) && Array.isArray(after.retiredRequests),
    "missing raw warning/provider observations"
  );
  let discarded = 0;
  const verified = [];
  const generations = new Set<number>();
  for (const event of raw.events.filter((e) => e.type === "native-hazard")) {
    const b = event.providerPlaybackBefore,
      a = event.providerPlaybackAfter;
    requireProof(
      b && a && integer(b.totalDiscardedSamples) && integer(a.totalDiscardedSamples),
      "missing separate provider playback snapshots"
    );
    const delta = a.totalDiscardedSamples - b.totalDiscardedSamples;
    requireProof(delta >= 0, "provider discard counter moved backward");
    if (delta === 0) continue;
    requireProof(
      b.running &&
        b.queuedSamples - b.playbackSamples > 0 &&
        a.generation > b.generation &&
        a.pendingBuffers === 0 &&
        a.queuedSamples === 0 &&
        a.writtenSamples === 0 &&
        a.lastFlushSucceeded,
      "warning-only or unflushed playback cannot credit a provider interruption"
    );
    requireProof(!generations.has(event.hazardGeneration), "duplicate provider-cut generation");
    generations.add(event.hazardGeneration);
    requireProof(
      nativeLong(event.warningSessionEpoch) === nativeLong(raw.warningSessionEpoch),
      "provider cut has stale warning session"
    );
    const clip = assets.find(
      (x) =>
        x.identity.threat === event.warningThreat &&
        x.identity.text === event.warningText &&
        x.identity.gender === event.warningGender
    )?.identity;
    requireProof(clip, "provider-cut hazard has no exact canonical asset");
    const matching = before.proofs.filter(
      (p) =>
        nativeLong(p.request.sessionEpoch) === nativeLong(event.warningSessionEpoch) &&
        p.request.hazardGeneration === event.hazardGeneration
    );
    requireProof(matching.length === 1, "every provider-cut generation needs its exact single render proof");
    verified.push(
      verifyWarningRenderProof(
        matching[0]!,
        {
          sessionEpoch: raw.warningSessionEpoch,
          hazardGeneration: event.hazardGeneration,
          clip,
          observedBeforeNanos: before.snapshotAtNanos,
          currentRequest: before.current,
          retiredRequests: after.retiredRequests
        },
        assets
      )
    );
    discarded += delta;
  }
  requireProof(
    verified.length > 0 &&
      discarded === raw.adasDiscardedSamples &&
      discarded === raw.sameHazardDiscardedSamples &&
      raw.totalQueuedSamples === raw.totalPlayedSamples + discarded,
    "separate provider PCM accounting is incomplete or interrupted outside hazards"
  );
  return {
    case: raw.case,
    round: raw.round,
    verifiedProviderCuts: verified.length,
    warningOutputReleased: true,
    proofs: verified
  };
}

/** Separate no-socket control: verifies hardware epochs 3/5 and rejected supersession 4, never formal credit. */
export function verifyOfflineAndroidWarningControl(
  raw: {
    passed: boolean;
    warningDiagnosticsBeforeStop: WarningDiagnostics;
    warningDiagnosticsAfterStop: WarningDiagnostics;
  },
  assets: readonly TrustedWarningAsset[]
) {
  const before = raw.warningDiagnosticsBeforeStop,
    after = raw.warningDiagnosticsAfterStop;
  requireProof(
    raw.passed && before.prepared && before.output.active && before.output.running,
    "local hardware control did not prepare output"
  );
  requireProof(
    !after.prepared &&
      after.current === null &&
      !after.output.active &&
      !after.output.running &&
      after.output.pendingBuffers === 0,
    "local hardware control did not release output"
  );
  requireProof(
    nativeLong(after.sessionEpoch) !== nativeLong(before.sessionEpoch),
    "release did not retire warning session epoch"
  );
  const generations = before.proofs.map((p) => p.request.hazardGeneration).sort((a, b) => a - b);
  requireProof(
    generations.length === 2 && generations[0] === 3 && generations[1] === 5,
    "missing hardware control generation or superseded generation credited"
  );
  const proofs = before.proofs.map((proof) =>
    verifyWarningRenderProof(
      proof,
      {
        sessionEpoch: before.sessionEpoch,
        hazardGeneration: proof.request.hazardGeneration,
        clip: proof.request.clip,
        observedBeforeNanos: before.snapshotAtNanos,
        currentRequest: before.current,
        retiredRequests: after.retiredRequests
      },
      assets
    )
  );
  return {
    kind: "local-no-socket-warning-hardware-control",
    formalReleaseCredit: false,
    verifiedWarningGenerations: generations,
    proofs
  };
}
