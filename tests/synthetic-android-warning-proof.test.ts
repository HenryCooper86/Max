import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyAndroidWarningReport } from "../scripts/synthetic-qa/android/verify-warning-report";
import { describe, expect, it } from "vitest";
import {
  decodeWarningWav,
  loadCanonicalWarningAssets,
  processWarningPcm,
  verifyWarningRenderProof,
  verifyOfflineAndroidWarningControl,
  type WarningRenderProof,
  type WarningProofContext,
  type TrustedWarningAsset
} from "../scripts/synthetic-qa/android/warning-proof";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
// Hand-authored 24k mono PCM16 WAV: [0, 0, 256, -256]. Gain=2 => [0,0,511,-511].
const wav = Buffer.from(
  "524946462c00000057415645666d74201000000001000100c05d000080bb000002001000646174610800000000000000000100ff",
  "hex"
);
const pcm = Buffer.from("00000000000100ff", "hex");
const accepted = Buffer.from("00000000ff01", "hex"); // Actual accepted prefix: first three samples.
const identity = {
  threat: "forward_collision",
  text: "前车急刹",
  gender: "female",
  wavSha256: sha(wav),
  pcmSha256: sha(pcm),
  samples: 4
};
const asset: TrustedWarningAsset = { identity, wav };
const request = {
  sessionEpoch: "101",
  hazardGeneration: 3,
  clip: identity,
  playbackEpoch: "8",
  playbackGeneration: 2,
  requestedAtNanos: "1000"
};
const proof: WarningRenderProof = {
  request,
  progress: {
    playbackEpoch: "8",
    playbackGeneration: 2,
    writtenSamples: 3,
    hardwarePlayedSamples: 3,
    firstNonzeroSample: 2,
    actualWrittenPcmSha256: sha(accepted),
    expectedWrittenPcmSha256: sha(accepted),
    actualWrittenPcmBase64: accepted.toString("base64"),
    outputGain: 2,
    observedAtNanos: "1100"
  },
  capturedAtNanos: "1110"
};
const context: WarningProofContext = {
  sessionEpoch: "101",
  hazardGeneration: 3,
  clip: identity,
  observedBeforeNanos: "1500",
  currentRequest: null,
  retiredRequests: [{ request, retiredAtNanos: "1200" }]
};
const copy = <T>(value: T): T => structuredClone(value);
const rejects = (change: (p: WarningRenderProof, c: WarningProofContext) => void) => {
  const p = copy(proof),
    c = copy(context);
  change(p, c);
  expect(() => verifyWarningRenderProof(p, c, [asset])).toThrow();
};

