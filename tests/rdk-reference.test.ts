import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createReferenceSink } from "../rdk/agent/src/audio/reference";
import { loadConfig } from "../rdk/agent/src/relay";

const BASE_ENV = { MAX_RELAY_URL: "ws://localhost:8787/agent" } as NodeJS.ProcessEnv;

describe("createReferenceSink", () => {
  it("forwards reference audio to the pipe", () => {
    const stream = new PassThrough();
    const seen: number[] = [];
    stream.on("data", (chunk: Buffer) => seen.push(chunk.length));
    const sink = createReferenceSink({ stream, onReset: () => {} });
    sink.write(new Int16Array(480));
    expect(seen).toEqual([960]);
  });

  it("signals reset on flush", () => {
    let resets = 0;
    const sink = createReferenceSink({ stream: new PassThrough(), onReset: () => (resets += 1) });
    sink.flush();
    expect(resets).toBe(1);
  });

  it("drops audio queued before a flush", () => {
    // Barge-in kills aplay, so anything still queued will never be played.
    // Feeding it to APM would subtract a phantom echo from the rider's speech.
    const stream = new PassThrough();
    const chunks: number[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c.length));
    const sink = createReferenceSink({ stream, onReset: () => {} });
    sink.flush();
    sink.write(new Int16Array(160));
    expect(chunks).toEqual([320]); // only the post-flush write
  });

  it("survives a write to a closed pipe", () => {
    const stream = new PassThrough();
    const sink = createReferenceSink({ stream, onReset: () => {} });
    stream.destroy();
    expect(() => sink.write(new Int16Array(160))).not.toThrow();
  });

  it("is a no-op with no pipe, so AEC-off still plays audio", () => {
    const sink = createReferenceSink({ stream: null, onReset: () => {} });
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
    expect(config.aecDelayMs).toBe(160);
  });
});
