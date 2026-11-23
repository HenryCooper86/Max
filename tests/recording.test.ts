import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConversationRecording,
  createRecordings,
  RECORDING_RATE,
  recordingSettingsFromEnv,
  Resampler24to16
} from "../server/recording";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "max-recording-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A tone as PCM16 mono. */
function tone(rate: number, hz: number, ms: number, level = 10_000, phase = 0): Buffer {
  const samples = Math.round((rate * ms) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(Math.round(level * Math.sin((2 * Math.PI * hz * (i + phase)) / rate)), i * 2);
  }
  return pcm;
}

const constant = (rate: number, ms: number, value: number): Buffer => {
  const pcm = Buffer.alloc(Math.round((rate * ms) / 1000) * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(value, i);
  return pcm;
};

function rms(pcm: Buffer, from = 0, to = pcm.length / 2): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += pcm.readInt16LE(i * 2) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** Reads a recording: its header fields and the two channels. */
function readWav(file: string) {
  const data = fs.readFileSync(file);
  const frames = (data.length - 44) / 4;
  const left = new Int16Array(frames);
  const right = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    left[i] = data.readInt16LE(44 + i * 4);
    right[i] = data.readInt16LE(46 + i * 4);
  }
  return {
    riff: data.toString("ascii", 0, 4) + data.toString("ascii", 8, 16),
    riffSize: data.readUInt32LE(4),
    format: data.readUInt16LE(20),
    channels: data.readUInt16LE(22),
    rate: data.readUInt32LE(24),
    byteRate: data.readUInt32LE(28),
    blockAlign: data.readUInt16LE(32),
    bits: data.readUInt16LE(34),
    dataSize: data.readUInt32LE(40),
    fileSize: data.length,
    frames,
    left,
    right
  };
}