describe("independent Android warning render evidence", () => {
  it("accepts only the actual post-gain written prefix whose nonzero sample passed hardware", () => {
    expect(verifyWarningRenderProof(proof, context, [asset])).toMatchObject({
      verified: true,
      firstNonzeroSample: 2,
      verifiedPrefixSha256: sha(accepted),
      hardwarePlayedNonzeroSamples: 1
    });
    expect(decodeWarningWav(wav, 4)).toEqual(pcm);
    expect(processWarningPcm(pcm, 2)).toEqual(Buffer.from("00000000ff0101fe", "hex"));
  });
  it("retains exact source PCM at unity gain", () => {
    expect(processWarningPcm(pcm, 1)).toEqual(pcm);
  });
  it("round trips Android JSON float gain without rejecting its shortest decimal", () => {
    expect(processWarningPcm(pcm, 0.8)).toEqual(Buffer.from("00000000cc0034ff", "hex"));
  });
  it("rejects request/enqueue/play calls with no actual hardware progress", () =>
    rejects((p) => {
      p.progress.hardwarePlayedSamples = 0;
    }));
  it("rejects a hardware head still inside the leading silent prefix", () =>
    rejects((p) => {
      p.progress.hardwarePlayedSamples = 2;
    }));
  it("rejects a forged first-nonzero offset even when claimed head passed it", () =>
    rejects((p) => {
      p.progress.firstNonzeroSample = 0;
      p.progress.hardwarePlayedSamples = 1;
    }));
  it("rejects hash-only claims without actual accepted write bytes", () =>
    rejects((p) => {
      p.progress.actualWrittenPcmBase64 = "";
    }));
  it("rejects self-consistent hashes of bytes from the wrong processed asset", () =>
    rejects((p) => {
      const wrong = Buffer.from("000000000001", "hex");
      p.progress.actualWrittenPcmBase64 = wrong.toString("base64");
      p.progress.actualWrittenPcmSha256 = p.progress.expectedWrittenPcmSha256 = sha(wrong);
    }));
  it("rejects fabricated actual or expected digest strings", () => {
    rejects((p) => {
      p.progress.actualWrittenPcmSha256 = "a".repeat(64);
    });
    rejects((p) => {
      p.progress.expectedWrittenPcmSha256 = "b".repeat(64);
    });
  });
  it("rejects stale session evidence", () =>
    rejects((p) => {
      p.request.sessionEpoch = "100";
    }));
  it("rejects a different hazard generation", () =>
    rejects((p) => {
      p.request.hazardGeneration = 2;
    }));
  it("rejects progress from another output epoch or generation", () => {
    rejects((p) => {
      p.progress.playbackEpoch = "7";
    });
    rejects((p) => {
      p.progress.playbackGeneration = 1;
    });
  });
  it("rejects wrong text, threat, gender, source hashes or sample count", () => {
    for (const [key, value] of Object.entries({
      text: "另一句",
      threat: "rear_approach",
      gender: "male",
      wavSha256: "c".repeat(64),
      pcmSha256: "d".repeat(64),
      samples: 5
    }))
      rejects((p) => {
        Object.assign(p.request.clip, { [key]: value });
      });
  });
  it("rejects accepted byte lengths inconsistent with actual write counts", () =>
    rejects((p) => {
      p.progress.writtenSamples = 4;
    }));
  it("rejects a hardware head beyond the accepted samples", () =>
    rejects((p) => {
      p.progress.hardwarePlayedSamples = 4;
    }));
  it("rejects progress first observed or captured after supersession", () => {
    rejects((p) => {
      p.progress.observedAtNanos = "1200";
      p.capturedAtNanos = "1201";
    });
    rejects((p) => {
      p.capturedAtNanos = "1200";
    });
  });
  it("rejects capture preceding actual progress or the request", () => {
    rejects((p) => {
      p.capturedAtNanos = "1099";
    });
    rejects((p) => {
      p.progress.observedAtNanos = "999";
    });
  });
  it("rejects a proof absent from both retired and current ownership", () =>
    rejects((_p, c) => {
      c.retiredRequests = [];
    }));
  it("rejects invalid gains instead of interpreting arbitrary bytes as output", () => {
    rejects((p) => {
      p.progress.outputGain = 4.1;
    });
    rejects((p) => {
      p.progress.outputGain = Number.NaN;
    });
  });
  it("rejects a corrupted trusted source WAV independently of claimed hashes", () => {
    const corrupt = Buffer.from(wav);
    corrupt[44] = 1;
    expect(() => verifyWarningRenderProof(proof, context, [{ identity, wav: corrupt }])).toThrow();
  });
  it("verifies all eighteen canonical source assets independently", () => {
    expect(loadCanonicalWarningAssets("public/audio/adas")).toHaveLength(18);
  });
});

