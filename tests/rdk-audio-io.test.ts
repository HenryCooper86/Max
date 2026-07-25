import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { FRAME_SAMPLES } from "../rdk/agent/src/audio/dsp";
import { captureArgs, createCapture } from "../rdk/agent/src/audio/capture";
import { createPlayback, playbackArgs } from "../rdk/agent/src/audio/playback";

function fakeChild() {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const kill = vi.fn();
  return {
    child: { stdout, stdin, kill, on: () => {} },
    stdout,
    stdin,
    kill
  };
}

describe("captureArgs", () => {
  it("captures raw 48 kHz mono PCM16 from the configured device", () => {
    const args = captureArgs("plughw:1,0");
    expect(args).toContain("-D");
    expect(args).toContain("plughw:1,0");
    expect(args).toContain("48000");
    expect(args).toContain("S16_LE");
    expect(args.join(" ")).toContain("-t raw");
  });
});

describe("playbackArgs", () => {
  it("caps the ALSA buffer so barge-in leaves at most ~120 ms of tail", () => {
    const args = playbackArgs("plughw:1,0");
    const index = args.indexOf("--buffer-size");
    expect(index).toBeGreaterThanOrEqual(0);
    // 48 kHz × 0.12 s = 5760 frames.
    expect(Number(args[index + 1])).toBeLessThanOrEqual(5760);
  });
});

describe("createCapture", () => {
  it("emits 320-sample frames from a 48 kHz byte stream", () => {
    const fake = fakeChild();
    const frames: Int16Array[] = [];
    const capture = createCapture({
      device: "plughw:0,0",
      spawn: () => fake.child,
      onFrame: (frame) => frames.push(frame)
    });
    capture.start();

    // 2880 samples at 48 kHz decimate to 960 at 16 kHz = exactly 3 frames.
    const pcm = new Int16Array(2880);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.round(Math.sin(i / 20) * 8000);
    fake.stdout.write(Buffer.from(pcm.buffer));

    expect(frames.length).toBe(3);
    expect(frames[0]!.length).toBe(FRAME_SAMPLES);
  });

  it("tolerates a chunk with an odd byte count", () => {
    const fake = fakeChild();
    const capture = createCapture({ device: "plughw:0,0", spawn: () => fake.child, onFrame: () => {} });
    capture.start();
    expect(() => fake.stdout.write(Buffer.from([1, 2, 3]))).not.toThrow();
  });

  it("survives an error on the capture stream", () => {
    // Unplugging the headset kills arecord mid-stream. Same class of crash as
    // the playback EPIPE: an unhandled 'error' event takes the agent down.
    const fake = fakeChild();
    const capture = createCapture({ device: "plughw:0,0", spawn: () => fake.child, onFrame: () => {} });
    capture.start();
    expect(fake.stdout.listenerCount("error")).toBeGreaterThan(0);
    expect(() => fake.stdout.emit("error", new Error("input/output error"))).not.toThrow();
  });

  it("kills the child on stop", () => {
    const fake = fakeChild();
    const capture = createCapture({ device: "plughw:0,0", spawn: () => fake.child, onFrame: () => {} });
    capture.start();
    capture.stop();
    expect(fake.kill).toHaveBeenCalled();
  });
});

describe("createPlayback", () => {
  it("upsamples 24 kHz to 48 kHz before writing", () => {
    const fake = fakeChild();
    const written: Buffer[] = [];
    fake.stdin.on("data", (chunk: Buffer) => written.push(chunk));
    const playback = createPlayback({ device: "plughw:0,0", spawn: () => fake.child });
    playback.write(new Int16Array(240));
    const total = written.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(total).toBe(240 * 2 * 2); // doubled samples, 2 bytes each
  });

  it("survives EPIPE on the killed child's stdin", () => {
    // Barge-in SIGKILLs aplay; any write already in flight then lands on a dead
    // pipe and Node emits 'error' on the stdin socket. With no handler that is
    // an unhandled 'error' event, which killed the agent on the board the first
    // time a real rider talked over Max.
    const fake = fakeChild();
    const playback = createPlayback({ device: "plughw:0,0", spawn: () => fake.child });
    playback.write(new Int16Array(240));
    expect(fake.stdin.listenerCount("error")).toBeGreaterThan(0);
    expect(() => fake.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
  });

  it("keeps working after a stdin error", () => {
    let spawns = 0;
    const children: ReturnType<typeof fakeChild>[] = [];
    const playback = createPlayback({
      device: "plughw:0,0",
      spawn: () => {
        spawns += 1;
        const f = fakeChild();
        children.push(f);
        return f.child;
      }
    });
    playback.write(new Int16Array(240));
    children[0]!.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    playback.flush();
    playback.write(new Int16Array(240));
    expect(spawns).toBe(2);
  });

  it("respawns aplay on flush so barge-in drops the queued tail", () => {
    let spawns = 0;
    const playback = createPlayback({
      device: "plughw:0,0",
      spawn: () => {
        spawns += 1;
        return fakeChild().child;
      }
    });
    playback.write(new Int16Array(240));
    expect(spawns).toBe(1);
    playback.flush();
    playback.write(new Int16Array(240));
    expect(spawns).toBe(2);
  });
});
