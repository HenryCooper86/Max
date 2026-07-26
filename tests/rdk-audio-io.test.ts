import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { FRAME_SAMPLES } from "../rdk/agent/src/audio/dsp";
import { aecArgs, captureArgs, createCapture } from "../rdk/agent/src/audio/capture";
import { createPlayback, playbackArgs } from "../rdk/agent/src/audio/playback";

function fakeChild() {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const reference = new PassThrough();
  const kill = vi.fn();
  return {
    child: { stdout, stdin, stdio: [null, stdout, null, reference], kill, on: () => {} },
    stdout,
    stdin,
    reference,
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

describe("aecArgs", () => {
  it("passes the device, delay and suppression to max-aec", () => {
    expect(aecArgs("plughw:0,0", 160, 0)).toEqual([
      "--device",
      "plughw:0,0",
      "--delay-ms",
      "160",
      "--suppression",
      "0"
    ]);
  });
});

describe("createCapture with AEC", () => {
  it("spawns max-aec instead of arecord when configured", () => {
    const fake = fakeChild();
    let spawned = "";
    const capture = createCapture({
      device: "plughw:0,0",
      spawn: (cmd) => {
        spawned = cmd;
        return fake.child;
      },
      onFrame: () => {},
      aec: { bin: "/opt/max/rdk/aec/max-aec", delayMs: 160, suppression: 0 }
    });
    capture.start();
    expect(spawned).toBe("/opt/max/rdk/aec/max-aec");
  });

  it("still spawns arecord when AEC is not configured", () => {
    const fake = fakeChild();
    let spawned = "";
    const capture = createCapture({
      device: "plughw:0,0",
      spawn: (cmd) => {
        spawned = cmd;
        return fake.child;
      },
      onFrame: () => {}
    });
    capture.start();
    expect(spawned).toBe("arecord");
  });

  it("does not decimate again — max-aec already emits 16 kHz", () => {
    // Double-decimating would drop the uplink to 5.3 kHz and Doubao would hear
    // a slowed-down rider, so this is the seam worth pinning down.
    const fake = fakeChild();
    const frames: Int16Array[] = [];
    const capture = createCapture({
      device: "plughw:0,0",
      spawn: () => fake.child,
      onFrame: (f) => frames.push(f),
      aec: { bin: "/opt/max/rdk/aec/max-aec", delayMs: 160, suppression: 0 }
    });
    capture.start();
    fake.stdout.write(Buffer.from(new Int16Array(FRAME_SAMPLES * 3).buffer));
    expect(frames.length).toBe(3);
    expect(frames[0]!.length).toBe(FRAME_SAMPLES);
  });

  it("hands the reference pipe to the caller so playback can feed it", () => {
    const fake = fakeChild();
    let handed: NodeJS.WritableStream | null | undefined;
    const capture = createCapture({
      device: "plughw:0,0",
      spawn: () => fake.child,
      onFrame: () => {},
      aec: { bin: "/opt/max/rdk/aec/max-aec", delayMs: 160, suppression: 0 },
      onReference: (stream) => (handed = stream)
    });
    capture.start();
    expect(handed).toBe(fake.reference);
  });

  it("hands over null with AEC off, so the sink stays a no-op", () => {
    const fake = fakeChild();
    let handed: NodeJS.WritableStream | null | undefined = undefined;
    const capture = createCapture({
      device: "plughw:0,0",
      spawn: () => fake.child,
      onFrame: () => {},
      onReference: (stream) => (handed = stream)
    });
    capture.start();
    expect(handed).toBeNull();
  });
});

describe("playback reference", () => {
  it("forwards post-limiter audio to the reference sink", () => {
    const fake = fakeChild();
    const written: number[] = [];
    const playback = createPlayback({
      device: "plughw:0,0",
      spawn: () => fake.child,
      reference: {
        write: (pcm: Int16Array) => written.push(pcm.length),
        flush: () => {},
        close: () => {}
      }
    });
    playback.write(new Int16Array(240)); // 24 kHz in -> 480 at 48 kHz
    expect(written).toEqual([480]);
  });

  it("flushes the reference before killing aplay, not after", () => {
    // Order matters: the reset marker has to sit in the pipe behind the audio
    // it invalidates and ahead of anything that follows.
    const order: string[] = [];
    const fake = fakeChild();
    fake.kill.mockImplementation(() => order.push("kill"));
    const playback = createPlayback({
      device: "plughw:0,0",
      spawn: () => fake.child,
      reference: {
        write: () => {},
        flush: () => order.push("flush"),
        close: () => {}
      }
    });
    playback.write(new Int16Array(240));
    playback.flush();
    expect(order).toEqual(["flush", "kill"]);
  });
});