import {
  verifyAndroidWarningCase,
  type AndroidWarningCaseEvidence
} from "../scripts/synthetic-qa/android/warning-proof";
const providerBefore = {
  running: true,
  queuedSamples: 10,
  playbackSamples: 5,
  generation: 1,
  pendingBuffers: 1,
  writtenSamples: 10,
  lastFlushSucceeded: false,
  totalDiscardedSamples: 0
};
const providerAfter = {
  running: true,
  queuedSamples: 0,
  playbackSamples: 0,
  generation: 2,
  pendingBuffers: 0,
  writtenSamples: 0,
  lastFlushSucceeded: true,
  totalDiscardedSamples: 5
};
const caseEvidence: AndroidWarningCaseEvidence = {
  case: "adas-alert-interrupt",
  round: 1,
  passed: true,
  warningEvidenceVersion: 2,
  warningPreparedAtReady: true,
  warningSessionEpoch: "101",
  warningDiagnosticsBeforeStop: {
    sessionEpoch: "101",
    prepared: true,
    current: null,
    snapshotAtNanos: "1500",
    output: { active: true, running: true, pendingBuffers: 0 },
    proofs: [proof],
    retiredRequests: context.retiredRequests
  },
  warningDiagnosticsAfterStop: {
    sessionEpoch: "102",
    prepared: false,
    current: null,
    snapshotAtNanos: "1600",
    output: { active: false, running: false, pendingBuffers: 0 },
    proofs: [proof],
    retiredRequests: context.retiredRequests
  },
  events: [
    {
      type: "native-hazard",
      hazardGeneration: 3,
      warningSessionEpoch: "101",
      warningText: identity.text,
      warningThreat: identity.threat,
      warningGender: identity.gender,
      providerPlaybackBefore: providerBefore,
      providerPlaybackAfter: providerAfter
    }
  ],
  totalQueuedSamples: 10,
  totalPlayedSamples: 5,
  adasDiscardedSamples: 5,
  sameHazardDiscardedSamples: 5
};
describe("independent Android warning report replay", () => {
  it("verifies the exact asset/hardware proof separately from actual provider interruption accounting", () => {
    expect(verifyAndroidWarningCase(caseEvidence, [asset])).toMatchObject({
      verifiedProviderCuts: 1,
      warningOutputReleased: true
    });
  });
  it("rejects an additional provider cut without its own same-generation proof", () => {
    const c = copy(caseEvidence);
    c.events.push({ ...copy(c.events[0]!), hazardGeneration: 4 });
    expect(() => verifyAndroidWarningCase(c, [asset])).toThrow(/every provider-cut/);
  });
  it("rejects warning-only hardware cuts even with a valid warning render", () => {
    const c = copy(caseEvidence);
    c.events[0]!.providerPlaybackBefore.queuedSamples = 0;
    c.events[0]!.providerPlaybackBefore.playbackSamples = 0;
    expect(() => verifyAndroidWarningCase(c, [asset])).toThrow(/warning-only/);
  });
  it("rejects a discarded provider sample outside exact hazard snapshots", () => {
    const c = copy(caseEvidence);
    c.adasDiscardedSamples = 6;
    expect(() => verifyAndroidWarningCase(c, [asset])).toThrow(/accounting/);
  });
  it("rejects provider stop that leaves the independent warning player alive", () => {
    const c = copy(caseEvidence);
    c.warningDiagnosticsAfterStop.output.active = true;
    expect(() => verifyAndroidWarningCase(c, [asset])).toThrow(/stop left/);
  });
  it("rejects legacy TTS-start evidence without verified written PCM", () => {
    const c = copy(caseEvidence);
    c.warningDiagnosticsBeforeStop.proofs = [];
    expect(() => verifyAndroidWarningCase(c, [asset])).toThrow(/render proof/);
  });
  it("rejects warning playback triggered by unaddressed speech", () => {
    const c = copy(caseEvidence);
    c.case = "wake-word-addressed-only";
    c.unaddressedWarningQueuedSamples = 1;
    c.unaddressedWarningProofs = 1;
    expect(() => verifyAndroidWarningCase(c, [asset])).toThrow(/unaddressed/);
  });
});

it("report-file entry rejects legacy empty evidence without inventing session credit", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "warning-proof-test-"));
  try {
    const reportPath = path.join(directory, "legacy.json");
    writeFileSync(reportPath, JSON.stringify({ sessions: [] }));
    expect(() => verifyAndroidWarningReport(reportPath)).toThrow(
      "Missing successful raw Android instrumentation sessions"
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

describe("independent local hardware control replay", () => {
  const diagnostic = () => {
    const later = copy(proof);
    later.request.hazardGeneration = 5;
    return {
      passed: true,
      warningDiagnosticsBeforeStop: {
        sessionEpoch: "101",
        prepared: true,
        current: later.request,
        snapshotAtNanos: "1500",
        output: { active: true, running: true, pendingBuffers: 1 },
        proofs: [copy(proof), later],
        retiredRequests: copy(context.retiredRequests)
      },
      warningDiagnosticsAfterStop: {
        sessionEpoch: "102",
        prepared: false,
        current: null,
        snapshotAtNanos: "1600",
        output: { active: false, running: false, pendingBuffers: 0 },
        proofs: [],
        retiredRequests: [...copy(context.retiredRequests), { request: later.request, retiredAtNanos: "1550" }]
      }
    };
  };
  it("replays both real hardware generations without creating provider or release credit", () => {
    expect(verifyOfflineAndroidWarningControl(diagnostic(), [asset])).toMatchObject({
      formalReleaseCredit: false,
      verifiedWarningGenerations: [3, 5]
    });
  });
  it("rejects unwritten superseded generation credit", () => {
    const raw = diagnostic();
    raw.warningDiagnosticsBeforeStop.proofs[1]!.request.hazardGeneration = 4;
    expect(() => verifyOfflineAndroidWarningControl(raw, [asset])).toThrow();
  });
  it("rejects output remaining alive after production release", () => {
    const raw = diagnostic();
    raw.warningDiagnosticsAfterStop.output.active = true;
    expect(() => verifyOfflineAndroidWarningControl(raw, [asset])).toThrow();
  });
});
