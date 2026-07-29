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
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const child = {
    stdout,
    stdin,
    stdio: [null, stdout, null, reference],
    kill,
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    }
  };
  return { child, stdout, stdin, reference, kill };
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

  it("reports a fatal when the capture child dies uninvited", () => {
    const fake = fakeChild();
    const fatals: string[] = [];
    const capture = createCapture({
      device: "plughw:0,0",
      spawn: () => fake.child,
      onFrame: () => {},
      onFatal: (reason) => fatals.push(reason)
    });
    capture.start();
    fake.child.emit("exit", 1, null);
    expect(fatals).toEqual(["arecord exited code=1 signal=null"]);
  });

  it("stays quiet when stop() killed the child itself", () => {
    const fake = fakeChild();
    const fatals: string[] = [];
    const capture = createCapture({
      device: "plughw:0,0",
      spawn: () => fake.child,
      onFrame: () => {},
      onFatal: (reason) => fatals.push(reason)
    });
    capture.start();
    capture.stop();
    fake.child.emit("exit", null, "SIGTERM");
    expect(fatals).toEqual([]);
  });

  it("reports a fatal when the aec binary cannot be spawned", () => {
    const fake = fakeChild();
    const fatals: string[] = [];
    const capture = createCapture({
      device: "plughw:0,0",
      spawn: () => fake.child,
      onFrame: () => {},
      onFatal: (reason) => fatals.push(reason),
      aec: { bin: "/opt/max/rdk/aec/max-aec", delayMs: 80, suppression: 2 }
    });
    capture.start();
    fake.child.emit("error", new Error("spawn ENOENT"));
    expect(fatals).toEqual(["max-aec failed to start: spawn ENOENT"]);
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

  it("respawns aplay on the write after an uninvited death", () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const playback = createPlayback({
      device: "plughw:0,0",
      spawn: () => {
        const fake = fakeChild();
        children.push(fake);
        return fake.child;
      }
    });
    playback.write(new Int16Array(480));
    expect(children.length).toBe(1);
    children[0]!.child.emit("exit", 1, null);
    playback.write(new Int16Array(480));
    expect(children.length).toBe(2);
  });

  it("does not double-handle an exit that flush() itself caused", () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const playback = createPlayback({
      device: "plughw:0,0",
      spawn: () => {
        const fake = fakeChild();
        children.push(fake);
        return fake.child;
      }
    });
    playback.write(new Int16Array(480));
    playback.flush(); // kills child, nulls the reference
    children[0]!.child.emit("exit", null, "SIGKILL");
    playback.write(new Int16Array(480));
    // flush + write already accounts for the respawn; the exit event must not
    // have spawned a third.
    expect(children.length).toBe(2);
  });

  it("a pump timer left over from flush does not respawn aplay", () => {
    const scheduled: Array<() => void> = [];
    const children: ReturnType<typeof fakeChild>[] = [];
    const playback = createPlayback({
      device: "plughw:0,0",
      spawn: () => {
        const fake = fakeChild();
        children.push(fake);
        return fake.child;
      },
      now: () => 0,
      schedule: (fn) => {
        scheduled.push(fn);
        return 0 as unknown as NodeJS.Timeout;
      }
    });
    // Enqueue 50 × 480 samples (20 ms each at 24 kHz) = 1 s total — far over the 80 ms cap.
    // pump() will consume ~80 ms of audio, reschedule itself, then leave the queue non-empty.
    for (let i = 0; i < 50; i += 1) playback.write(new Int16Array(480));
    expect(children.length).toBe(1);
    playback.flush(); // nulls child, empties queue
    for (const fn of scheduled.splice(0)) fn();
    // After flush(), queue is empty. The rescheduled pump must not spawn a second child.
    expect(children.length).toBe(1);
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

describe("playback pacing", () => {
  // The relay delivers TTS faster than realtime. Writing it straight into
  // aplay's stdin parks it in a 64 KB pipe — 683 ms at 48 kHz — plus the 120 ms
  // ALSA buffer. The reference was emitted at queue time, so the echo reached
  // the mic ~950 ms after APM had been told about it (measured on the board).
  // WebRTC's filter spans ~500 ms at best, so it saw no echo at all and
  // reported ERLE -100 dB. Pacing keeps the gap inside the filter's reach.
  function harness() {
    const fake = fakeChild();
    let now = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const reference: number[] = [];
    const playback = createPlayback({
      device: "plughw:0,0",
      spawn: () => fake.child,
      now: () => now,
      schedule: (fn, ms) => {
        timers.push({ at: now + ms, fn });
        return 0 as unknown as NodeJS.Timeout;
      },
      reference: {
        write: (pcm: Int16Array) => reference.push(pcm.length),
        flush: () => {},
        close: () => {}
      }
    });
    const advance = (ms: number) => {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      due.forEach((t) => timers.splice(timers.indexOf(t), 1));
      due.forEach((t) => t.fn());
    };
    return { fake, playback, advance, reference, written: () => fake.stdin.readableLength };
  }

  it("does not dump a whole utterance into the pipe at once", () => {
    const { playback, written } = harness();
    // 2 s of speech, delivered instantly the way the relay delivers it.
    for (let i = 0; i < 100; i += 1) playback.write(new Int16Array(480));
    // At 48 kHz stereo-free PCM16, 200 ms is 19200 bytes. Anything close to the
    // full 2 s (384000 bytes) means it went straight through.
    expect(written()).toBeLessThan(40000);
  });

  it("keeps feeding aplay as time passes", () => {
    const { playback, advance, written } = harness();
    for (let i = 0; i < 100; i += 1) playback.write(new Int16Array(480));
    const early = written();
    advance(1000);
    expect(written()).toBeGreaterThan(early);
  });

  it("emits the reference as audio reaches the DAC, not when it is queued", () => {
    const { playback, advance, reference } = harness();
    for (let i = 0; i < 100; i += 1) playback.write(new Int16Array(480));
    const queued = reference.reduce((a, b) => a + b, 0);
    expect(queued).toBeLessThan(48000); // under 1 s of the 2 s written
    advance(2000);
    const after = reference.reduce((a, b) => a + b, 0);
    expect(after).toBeGreaterThan(queued);
  });

  it("drops audio still queued when the rider barges in", () => {
    const { playback, advance, reference } = harness();
    for (let i = 0; i < 100; i += 1) playback.write(new Int16Array(480));
    playback.flush();
    const atFlush = reference.reduce((a, b) => a + b, 0);
    advance(2000);
    // Nothing more may play: the rider interrupted, so the tail is gone.
    expect(reference.reduce((a, b) => a + b, 0)).toBe(atFlush);
  });
});

describe("playback priority lock", () => {
  it("ignores a flush while an alert holds priority", () => {
    // A rider saying "什么?" mid-warning trips Doubao's VAD. Without this lock
    // that barge-in cuts the collision alert in half, and a warning a startled
    // rider can cancel by flinching is worse than no warning at all.
    const fake = fakeChild();
    const playback = createPlayback({ device: "plughw:0,0", spawn: () => fake.child });
    playback.write(new Int16Array(240));
    playback.holdPriority();
    playback.flush();
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it("resumes honouring flush once the alert finishes", () => {
    const fake = fakeChild();
    const playback = createPlayback({ device: "plughw:0,0", spawn: () => fake.child });
    playback.write(new Int16Array(240));
    playback.holdPriority();
    playback.releasePriority();
    playback.flush();
    expect(fake.kill).toHaveBeenCalled();
  });

  it("does not send a reference reset for audio it did not discard", () => {
    // The reset marker tells max-aec to forget queued far-end audio. Sending it
    // when nothing was dropped makes APM forget an echo that is still coming.
    const fake = fakeChild();
    let flushes = 0;
    const playback = createPlayback({
      device: "plughw:0,0",
      spawn: () => fake.child,
      reference: { write: () => {}, flush: () => (flushes += 1), close: () => {} }
    });
    playback.holdPriority();
    playback.flush();
    expect(flushes).toBe(0);
  });

  it("still stops on shutdown even while an alert holds priority", () => {
    // stop() is process teardown, not barge-in. Refusing it would keep aplay
    // alive after the agent exits.
    const fake = fakeChild();
    const playback = createPlayback({ device: "plughw:0,0", spawn: () => fake.child });
    playback.write(new Int16Array(240));
    playback.holdPriority();
    playback.stop();
    expect(fake.kill).toHaveBeenCalled();
  });
});

describe("aecArgs dump", () => {
  it("omits the dump flag when no prefix is configured", () => {
    expect(aecArgs("plughw:0,0", 80, 2)).not.toContain("--dump-prefix");
  });

  it("passes the prefix through when debugging the echo path", () => {
    expect(aecArgs("plughw:0,0", 80, 2, "/tmp/aecdump")).toEqual([
      "--device",
      "plughw:0,0",
      "--delay-ms",
      "80",
      "--suppression",
      "2",
      "--dump-prefix",
      "/tmp/aecdump"
    ]);
  });
});
