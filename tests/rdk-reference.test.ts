import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createReferenceSink } from "../rdk/agent/src/audio/reference";
import { loadConfig } from "../rdk/agent/src/relay";

const BASE_ENV = { MAX_RELAY_URL: "ws://localhost:8787/agent" } as NodeJS.ProcessEnv;

/** Reads the framed reference stream back into [kind, byteLength] pairs. */
function decodeFrames(chunks: Buffer[]): Array<{ reset: boolean; bytes: number }> {
  const buffer = Buffer.concat(chunks);
  const frames: Array<{ reset: boolean; bytes: number }> = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    offset += 4 + length;
    frames.push({ reset: length === 0, bytes: length });
  }
  return frames;
}

describe("createReferenceSink", () => {
  it("forwards reference audio to the pipe", () => {
    const chunks: Buffer[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    const sink = createReferenceSink({ stream });
    sink.write(new Int16Array(480));
    expect(decodeFrames(chunks)).toEqual([{ reset: false, bytes: 960 }]);
  });

  it("marks the reset in the stream itself, after the audio it must discard", () => {
    // The reset has to travel in-band. Signalling it out-of-band (SIGUSR1) races
    // the pipe: Node buffers writes past the pipe's 64 KB, so reference audio
    // written before a barge-in can still arrive after the signal. max-aec would
    // then treat it as audio that is about to play, hear no echo for it, and gate
    // the mic while the rider is mid-interruption.
    const chunks: Buffer[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    const sink = createReferenceSink({ stream });

    sink.write(new Int16Array(160));
    sink.flush();
    sink.write(new Int16Array(80));

    expect(decodeFrames(chunks)).toEqual([
      { reset: false, bytes: 320 },
      { reset: true, bytes: 0 },
      { reset: false, bytes: 160 }
    ]);
  });

  it("never emits an empty audio frame, which would read as a reset", () => {
    const chunks: Buffer[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    const sink = createReferenceSink({ stream });
    sink.write(new Int16Array(0));
    expect(decodeFrames(chunks)).toEqual([]);
  });

  it("survives a write to a closed pipe", () => {
    const stream = new PassThrough();
    const sink = createReferenceSink({ stream });
    stream.destroy();
    expect(() => sink.write(new Int16Array(160))).not.toThrow();
  });

  it("is a no-op with no pipe, so AEC-off still plays audio", () => {
    const sink = createReferenceSink({ stream: null });
    expect(() => {
      sink.write(new Int16Array(160));
      sink.flush();
      sink.close();
    }).not.toThrow();
  });
});

describe("aec config", () => {
  it("defaults to apm mode", () => {
    expect(loadConfig(BASE_ENV).aecMode).toBe("apm");
  });

  it("can be switched off without a rebuild", () => {
    expect(loadConfig({ ...BASE_ENV, MAX_AEC_MODE: "off" }).aecMode).toBe("off");
  });

  it("rejects an unknown mode rather than silently guessing", () => {
    expect(() => loadConfig({ ...BASE_ENV, MAX_AEC_MODE: "maybe" })).toThrow(/MAX_AEC_MODE/);
  });

  it("defaults the helper path and delay", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.aecBin).toBe("/opt/max/rdk/aec/max-aec");
    expect(config.aecDelayMs).toBe(80); // measured on the board, not guessed
  });
});

describe("aec suppression default", () => {
  it("defaults to high, because the linear fixture's recommendation failed on hardware", () => {
    // The offline sweep said 0 — ERLE was identical at all three levels and
    // double-talk loss only grew. On the board the linear filter alone managed
    // erle 0.0-2.0 dB and the echo loop returned; only the residual suppressor
    // stopped it. A real speaker is nonlinear and the fixture's is not.
    expect(loadConfig(BASE_ENV).aecSuppression).toBe(2);
  });

  it("can be dropped back if barge-in becomes unreliable", () => {
    expect(loadConfig({ ...BASE_ENV, MAX_AEC_SUPPRESSION: "1" }).aecSuppression).toBe(1);
  });
});