/** The level of a channel over a stretch of time. */
function level(channel: Int16Array, fromMs: number, toMs: number): number {
  let sum = 0;
  const from = (fromMs * RECORDING_RATE) / 1000;
  const to = Math.min(channel.length, (toMs * RECORDING_RATE) / 1000);
  for (let i = from; i < to; i += 1) sum += channel[i]! ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

const SESSION = "0b0e6d0c-7c1f-4d57-9d3a-2f6f6f0a1b2c";

function recorder() {
  let at = 1_000_000;
  const file = path.join(dir, `${SESSION}.wav`);
  const recording = new ConversationRecording(file, () => at);
  return {
    file,
    recording,
    advance(ms: number) {
      at += ms;
    }
  };
}

describe("recordingSettingsFromEnv", () => {
  it("is off unless asked for", () => {
    expect(recordingSettingsFromEnv({})).toEqual({ problems: [] });
    expect(recordingSettingsFromEnv({ CONVERSATION_RECORDING: "off", CONVERSATION_RECORDING_DIR: "/x" })).toEqual({
      problems: []
    });
  });

  it("needs a directory, and a mode it knows", () => {
    const noDir = recordingSettingsFromEnv({ CONVERSATION_RECORDING: "phone" });
    expect(noDir.settings).toBeUndefined();
    expect(noDir.problems[0]).toContain("CONVERSATION_RECORDING_DIR");
    const odd = recordingSettingsFromEnv({ CONVERSATION_RECORDING: "always", CONVERSATION_RECORDING_DIR: "/x" });
    expect(odd.settings).toBeUndefined();
    expect(odd.problems[0]).toContain("not one of off, phone, on");
  });

  it("reads the mode, the directory and the retention", () => {
    expect(
      recordingSettingsFromEnv({
        CONVERSATION_RECORDING: " Phone ",
        CONVERSATION_RECORDING_DIR: "/var/recordings/",
        CONVERSATION_RECORDING_KEEP_DAYS: "30"
      })
    ).toEqual({ settings: { mode: "phone", dir: path.resolve("/var/recordings"), keepDays: 30 }, problems: [] });
    const bad = recordingSettingsFromEnv({
      CONVERSATION_RECORDING: "on",
      CONVERSATION_RECORDING_DIR: "/x",
      CONVERSATION_RECORDING_KEEP_DAYS: "soon"
    });
    expect(bad.settings).toEqual({ mode: "on", dir: path.resolve("/x") });
    expect(bad.problems).toHaveLength(1);
  });
});

describe("Resampler24to16", () => {
  it("gives two samples for every three, at the same level", () => {
    const out = new Resampler24to16().process(tone(24_000, 1000, 500));
    expect(Math.abs(out.length / 2 - 8000)).toBeLessThanOrEqual(1);
    // Past the first millisecond, a 1 kHz tone keeps its level within a few percent.
    const expected = 10_000 / Math.SQRT2;
    expect(rms(out, 100)).toBeGreaterThan(expected * 0.97);
    expect(rms(out, 100)).toBeLessThan(expected * 1.03);
  });

  it("removes what 16 kHz cannot carry instead of folding it into the speech band", () => {
    // 10 kHz would come back as a 6 kHz whistle without the filter.
    const out = new Resampler24to16().process(tone(24_000, 10_000, 500));
    expect(rms(out, 100)).toBeLessThan((10_000 / Math.SQRT2) * 0.02);
  });

  it("gives the same samples whatever the size of the pieces", () => {
    const input = tone(24_000, 440, 400);
    const whole = new Resampler24to16().process(input);
    const pieces = new Resampler24to16();
    const parts: Buffer[] = [];
    for (let at = 0, size = 2; at < input.length; at += size, size = ((size * 7) % 1000) * 2 + 2) {
      parts.push(pieces.process(input.subarray(at, Math.min(input.length, at + size))));
    }
    expect(Buffer.concat(parts).equals(whole)).toBe(true);
    expect(new Resampler24to16().process(Buffer.alloc(0))).toHaveLength(0);
  });
});

describe("ConversationRecording", () => {
  it("writes a stereo WAV with the user on the left and the assistant on the right", async () => {
    const { file, recording, advance } = recorder();
    // The user speaks for a second, in 20 ms pieces as they arrive.
    for (let i = 0; i < 50; i += 1) {
      advance(20);
      recording.user(constant(16_000, 20, 3000));
    }
    // The assistant answers with a second of speech, sent all at once.
    recording.agent(constant(24_000, 1000, -5000));
    advance(1500);
    const finished = await recording.close();
    expect(finished).toEqual({ file: `${SESSION}.wav`, durationMs: 2000, bytes: 44 + 2000 * 64 });
    const wav = readWav(file);
    expect(wav).toMatchObject({
      riff: "RIFFWAVEfmt ",
      format: 1,
      channels: 2,
      rate: 16_000,
      byteRate: 64_000,
      blockAlign: 4,
      bits: 16,
      dataSize: 2000 * 64,
      riffSize: 36 + 2000 * 64,
      fileSize: 44 + 2000 * 64
    });
    expect(level(wav.left, 0, 1000)).toBeCloseTo(3000, -1);
    expect(level(wav.left, 1000, 2000)).toBe(0);
    expect(level(wav.right, 0, 1000)).toBe(0);
    expect(level(wav.right, 1010, 1990)).toBeCloseTo(5000, -2);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("lays speech that was sent ahead of time where the client plays it", async () => {
    const { file, recording, advance } = recorder();
    advance(100);
    // Two seconds of speech arrive within 200 ms, as a fast model sends them.
    recording.agent(constant(24_000, 1000, 4000));
    advance(200);
    recording.agent(constant(24_000, 1000, 8000));
    advance(2500);
    await recording.close();
    const wav = readWav(file);
    expect(level(wav.right, 0, 100)).toBe(0);
    expect(level(wav.right, 110, 1090)).toBeCloseTo(4000, -2);
    // The second piece follows the first, not the moment it was sent.
    expect(level(wav.right, 1110, 2090)).toBeCloseTo(8000, -2);
    expect(wav.frames).toBe(2100 * 16);
  });

  it("drops the speech the user interrupted, and keeps what was heard", async () => {
    const { file, recording, advance } = recorder();
    recording.agent(constant(24_000, 3000, 6000));
    advance(1000);
    // The user speaks over it: the client throws away the two seconds it had not played.
    recording.agentCleared();
    for (let i = 0; i < 50; i += 1) {
      advance(20);
      recording.user(constant(16_000, 20, 2000));
    }
    // The next reply starts now, not after the dropped speech.
    recording.agent(constant(24_000, 500, 9000));
    advance(600);
    await recording.close();
    const wav = readWav(file);
    expect(level(wav.right, 10, 990)).toBeCloseTo(6000, -2);
    expect(level(wav.right, 1000, 2000)).toBe(0);
    expect(level(wav.left, 1000, 2000)).toBeCloseTo(2000, -1);
    expect(level(wav.right, 2010, 2490)).toBeCloseTo(9000, -2);
    expect(wav.frames).toBe(2500 * 16);
  });

  it("ends where the conversation ended, without speech that was never played", async () => {
    const { file, recording, advance } = recorder();
    recording.agent(constant(24_000, 5000, 6000));
    advance(1200);
    const finished = await recording.close();
    expect(finished?.durationMs).toBe(1200);
    expect(readWav(file).frames).toBe(1200 * 16);
  });

  it("joins audio that a network stall delivered late, and leaves a gap for a real pause", async () => {
    const { file, recording, advance } = recorder();
    advance(20);
    recording.user(constant(16_000, 20, 1000));
    // 200 ms of nothing, then the 10 pieces that were held up arrive together.
    advance(200);
    for (let i = 0; i < 10; i += 1) recording.user(constant(16_000, 20, 1000));
    // The user's microphone is then off for three seconds.
    advance(3020);
    recording.user(constant(16_000, 20, 7000));
    await recording.close();
    const wav = readWav(file);
    // No hole where the stall was: 220 ms of audio fill the first 220 ms.
    expect(level(wav.left, 0, 220)).toBeCloseTo(1000, -1);
    expect(level(wav.left, 220, 3220)).toBe(0);
    expect(level(wav.left, 3220, 3240)).toBeCloseTo(7000, -1);
  });

  it("does not record a client that sends audio far faster than time passes", async () => {
    const { file, recording, advance } = recorder();
    for (let i = 0; i < 100; i += 1) recording.user(constant(16_000, 1000, 1000));
    advance(10);
    await recording.close();
    // Audio cannot have been spoken in less time than it lasts: only what fits is kept.
    expect(readWav(file).frames).toBeLessThanOrEqual(7 * 16_000);
  });

  it("moves audio that arrived all at once after a long stall back to where it was spoken", async () => {
    const { file, recording, advance } = recorder();
    for (let i = 0; i < 50; i += 1) {
      advance(20);
      recording.user(constant(16_000, 20, 50));
    }
    // Three seconds of nothing, then the 150 pieces spoken meanwhile, each with its own level.
    advance(3000);
    for (let i = 0; i < 150; i += 1) recording.user(constant(16_000, 20, 1000 + i * 10));
    for (let i = 0; i < 50; i += 1) {
      advance(20);
      recording.user(constant(16_000, 20, 9000));
    }
    await recording.close();
    const wav = readWav(file);
    // Five seconds were spoken and five are recorded, give or take the slack allowed for jitter.
    expect(wav.frames).toBeGreaterThanOrEqual(5 * 16_000);
    expect(wav.frames).toBeLessThanOrEqual(5.07 * 16_000);
    expect(level(wav.left, 0, 900)).toBeCloseTo(50, -1);
    // The piece spoken at 2.5 s is the 75th of the stall, and it is found there.
    const at = (ms: number) => wav.left[(ms * 16_000) / 1000]!;
    expect(Math.abs(at(2500) - 1750)).toBeLessThanOrEqual(40);
    expect(Math.abs(at(1200) - 1100)).toBeLessThanOrEqual(40);
    expect(Math.abs(at(3900) - 2450)).toBeLessThanOrEqual(40);
    expect(level(wav.left, 4100, 4900)).toBeCloseTo(9000, -1);
  });

  it("keeps the newest of the held-up audio when the stall was too long to repair in full", async () => {
    const { file, recording, advance } = recorder();
    for (let i = 0; i < 50; i += 1) {
      advance(20);
      recording.user(constant(16_000, 20, 50));
    }
    // Eight seconds: by then the first three of them are written as silence.
    advance(8000);
    for (let i = 0; i < 400; i += 1) recording.user(constant(16_000, 20, 1000 + i * 10));
    advance(20);
    recording.user(constant(16_000, 20, 9000));
    await recording.close();
    const wav = readWav(file);
    expect(wav.frames).toBeGreaterThanOrEqual(9.02 * 16_000);
    expect(wav.frames).toBeLessThanOrEqual(9.09 * 16_000);
    const at = (ms: number) => wav.left[(ms * 16_000) / 1000]!;
    expect(level(wav.left, 1100, 3900)).toBe(0);
    // What was spoken at 6 s is the 250th piece of the stall, and at 8.5 s the 375th.
    expect(Math.abs(at(6000) - 3500)).toBeLessThanOrEqual(40);
    expect(Math.abs(at(8500) - 4750)).toBeLessThanOrEqual(40);
  });

  it("records a silence of any length without holding it in memory", async () => {
    const { file, recording, advance } = recorder();
    advance(20);
    recording.user(constant(16_000, 20, 1000));
    // Ten minutes with a muted microphone and a silent assistant: 38 MB of silence.
    advance(600_000);
    recording.user(constant(16_000, 20, 7000));
    expect((recording as unknown as { window: Buffer }).window.length).toBeLessThan(1024 * 1024);
    const finished = await recording.close();
    expect(finished?.durationMs).toBe(600_020);
    expect(fs.statSync(file).size).toBe(44 + 600.02 * 64_000);
    const tail = Buffer.alloc(4 * 640);
    const handle = fs.openSync(file, "r");
    fs.readSync(handle, tail, 0, tail.length, 44 + (600.02 - 0.04) * 64_000);
    fs.closeSync(handle);
    // The 20 ms before the last piece are silence, and the last piece is where the clock put it.
    expect(tail.readInt16LE(4 * 100)).toBe(0);
    expect(tail.readInt16LE(4 * 500)).toBe(7000);
  });

  it("writes speech only once its time has come, so an interruption can always take it back", async () => {
    const { file, recording, advance } = recorder();
    // A long answer arrives all at once: 200 s of speech.
    for (let i = 0; i < 20; i += 1) recording.agent(constant(24_000, 10_000, 4000));
    advance(10_000);
    recording.agentCleared();
    advance(5000);
    recording.user(constant(16_000, 20, 1000));
    await recording.close();
    const wav = readWav(file);
    expect(wav.frames).toBe(15 * 16_000);
    expect(level(wav.right, 100, 9900)).toBeCloseTo(4000, -2);
    expect(level(wav.right, 10_000, 15_000)).toBe(0);
  });

  it("ends a conversation that stopped half a second into a long answer at half a second", async () => {
    const { file, recording, advance } = recorder();
    for (let i = 0; i < 20; i += 1) recording.agent(constant(24_000, 10_000, 4000));
    advance(500);
    expect((await recording.close())?.durationMs).toBe(500);
    expect(readWav(file).frames).toBe(8000);
  });

  it("does not hold speech that is more than five minutes from being played", async () => {
    const { recording } = recorder();
    for (let i = 0; i < 60; i += 1) recording.agent(constant(24_000, 10_000, 4000));
    expect((recording as unknown as { window: Buffer }).window.length).toBeLessThanOrEqual(24 * 1024 * 1024);
    expect((recording as unknown as { agentCursor: number }).agentCursor).toBeLessThanOrEqual(311 * 16_000);
    await recording.close();
  });

  it("gives the file its header even when the disk fails as the recording ends", async () => {
    const { file, recording, advance } = recorder();
    for (let i = 0; i < 500; i += 1) {
      advance(20);
      recording.user(constant(16_000, 20, 1000));
    }
    // The first five seconds are written by now. Let them reach the disk, then fail the last write.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stream = (recording as unknown as { stream: fs.WriteStream }).stream;
    stream.end = (() => stream.destroy(new Error("ENOSPC: no space left on device"))) as never;
    const finished = await recording.close();
    expect(finished?.durationMs).toBeGreaterThanOrEqual(4900);
    expect(finished?.durationMs).toBeLessThanOrEqual(10_000);
    const wav = readWav(file);
    expect(wav.dataSize).toBe(finished!.bytes - 44);
    expect(wav.dataSize).toBeLessThanOrEqual(wav.fileSize - 44);
    expect(level(wav.left, 0, 4900)).toBeCloseTo(1000, -1);
  });

  it("keeps little in memory however long the conversation is", async () => {
    const { file, recording, advance } = recorder();
    for (let i = 0; i < 30 * 50; i += 1) {
      advance(20);
      recording.user(constant(16_000, 20, 1234));
      if (i % 50 === 0) recording.agent(constant(24_000, 900, 4321));
    }
    // Half a minute in, everything but the last few seconds is on its way to disk.
    const held = (recording as unknown as { window: Buffer }).window.length;
    expect(held).toBeLessThan(16 * 64_000);
    await recording.close();
    const wav = readWav(file);
    expect(wav.frames).toBe(30 * 16_000);
    expect(level(wav.left, 0, 30_000)).toBeCloseTo(1234, -1);
    expect(level(wav.right, 5010, 5890)).toBeCloseTo(4321, -2);
    expect(level(wav.right, 5920, 6000)).toBe(0);
  });

  it("leaves no file for a conversation without audio, and closes once", async () => {
    const { file, recording, advance } = recorder();
    advance(5000);
    const first = recording.close();
    expect(await first).toBeUndefined();
    expect(await recording.close()).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
    // Audio after the end is ignored.
    recording.user(constant(16_000, 20, 1000));
    recording.agent(constant(24_000, 20, 1000));
    recording.agentCleared();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("never writes over a file that is already there, and never throws into the conversation", async () => {
    const { file, recording, advance } = recorder();
    fs.writeFileSync(file, "someone else's");
    for (let i = 0; i < 200; i += 1) {
      advance(20);
      recording.user(constant(16_000, 20, 1000));
    }
    await recording.close();
    expect(fs.readFileSync(file, "utf8")).toBe("someone else's");
  });

  it("carries on without a recording when the directory cannot be made", async () => {
    const blocked = path.join(dir, "not-a-directory");
    fs.writeFileSync(blocked, "");
    let at = 0;
    const recording = new ConversationRecording(path.join(blocked, `${SESSION}.wav`), () => at);
    for (let i = 0; i < 200; i += 1) {
      at += 20;
      recording.user(constant(16_000, 20, 1000));
    }
    expect(await recording.close()).toBeUndefined();
  });
});

describe("createRecordings", () => {
  it("records phone calls only, or everything", () => {
    const phone = createRecordings({ mode: "phone", dir });
    expect([phone.records("phone"), phone.records("web")]).toEqual([true, false]);
    const all = createRecordings({ mode: "on", dir });
    expect([all.records("phone"), all.records("web")]).toEqual([true, true]);
  });

  it("names a recording after its conversation, and refuses any other name", async () => {
    const recordings = createRecordings({ mode: "on", dir });
    expect(recordings.open("../../etc/passwd")).toBeUndefined();
    expect(recordings.open("not-a-uuid")).toBeUndefined();
    let at = 0;
    const timed = createRecordings({ mode: "on", dir }, { now: () => at });
    const recording = timed.open(SESSION)!;
    at += 500;
    recording.user(constant(16_000, 500, 1000));
    // Not while it is being written: not to fetch, and not in the list.
    for (let i = 0; i < 400; i += 1) {
      at += 20;
      recording.user(constant(16_000, 20, 1000));
    }
    expect(fs.existsSync(path.join(dir, `${SESSION}.wav`))).toBe(true);
    expect(timed.pathOf(`${SESSION}.wav`)).toBeUndefined();
    expect(await timed.list()).toEqual({ recordings: [], more: false });
    const finished = await recording.close();
    expect(finished?.file).toBe(`${SESSION}.wav`);
    expect(timed.pathOf(`${SESSION}.wav`)).toBe(path.join(dir, `${SESSION}.wav`));
    expect(recordings.pathOf(`${SESSION}.wav`)).toBe(path.join(dir, `${SESSION}.wav`));
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a recording");
    const listed = await timed.list();
    expect(listed.more).toBe(false);
    expect(listed.recordings).toEqual([
      { file: `${SESSION}.wav`, bytes: finished!.bytes, finishedAt: expect.stringMatching(/^\d{4}-.*Z$/) }
    ]);
    for (const name of ["", "x.wav", `../${SESSION}.wav`, `${SESSION}.wav/..`, `${SESSION}.WAV`, `${SESSION}.wav\0`]) {
      expect(recordings.pathOf(name)).toBeUndefined();
    }
    expect(recordings.pathOf("11111111-2222-3333-4444-555555555555.wav")).toBeUndefined();
  });

  it("finishes the recordings still open when the relay shuts down", async () => {
    let at = 0;
    const recordings = createRecordings({ mode: "on", dir }, { now: () => at });
    const recording = recordings.open(SESSION)!;
    at += 300;
    recording.user(constant(16_000, 300, 1000));
    await recordings.close();
    const wav = readWav(path.join(dir, `${SESSION}.wav`));
    expect(wav.dataSize).toBe(300 * 64);
    expect(wav.fileSize).toBe(44 + 300 * 64);
  });

  it("does not follow a link that stands where a recording would", () => {
    const recordings = createRecordings({ mode: "on", dir });
    const secret = path.join(dir, "secret.txt");
    fs.writeFileSync(secret, "secret");
    fs.symlinkSync(secret, path.join(dir, `${SESSION}.wav`));
    expect(recordings.pathOf(`${SESSION}.wav`)).toBeUndefined();
  });

  it("removes recordings older than the retention, and nothing else", async () => {
    const day = 24 * 3600 * 1000;
    const at = Date.now();
    const old = path.join(dir, "aaaaaaaa-0000-0000-0000-000000000001.wav");
    const recent = path.join(dir, "aaaaaaaa-0000-0000-0000-000000000002.wav");
    const other = path.join(dir, "notes.txt");
    for (const file of [old, recent, other]) fs.writeFileSync(file, "x");
    fs.utimesSync(old, new Date(at - 31 * day), new Date(at - 31 * day));
    fs.utimesSync(other, new Date(at - 90 * day), new Date(at - 90 * day));
    fs.utimesSync(recent, new Date(at - 29 * day), new Date(at - 29 * day));
    const recordings = createRecordings({ mode: "on", dir, keepDays: 30 }, { now: () => at });
    expect(await recordings.prune()).toBeLessThanOrEqual(1);
    await recordings.close();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    // Without a retention nothing is ever removed.
    fs.writeFileSync(old, "x");
    fs.utimesSync(old, new Date(at - 400 * day), new Date(at - 400 * day));
    const keeping = createRecordings({ mode: "on", dir });
    expect(await keeping.prune()).toBe(0);
    expect(fs.existsSync(old)).toBe(true);
  });
});
