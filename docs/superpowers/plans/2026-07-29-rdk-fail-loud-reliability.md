# RDK Fail-Loud Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every silent failure mode in the RDK embedded client — dead audio children, frozen cameras, black-holed relay sockets, wedged processes, disk errors mid-recording — gets one journal line and an automatic recovery path.

**Architecture:** Crash-only where restart is cheap (capture child death, frozen cameras → log + exit + systemd restart), in-place respawn only where it already exists (`aplay` via `ensure()`), watchdog heartbeats underneath (service-level `WatchdogSec` + hardware `RuntimeWatchdogSec`). No new supervision framework; the existing recovery machinery (`Gallery.reconcile()`, `reap_orphans()`, `Restart=always`) does the work once failures actually reach it.

**Tech Stack:** TypeScript (Node 22, run via tsx, tested with vitest), Python 3.10 stdlib (tested with pytest **on the board only**), systemd unit files, C-free — no new dependencies of any kind.

**Spec:** `docs/superpowers/specs/2026-07-29-rdk-fail-loud-reliability-design.md`

## Global Constraints

- **No new npm or pip dependencies.** Node 22 + `ws` (already present); Python 3.10 stdlib only.
- **Vision pytest runs on the board, not the dev machine** (no local pytest/numpy). Deploy with `scp -r rdk/vision root@<board>:/opt/max/rdk/` and run `ssh root@<board> 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'`. Board IP is network-dependent: `10.42.0.11` as of 2026-07-29; find it with `arp -a`, narrow with `nc -G 2 -z <ip> 22`, confirm with `ssh root@<ip> 'ls /usr/hobot'`.
- **Vitest runs locally:** `npx vitest run tests/<file>.test.ts`. Full gate: `npm run check`.
- **Log convention:** `[tag] message` via `console.log` (TS) / `print(..., flush=True)` (Python). journald supplies timestamps. No logging framework.
- **Do not touch:** AEC constants, the 80 ms pacing cap (`MAX_QUEUE_MS`), `flush()`'s reference-then-kill ordering, the ADAS pipeline, or the recording state machine beyond what a task names.
- **Env toggles:** only the exact string `"1"` enables anything (existing convention).
- Commit after every task; work happens on branch `fix/rdk-fail-loud-reliability`.

---

### Task 1: Capture child death is fatal, loudly

**Files:**
- Modify: `rdk/agent/src/audio/capture.ts`
- Test: `tests/rdk-audio-io.test.ts`

**Interfaces:**
- Produces: `ChildProcessLike.on(event: "exit" | "error", listener)` with real signatures (Task 2 reuses); `CaptureOptions.onFatal?(reason: string): void` (Task 8 wires it in `main.ts`).

- [ ] **Step 1: Upgrade the fake child in `tests/rdk-audio-io.test.ts` to record and fire event listeners**

Replace the existing `fakeChild()` helper (top of file, `on: () => {}`) with:

```ts
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
```

Run: `npx vitest run tests/rdk-audio-io.test.ts` — all existing tests must still pass (the helper is a superset of the old one).

- [ ] **Step 2: Write the failing tests**

Add to the `createCapture` describe block:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/rdk-audio-io.test.ts`
Expected: the three new tests FAIL (`onFatal` is not a known option; no listener fires).

- [ ] **Step 4: Implement in `capture.ts`**

Extend `ChildProcessLike` (this replaces the existing `on` line — keep the doc comment on `stdio`):

```ts
export type ChildProcessLike = {
  stdout: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  /** fd 3 is the far-end reference pipe when the child is max-aec. */
  stdio?: Array<NodeJS.ReadableStream | NodeJS.WritableStream | null>;
  kill(signal?: string): void;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
};
```

Add to `CaptureOptions`:

```ts
  /** A capture child that dies uninvited is unrecoverable in-process: the
   *  agent exits and systemd restarts it. Identity-checked, so stop() never
   *  trips it. */
  onFatal?(reason: string): void;
```

In `start()`, after the `child = options.aec ? spawn(...) : spawn(...)` assignment, add (the `child === current` identity check is what distinguishes an uninvited death from `stop()`, which nulls `child` before the async event arrives):

```ts
      const current = child;
      const name = useAec ? "max-aec" : "arecord";
      current.on("error", (error) => {
        if (child !== current) return;
        child = null;
        options.onFatal?.(`${name} failed to start: ${error.message}`);
      });
      current.on("exit", (code, signal) => {
        if (child !== current) return;
        child = null;
        options.onFatal?.(`${name} exited code=${code} signal=${signal}`);
      });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/rdk-audio-io.test.ts`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 6: Commit**

```bash
git add rdk/agent/src/audio/capture.ts tests/rdk-audio-io.test.ts
git commit -m "fix(rdk): a dead capture child now kills the agent loudly"
```

---

### Task 2: Playback self-heals and stops respawning aplay on an empty queue

**Files:**
- Modify: `rdk/agent/src/audio/playback.ts`
- Test: `tests/rdk-audio-io.test.ts`

**Interfaces:**
- Consumes: `ChildProcessLike` event signatures from Task 1.
- Produces: nothing new — behavior only.

- [ ] **Step 1: Write the failing tests**

Add to the playback describe block in `tests/rdk-audio-io.test.ts`:

```ts
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
  // 24_000 samples at 24 kHz = 1 s — far over the 80 ms cap, so a pump gets scheduled.
  playback.write(new Int16Array(24_000));
  expect(children.length).toBe(1);
  playback.flush();
  for (const fn of scheduled.splice(0)) fn();
  expect(children.length).toBe(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/rdk-audio-io.test.ts`
Expected: test 1 FAILS (dead child still referenced, no respawn), test 3 FAILS (stray pump spawns a second aplay). Test 2 may pass already — keep it as a regression guard.

- [ ] **Step 3: Implement in `playback.ts`**

In `pump()`, add an early return before `ensure()` (an empty queue has nothing to hand over, and `ensure()` here is what let a stray post-flush timer respawn an idle `aplay` that then squats on the ALSA device):

```ts
  function pump(): void {
    pumping = false;
    if (queue.length === 0) return;
    const target = ensure();
    ...
```

In `ensure()`, register identity-checked handlers on the spawned child (after the existing `child.stdin?.on("error", ...)` line):

```ts
  function ensure(): ChildProcessLike {
    if (!child) {
      const spawned = spawn("aplay", playbackArgs(options.device));
      child = spawned;
      // Barge-in SIGKILLs this child, so a write already in flight lands on a
      // dead pipe. ... (keep the existing comment)
      spawned.stdin?.on("error", () => {});
      // flush()/stop() null `child` before this event can arrive, so reaching
      // the body means the death was uninvited — an ALSA hiccup, an OOM kill.
      // Respawn-on-next-write is the already-designed path; take it.
      spawned.on("exit", (code, signal) => {
        if (child !== spawned) return;
        console.log(`[playback] aplay exited code=${code} signal=${signal}; respawning on next write`);
        child = null;
      });
      spawned.on("error", (error) => {
        if (child !== spawned) return;
        console.log(`[playback] aplay failed to start: ${error.message}`);
        child = null;
      });
      upsample = createUpsampler2x();
    }
    return child;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/rdk-audio-io.test.ts`
Expected: PASS, including the pre-existing pacing and priority-lock tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/agent/src/audio/playback.ts tests/rdk-audio-io.test.ts
git commit -m "fix(rdk): playback survives an uninvited aplay death and stray pump timers"
```

---

### Task 3: Alert priority covers the audible alert

**Files:**
- Modify: `rdk/agent/src/audio/playback.ts`
- Test: `tests/rdk-audio-io.test.ts`

**Interfaces:**
- Produces: `releasePriority()` becomes deferred — same signature, new timing contract. Task 4's alert-player keeps calling it in `finally` unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
it("holds priority until the queued alert has audibly finished", () => {
  let clock = 0;
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const fake = fakeChild();
  const playback = createPlayback({
    device: "plughw:0,0",
    spawn: () => fake.child,
    now: () => clock,
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return 0 as unknown as NodeJS.Timeout;
    }
  });
  playback.holdPriority();
  // 12_000 samples at 24 kHz = 500 ms of alert audio.
  playback.write(new Int16Array(12_000));
  playback.releasePriority();

  playback.flush(); // mid-alert: must be refused
  expect(fake.kill).not.toHaveBeenCalled();

  const release = scheduled.find(({ ms }) => ms >= 400);
  expect(release).toBeDefined();
  clock = 600;
  release!.fn();
  playback.flush(); // after the alert: honoured
  expect(fake.kill).toHaveBeenCalled();
});

it("audio queued after the release request does not extend the hold", () => {
  let clock = 0;
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const fake = fakeChild();
  const playback = createPlayback({
    device: "plughw:0,0",
    spawn: () => fake.child,
    now: () => clock,
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return 0 as unknown as NodeJS.Timeout;
    }
  });
  playback.holdPriority();
  playback.write(new Int16Array(12_000)); // the 500 ms alert
  playback.releasePriority();
  const release = scheduled.find(({ ms }) => ms >= 400);
  playback.write(new Int16Array(48_000)); // 2 s of relay speech behind it
  clock = 600;
  release!.fn();
  playback.flush(); // Max's ordinary speech is interruptible again
  expect(fake.kill).toHaveBeenCalled();
});

it("a new alert cancels a stale pending release", () => {
  let clock = 0;
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const fake = fakeChild();
  const playback = createPlayback({
    device: "plughw:0,0",
    spawn: () => fake.child,
    now: () => clock,
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return 0 as unknown as NodeJS.Timeout;
    }
  });
  playback.holdPriority();
  playback.write(new Int16Array(12_000));
  playback.releasePriority();
  const stale = scheduled.find(({ ms }) => ms >= 400);
  playback.holdPriority(); // second alert begins before the first release fires
  clock = 600;
  stale!.fn(); // the stale timer must not drop the new hold
  playback.flush();
  expect(fake.kill).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/rdk-audio-io.test.ts`
Expected: FAIL — today `releasePriority()` drops the lock immediately, so the first `flush()` kills the child.

- [ ] **Step 3: Implement in `playback.ts`**

Track queued duration and a release generation. Near the existing state declarations:

```ts
  let queuedSamples = 0;
  // Incremented by holdPriority/stop so a scheduled release from a previous
  // alert can recognise itself as stale and do nothing.
  let releaseGeneration = 0;
```

Maintain `queuedSamples`: in `write()` after the push (`queuedSamples += processed.length` where `processed` is the value pushed — name the pushed array in a local first); in `pump()` after the shift (`queuedSamples -= chunk.length`); in `flush()` and `stop()` alongside `queue = []` (`queuedSamples = 0`).

Replace `holdPriority`/`releasePriority`:

```ts
    holdPriority(): void {
      releaseGeneration += 1;
      priorityHeld = true;
    },

    /**
     * Deferred: the lock lifts when the audio queued *at this moment* — the
     * alert — has audibly finished, not when it was merely enqueued. Audio
     * queued after this call (Max resuming) does not extend the hold.
     */
    releasePriority(): void {
      if (!priorityHeld) return;
      const at = now();
      const remainingMs = Math.max(0, drainedUntil - at) + (queuedSamples / CAPTURE_RATE) * 1000;
      if (remainingMs <= 0) {
        priorityHeld = false;
        return;
      }
      releaseGeneration += 1;
      const generation = releaseGeneration;
      schedule(() => {
        if (releaseGeneration === generation) priorityHeld = false;
      }, remainingMs);
    },
```

In `stop()`, add `releaseGeneration += 1;` next to the existing `priorityHeld = false;`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/rdk-audio-io.test.ts`
Expected: PASS. The pre-existing priority-lock tests (`tests/rdk-audio-io.test.ts:348-397`) must still pass — if one asserts that `releasePriority()` unlocks immediately *while audio is still queued*, update that assertion to fire the scheduled release first and note why in the test.

- [ ] **Step 5: Commit**

```bash
git add rdk/agent/src/audio/playback.ts tests/rdk-audio-io.test.ts
git commit -m "fix(rdk): the alert priority lock now covers the audible alert, not its enqueue"
```

---

### Task 4: Rename the hazard latency to what it measures

**Files:**
- Modify: `rdk/agent/src/audio/alert-player.ts`, `rdk/agent/src/hazard.ts`, `shared/agent.ts:236-248`, `server/session-controller.ts:217-231`
- Test: `tests/rdk-hazard.test.ts`, `tests/rdk-alert-player.test.ts`, `tests/device-protocol.test.ts`

**Interfaces:**
- Produces: `hazard.report` wire field `handoverMs` (was `latencyMs`). `play()` still returns `Promise<number | null>` — only its meaning is documented.

- [ ] **Step 1: Rename in the four source files**

- `shared/agent.ts`: in the `hazard.report` member, rename `latencyMs?: number;` → `handoverMs?: number;` and rewrite the comment above the member: replace the sentence claiming "`latencyMs` is frame-capture to sound-out" with: `` `handoverMs` is hazard-event to playback-handover; the audible alert finishes later (pacing meters it out at 80 ms a cycle), so this is a plumbing metric, not time-to-audible. ``
- `server/session-controller.ts`: in the `hazard.report` branch, rename the validation (`value.latencyMs` → `value.handoverMs`, error string `"Invalid hazard.report handoverMs"`) and the forwarded field.
- `rdk/agent/src/hazard.ts`: rename the local (`const handoverMs = await options.player.play(...)`) and the report field (`handoverMs`).
- `rdk/agent/src/audio/alert-player.ts`: on `play()`'s doc site (the `createAlertPlayer` return object), add: `/** Resolves the milliseconds it took to HAND the clip to playback. Not time-to-audible: pacing drains the queue at 80 ms per cycle after this returns. */`

- [ ] **Step 2: Update the three test files**

In `tests/rdk-hazard.test.ts`, `tests/rdk-alert-player.test.ts`, and `tests/device-protocol.test.ts`, rename every `hazard.report`-context `latencyMs` to `handoverMs` (assertion keys, fixture objects, and the session-controller validation-error expectations). Leave every non-hazard `latencyMs` (the `metric` event, `server/metrics.ts` session latency) untouched.

- [ ] **Step 3: Run the affected tests**

Run: `npx vitest run tests/rdk-hazard.test.ts tests/rdk-alert-player.test.ts tests/device-protocol.test.ts tests/events.test.ts`
Expected: PASS. If `tests/events.test.ts` fails, it referenced the hazard field — apply the same rename there.

- [ ] **Step 4: Typecheck the server and run the full suite**

Run: `npm test`
Expected: PASS — the rename is closed over agent, shared type, server validation, and tests.

- [ ] **Step 5: Commit**

```bash
git add shared/agent.ts server/session-controller.ts rdk/agent/src/hazard.ts rdk/agent/src/audio/alert-player.ts tests/rdk-hazard.test.ts tests/rdk-alert-player.test.ts tests/device-protocol.test.ts tests/events.test.ts
git commit -m "fix(rdk): hazard.report carries handoverMs, named for what it measures"
```

---

### Task 5: Relay closes become diagnosable, and connect() stops racing itself

**Files:**
- Modify: `rdk/agent/src/relay.ts`
- Test: `tests/rdk-relay-client.test.ts` (create)

**Interfaces:**
- Produces: `createRelayClient(config, handlers, options?)` — new optional third param `{ wsFactory?, pingIntervalMs?, setInterval?, clearInterval?, log? }`; `SocketLike` type. Task 6 extends the same file and test file. `main.ts` keeps calling `createRelayClient(config, handlers)` — options are purely for tests.

- [ ] **Step 1: Create `tests/rdk-relay-client.test.ts` with a fake socket and the failing tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { createRelayClient, type SocketLike } from "../rdk/agent/src/relay";
import type { RdkConfig } from "../rdk/agent/src/config";

const CONFIG = {
  relayUrl: "wss://relay.example/agent",
  relayToken: "tok",
  insecureTls: false
} as RdkConfig;

function fakeSocket() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const socket: SocketLike & { emit(event: string, ...args: unknown[]): void; sent: unknown[] } = {
    binaryType: "",
    readyState: 0, // CONNECTING
    sent: [],
    send(data: unknown) {
      this.sent.push(data);
    },
    close: vi.fn() as unknown as () => void,
    terminate: vi.fn() as unknown as () => void,
    ping: vi.fn() as unknown as () => void,
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    }
  };
  return socket;
}

const HANDLERS = { onEvent: () => {}, onVoice: () => {}, onReady: () => {}, onClosed: () => {} };

describe("createRelayClient lifecycle", () => {
  it("connect() while a socket is open or connecting is a no-op", () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const lines: string[] = [];
    const client = createRelayClient(CONFIG, HANDLERS, {
      wsFactory: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket;
      },
      log: (line) => lines.push(line)
    });
    client.connect();
    client.connect(); // still CONNECTING
    expect(sockets.length).toBe(1);
    expect(lines).toContain("[relay] connect ignored; socket already open");
  });

  it("logs the close code and reason", () => {
    const lines: string[] = [];
    const socket = fakeSocket();
    const client = createRelayClient(CONFIG, HANDLERS, {
      wsFactory: () => socket,
      log: (line) => lines.push(line)
    });
    client.connect();
    socket.emit("close", 4001, Buffer.from("idle"));
    expect(lines.some((line) => line.includes("closed code=4001") && line.includes("idle"))).toBe(true);
  });

  it("logs socket errors with their message", () => {
    const lines: string[] = [];
    const socket = fakeSocket();
    const client = createRelayClient(CONFIG, HANDLERS, {
      wsFactory: () => socket,
      log: (line) => lines.push(line)
    });
    client.connect();
    socket.emit("error", new Error("Unexpected server response: 401"));
    expect(lines.some((line) => line.includes("401"))).toBe(true);
  });

  it("reconnect after a close creates a fresh socket", () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const client = createRelayClient(CONFIG, HANDLERS, {
      wsFactory: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket;
      }
    });
    client.connect();
    sockets[0]!.emit("close", 1006, Buffer.alloc(0));
    client.connect();
    expect(sockets.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/rdk-relay-client.test.ts`
Expected: FAIL — `SocketLike` is not exported and `createRelayClient` takes two arguments.

- [ ] **Step 3: Implement in `relay.ts`**

Add the type and options (after `RelayClient`):

```ts
/** The slice of `ws` the client uses — injectable so the lifecycle is testable. */
export type SocketLike = {
  binaryType: string;
  readyState: number;
  send(data: unknown, options?: { binary?: boolean }): void;
  close(): void;
  terminate(): void;
  ping(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
};

export type RelayClientOptions = {
  wsFactory?: (url: string, options: { rejectUnauthorized: boolean }) => SocketLike;
  pingIntervalMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  log?: (line: string) => void;
};

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
```

Change the signature to `createRelayClient(config: RdkConfig, handlers: RelayHandlers, options: RelayClientOptions = {})` and inside:

```ts
  const log = options.log ?? ((line: string) => console.log(line));
  const wsFactory =
    options.wsFactory ??
    ((url, socketOptions) => new WebSocket(url, socketOptions) as unknown as SocketLike);
```

Rewrite `open()` — guard first, factory instead of `new WebSocket`, close/error logging, and identity-checked teardown:

```ts
  function open(): void {
    if (socket && socket.readyState <= SOCKET_OPEN) {
      log("[relay] connect ignored; socket already open");
      return;
    }
    ready = false;
    intentional = false;
    const current = wsFactory(authorizedRelayUrl(config.relayUrl, config.relayToken), {
      rejectUnauthorized: !config.insecureTls
    });
    socket = current;
    current.binaryType = "nodebuffer";

    current.on("open", () => {
      current.send(JSON.stringify(buildSessionStart(config, memory)));
    });

    current.on("message", (data: Buffer, isBinary: boolean) => {
      // ... body unchanged, but replace every `socket?.send` with `current.send`
    });

    current.on("close", (code: number, reason: Buffer) => {
      const detail = reason && reason.length > 0 ? ` reason=${reason.toString("utf8")}` : "";
      log(`[relay] closed code=${code}${detail}`);
      ready = false;
      if (socket === current) socket = null;
      handlers.onClosed(code === IDLE_CLOSE_CODE || intentional);
    });

    current.on("error", (error: Error) => {
      // `close` always follows; recovery is handled there. This line is the
      // difference between a diagnosable 401 and "reconnects with no explanation".
      log(`[relay] socket error: ${error.message}`);
    });
  }
```

`sendFrame`/`sendEvent`: replace `WebSocket.OPEN` with `SOCKET_OPEN`. The message-handler args keep working because `SocketLike.on` is loosely typed — cast inside the handler where needed (`data as Buffer`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/rdk-relay-client.test.ts tests/rdk-relay.test.ts`
Expected: PASS (the pure-helper tests in `rdk-relay.test.ts` are untouched).

- [ ] **Step 5: Commit**

```bash
git add rdk/agent/src/relay.ts tests/rdk-relay-client.test.ts
git commit -m "fix(rdk): relay closes carry their code, errors their message, connect() its guard"
```

---

### Task 6: Relay liveness ping

**Files:**
- Modify: `rdk/agent/src/relay.ts`
- Test: `tests/rdk-relay-client.test.ts`

**Interfaces:**
- Consumes: `RelayClientOptions.pingIntervalMs / setInterval / clearInterval` from Task 5.
- Produces: a black-holed socket terminates within two ping intervals, funnelling into the existing `close` → `onClosed` → backoff path.

- [ ] **Step 1: Write the failing tests**

```ts
describe("relay liveness", () => {
  function liveClient() {
    const socket = fakeSocket();
    const ticks: Array<() => void> = [];
    const cleared: unknown[] = [];
    const client = createRelayClient(CONFIG, HANDLERS, {
      wsFactory: () => socket,
      pingIntervalMs: 15_000,
      setInterval: ((fn: () => void) => {
        ticks.push(fn);
        return ticks.length as unknown as NodeJS.Timeout;
      }) as typeof globalThis.setInterval,
      clearInterval: ((id: unknown) => {
        cleared.push(id);
      }) as typeof globalThis.clearInterval,
      log: () => {}
    });
    client.connect();
    socket.readyState = 1;
    socket.emit("open");
    return { socket, ticks, cleared };
  }

  it("pings on each interval while the pong keeps coming", () => {
    const { socket, ticks } = liveClient();
    ticks[0]!(); // ping 1
    socket.emit("pong");
    ticks[0]!(); // ping 2
    expect(socket.ping).toHaveBeenCalledTimes(2);
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("terminates a socket whose ping goes unanswered", () => {
    const { socket, ticks } = liveClient();
    ticks[0]!(); // ping, no pong
    ticks[0]!(); // deadline passed
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it("stops the liveness timer when the socket closes", () => {
    const { socket, ticks, cleared } = liveClient();
    ticks[0]!();
    socket.emit("close", 1006, Buffer.alloc(0));
    expect(cleared.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/rdk-relay-client.test.ts`
Expected: FAIL — no timer is started, `ticks` is empty (`ticks[0]` is undefined).

- [ ] **Step 3: Implement in `relay.ts`**

Inside `open()`, before the handlers:

```ts
    const timers = {
      set: options.setInterval ?? globalThis.setInterval,
      clear: options.clearInterval ?? globalThis.clearInterval
    };
    const pingEvery = options.pingIntervalMs ?? 15_000;
    let liveness: NodeJS.Timeout | null = null;
    let awaitingPong = false;
```

In the `open` listener, after sending `session.start`:

```ts
      awaitingPong = false;
      liveness = timers.set(() => {
        if (awaitingPong) {
          // The relay pings from its side too, but neither close crosses a
          // black-holed path. Terminating locally is the only exit.
          log("[relay] no pong within the liveness window; terminating the socket");
          current.terminate();
          return;
        }
        awaitingPong = true;
        current.ping();
      }, pingEvery);
```

Add a `pong` listener next to the others:

```ts
    current.on("pong", () => {
      awaitingPong = false;
    });
```

In the `close` listener, first line: `if (liveness !== null) { timers.clear(liveness); liveness = null; }`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/rdk-relay-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rdk/agent/src/relay.ts tests/rdk-relay-client.test.ts
git commit -m "feat(rdk): the relay client notices a black-holed socket and terminates it"
```

---

### Task 7: Reconnect decisions see the live voice gate

**Files:**
- Modify: `rdk/agent/src/main.ts`
- Test: `tests/rdk-session-policy.test.ts`

**Interfaces:**
- Produces: `export function reconnectDecision(shuttingDown: boolean, idle: boolean, gateOpen: boolean): "now" | "wait-for-voice" | "never"` in `main.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/rdk-session-policy.test.ts` (it already imports from `../rdk/agent/src/main`):

```ts
import { decideReconnect, reconnectDecision } from "../rdk/agent/src/main";

it("an idle close while the rider is speaking reconnects immediately", () => {
  expect(reconnectDecision(false, true, true)).toBe("now");
});

it("an idle close in silence waits for the voice gate", () => {
  expect(reconnectDecision(false, true, false)).toBe("wait-for-voice");
});

it("shutdown never reconnects, whatever the gate says", () => {
  expect(reconnectDecision(true, true, true)).toBe("never");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/rdk-session-policy.test.ts`
Expected: FAIL — `reconnectDecision` is not exported.

- [ ] **Step 3: Implement in `main.ts`**

Below `decideReconnect`:

```ts
/** The onClosed wiring, extracted so a test can prove the gate state is real —
 *  it was hardcoded `false` for a while, which made the "now" branch dead. */
export function reconnectDecision(
  shuttingDown: boolean,
  idle: boolean,
  gateOpen: boolean
): "now" | "wait-for-voice" | "never" {
  const reason: CloseReason = shuttingDown ? "intentional" : idle ? "idle" : "dropped";
  return decideReconnect(reason, gateOpen);
}
```

In `start()`: declare `let gateOpen = false;` next to `waitingForVoice`; in capture's `onFrame`, set it from the gate verdict (`const speaking = gate(frame); gateOpen = speaking;` — `speaking` is already computed there); in `onClosed`, replace the two lines building `reason` and calling `decideReconnect(reason, false)` with `const decision = reconnectDecision(shuttingDown, idle, gateOpen);`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/rdk-session-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rdk/agent/src/main.ts tests/rdk-session-policy.test.ts
git commit -m "fix(rdk): reconnect decisions read the live voice gate, not a hardcoded false"
```

---

### Task 8: Agent heartbeat and process-level nets

**Files:**
- Create: `rdk/agent/src/watchdog.ts`
- Modify: `rdk/agent/src/main.ts`
- Test: `tests/rdk-watchdog.test.ts` (create)

**Interfaces:**
- Produces: `startHeartbeat(options: HeartbeatOptions): { stop(): void }` from `rdk/agent/src/watchdog.ts`.
- Consumes: `CaptureOptions.onFatal` from Task 1 (wired here).

- [ ] **Step 1: Write the failing tests in `tests/rdk-watchdog.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { startHeartbeat } from "../rdk/agent/src/watchdog";

function harness(env: Record<string, string | undefined>, healthy: () => boolean) {
  const ticks: Array<() => void> = [];
  const notifies: number[] = [];
  const lines: string[] = [];
  const heartbeat = startHeartbeat({
    isHealthy: healthy,
    env,
    notify: () => notifies.push(1),
    log: (line) => lines.push(line),
    setInterval: ((fn: () => void) => {
      ticks.push(fn);
      return 1 as unknown as NodeJS.Timeout;
    }) as typeof globalThis.setInterval
  });
  return { ticks, notifies, lines, heartbeat };
}

describe("startHeartbeat", () => {
  it("does nothing outside systemd", () => {
    const { ticks } = harness({}, () => true);
    expect(ticks.length).toBe(0);
  });

  it("notifies on every healthy tick", () => {
    const { ticks, notifies } = harness({ NOTIFY_SOCKET: "/run/notify" }, () => true);
    ticks[0]!();
    ticks[0]!();
    expect(notifies.length).toBe(2);
  });

  it("withholds the heartbeat while unhealthy, and says so once", () => {
    let healthy = true;
    const { ticks, notifies, lines } = harness({ NOTIFY_SOCKET: "/run/notify" }, () => healthy);
    ticks[0]!();
    healthy = false;
    ticks[0]!();
    ticks[0]!();
    expect(notifies.length).toBe(1);
    expect(lines.filter((line) => line.includes("withholding")).length).toBe(1);
    healthy = true;
    ticks[0]!();
    expect(notifies.length).toBe(2);
    expect(lines.some((line) => line.includes("healthy again"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/rdk-watchdog.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `rdk/agent/src/watchdog.ts`**

```ts
/**
 * WATCHDOG=1 heartbeats to systemd, sent only while the component's real job
 * is being done. A wedged-but-alive agent stops heartbeating and systemd
 * restarts it after WatchdogSec — the difference between "running" and
 * "working" that finding a silent dead mic taught us to encode.
 *
 * Node cannot send unix datagrams natively, so the notify default shells out
 * to systemd-notify (one short-lived process per interval; NotifyAccess=all
 * in the unit accepts it). Outside systemd — no NOTIFY_SOCKET — this is
 * entirely inert, so bench runs behave exactly as before.
 */

import { spawn as nodeSpawn } from "node:child_process";

export type HeartbeatOptions = {
  /** True when the real job is happening — e.g. mic frames arriving. */
  isHealthy(): boolean;
  intervalMs?: number;
  notify?: () => void;
  log?: (line: string) => void;
  setInterval?: typeof globalThis.setInterval;
  env?: Record<string, string | undefined>;
};

export function startHeartbeat(options: HeartbeatOptions): { stop(): void } {
  const env = options.env ?? process.env;
  if (!env.NOTIFY_SOCKET) return { stop() {} };

  const log = options.log ?? ((line: string) => console.log(line));
  const notify =
    options.notify ??
    (() => {
      nodeSpawn("systemd-notify", ["WATCHDOG=1"], { stdio: "ignore" }).on("error", () => {});
    });
  const set = options.setInterval ?? globalThis.setInterval;
  let wasHealthy = true;

  const timer = set(() => {
    const healthy = options.isHealthy();
    if (healthy) {
      if (!wasHealthy) log("[watchdog] healthy again; resuming heartbeats");
      notify();
    } else if (wasHealthy) {
      log("[watchdog] unhealthy; withholding heartbeats so systemd restarts us");
    }
    wasHealthy = healthy;
  }, options.intervalMs ?? 10_000);

  return {
    stop(): void {
      clearInterval(timer);
    }
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/rdk-watchdog.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `main.ts`**

In `start()`:

- Next to `waitingForVoice`, add `let lastFrameAt = Date.now();`
- In capture's `onFrame`, first line: `lastFrameAt = Date.now();`
- In the `createCapture` options, add:

```ts
    onFatal: (reason) => {
      console.log(`[capture] ${reason}; exiting for systemd to restart`);
      process.exit(1);
    },
```

- After `capture.start(); relay.connect();`:

```ts
  startHeartbeat({ isHealthy: () => Date.now() - lastFrameAt < 10_000 });
```

- Before the `shutdown` definition:

```ts
  process.on("uncaughtException", (error) => {
    console.log(`[agent] uncaught exception: ${error.stack ?? error.message}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.log(`[agent] unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
    process.exit(1);
  });
```

Import `startHeartbeat` from `./watchdog`.

- [ ] **Step 6: Run the whole agent suite**

Run: `npx vitest run tests/rdk-audio-io.test.ts tests/rdk-session-policy.test.ts tests/rdk-relay-client.test.ts tests/rdk-watchdog.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add rdk/agent/src/watchdog.ts rdk/agent/src/main.ts tests/rdk-watchdog.test.ts
git commit -m "feat(rdk): agent heartbeats while mic frames flow, dies loudly when anything else breaks"
```

---

### Task 9: `sd_notify` helper for the vision sidecar

**Files:**
- Create: `rdk/vision/notify.py`
- Test: `rdk/vision/tests/test_notify.py` (create)

**Interfaces:**
- Produces: `sd_notify(state: str, env=os.environ) -> bool`. Task 10's monitor calls it as `notify("WATCHDOG=1")`.

- [ ] **Step 1: Write the failing tests**

`rdk/vision/tests/test_notify.py` (copy the `sys.path.insert` preamble every test file in this directory uses):

```python
import socket
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from notify import sd_notify


def test_is_a_no_op_outside_systemd():
    assert sd_notify("WATCHDOG=1", env={}) is False


def test_sends_the_state_to_the_notify_socket(tmp_path):
    path = str(tmp_path / "notify.sock")
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as server:
        server.bind(path)
        server.settimeout(2.0)
        assert sd_notify("WATCHDOG=1", env={"NOTIFY_SOCKET": path}) is True
        assert server.recv(64) == b"WATCHDOG=1"


def test_translates_the_abstract_namespace_prefix(tmp_path):
    # systemd passes abstract sockets as "@name"; AF_UNIX wants "\0name".
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as server:
        server.bind("\0max-test-notify")
        server.settimeout(2.0)
        assert sd_notify("READY=1", env={"NOTIFY_SOCKET": "@max-test-notify"}) is True
        assert server.recv(64) == b"READY=1"


def test_swallows_a_missing_socket(tmp_path):
    assert sd_notify("WATCHDOG=1", env={"NOTIFY_SOCKET": str(tmp_path / "gone.sock")}) is False
```

- [ ] **Step 2: Deploy and run on the board to verify they fail**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_notify.py -q'
```

Expected: FAIL with `ModuleNotFoundError: No module named 'notify'`.

- [ ] **Step 3: Create `rdk/vision/notify.py`**

```python
"""sd_notify without a dependency: one datagram to systemd's socket.

The sidecar needs exactly one state (``WATCHDOG=1``) and must not grow a
python3-systemd dependency for it. Outside systemd — no ``NOTIFY_SOCKET`` —
every call is a no-op, so bench runs and tests behave identically.
"""

from __future__ import annotations

import os
import socket


def sd_notify(state: str, env=os.environ) -> bool:
    """Send one state line to systemd. False when not under systemd or on error."""
    path = env.get("NOTIFY_SOCKET")
    if not path:
        return False
    if path.startswith("@"):
        # systemd spells the abstract namespace "@"; AF_UNIX spells it "\0".
        path = "\0" + path[1:]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.connect(path)
            sock.sendall(state.encode("utf-8"))
        return True
    except OSError:
        return False
```

- [ ] **Step 4: Deploy and run on the board to verify they pass**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_notify.py -q'
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/notify.py rdk/vision/tests/test_notify.py
git commit -m "feat(vision): stdlib sd_notify, inert outside systemd"
```

---

### Task 10: Frame-age monitor — freeze detector and heartbeat in one thread

**Files:**
- Create: `rdk/vision/monitor.py`
- Modify: `rdk/vision/mipi_camera.py` (FrameBuffer + MipiCamera age), `rdk/vision/service.py` (wiring)
- Test: `rdk/vision/tests/test_monitor.py` (create), `rdk/vision/tests/test_mipi_camera.py` (age tests)

**Interfaces:**
- Consumes: `sd_notify` from Task 9.
- Produces: `FrameBuffer.age_seconds() -> float | None`, `MipiCamera.age_seconds()` (delegates), `monitor.stale_cameras(cameras) -> list[str]`, `monitor.start_monitor(cameras, notify, on_stale, interval=10.0, wait=None) -> threading.Thread`.

- [ ] **Step 1: Write the failing FrameBuffer tests**

Add to `rdk/vision/tests/test_mipi_camera.py`:

```python
def test_age_is_none_before_any_frame():
    buffer = FrameBuffer("front", 4, 4, encode=lambda n, w, h: b"jpeg")
    assert buffer.age_seconds() is None


def test_age_measures_from_the_last_put():
    clock = iter([100.0, 103.5]).__next__
    buffer = FrameBuffer("front", 4, 4, encode=lambda n, w, h: b"jpeg", clock=clock)
    buffer.put(b"\x00" * 24, t_ms=0)
    assert buffer.age_seconds() == 3.5
```

- [ ] **Step 2: Write the failing monitor tests**

`rdk/vision/tests/test_monitor.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from monitor import STALE_AFTER_SECONDS, stale_cameras, start_monitor


class FakeCamera:
    def __init__(self, age):
        self._age = age

    def age_seconds(self):
        return self._age


class FakePair:
    def __init__(self, front=None, rear=None):
        self.front = front
        self.rear = rear


def test_fresh_cameras_are_not_stale():
    pair = FakePair(front=FakeCamera(0.5), rear=FakeCamera(1.0))
    assert stale_cameras(pair) == []


def test_a_frozen_camera_is_named_with_its_age():
    pair = FakePair(front=FakeCamera(9.0))
    stale = stale_cameras(pair)
    assert len(stale) == 1
    assert "front" in stale[0]
    assert "9.0" in stale[0]


def test_a_camera_that_never_framed_is_stale():
    pair = FakePair(front=FakeCamera(None))
    assert len(stale_cameras(pair)) == 1


def test_a_missing_camera_is_ignored():
    assert stale_cameras(FakePair(front=None, rear=None)) == []


def test_monitor_notifies_while_fresh_then_stops_on_stale():
    pair = FakePair(front=FakeCamera(0.5))
    notified, stale_seen = [], []
    # Three checks: fresh, fresh, then we freeze the camera.
    checks = iter([False, False, False, True])

    def wait(_interval):
        done = next(checks)
        if not done and len(notified) == 2:
            pair.front._age = STALE_AFTER_SECONDS + 1
        return done

    thread = start_monitor(
        pair,
        notify=lambda state: notified.append(state),
        on_stale=lambda stale: stale_seen.append(stale),
        wait=wait,
    )
    thread.join(timeout=2.0)
    assert not thread.is_alive()
    assert notified == ["WATCHDOG=1", "WATCHDOG=1"]
    assert len(stale_seen) == 1
```

- [ ] **Step 3: Run both on the board to verify they fail**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_monitor.py tests/test_mipi_camera.py -q'
```

Expected: monitor tests FAIL (no module), the two new FrameBuffer tests FAIL (`clock` unknown, `age_seconds` missing), pre-existing tests pass.

- [ ] **Step 4: Implement**

`mipi_camera.py` — `FrameBuffer.__init__` gains `clock=time.monotonic`, stores `self._clock = clock` and `self._received_at: float | None = None`. `put()` adds `self._received_at = self._clock()` inside the lock. New method:

```python
    def age_seconds(self) -> float | None:
        """Seconds since the last frame arrived; None before the first one."""
        with self._lock:
            if self._received_at is None:
                return None
            return self._clock() - self._received_at
```

`MipiCamera` gains a delegate next to `latest()`/`jpeg()`:

```python
    def age_seconds(self) -> float | None:
        return self.buffer.age_seconds()
```

`rdk/vision/monitor.py`:

```python
"""Frame-age monitor: heartbeat while frames flow, loud exit when they freeze.

A dead mipi_cam leaves FrameBuffer.latest() returning the last frame forever —
frozen preview, a recorder appending the same stale JPEG, ADAS blocked without
a word. This thread turns that into one journal line and a restart, and its
WATCHDOG=1 heartbeats double as the wedge detector: a process locked hard
enough to stop this thread stops heartbeating, and systemd does the rest.
"""

from __future__ import annotations

import threading

STALE_AFTER_SECONDS = 5.0
CHECK_EVERY_SECONDS = 10.0


def stale_cameras(cameras) -> list[str]:
    """Names of open cameras whose newest frame is older than the threshold."""
    stale = []
    for name in ("front", "rear"):
        camera = getattr(cameras, name)
        if camera is None:
            continue
        age = camera.age_seconds()
        if age is None:
            stale.append(f"{name} (no frame ever)")
        elif age > STALE_AFTER_SECONDS:
            stale.append(f"{name} (last frame {age:.1f}s ago)")
    return stale


def start_monitor(cameras, notify, on_stale, interval=CHECK_EVERY_SECONDS, wait=None) -> threading.Thread:
    """Check every `interval` seconds; heartbeat when fresh, report and end when not.

    `wait` is the test seam: it receives the interval and returns True to stop
    the loop (the default is an Event.wait that never fires).
    """
    stop = threading.Event()
    waiter = wait or stop.wait

    def body() -> None:
        while not waiter(interval):
            stale = stale_cameras(cameras)
            if stale:
                on_stale(stale)
                return
            notify("WATCHDOG=1")

    thread = threading.Thread(target=body, name="frame-monitor", daemon=True)
    thread.start()
    return thread
```

`service.py` — after `cameras.open()` in `main()`:

```python
    from monitor import start_monitor  # noqa: PLC0415
    from notify import sd_notify  # noqa: PLC0415

    def exit_stale(stale: list[str]) -> None:
        print(f"[vision] camera frames stale: {', '.join(stale)}; exiting for systemd to restart", flush=True)
        os._exit(1)

    start_monitor(cameras, notify=sd_notify, on_stale=exit_stale)
```

(`os._exit`, not `sys.exit`: the exit must not depend on which daemon threads are wedged, and systemd's restart plus `reap_orphans` + `reconcile()` is the cleanup path.)

- [ ] **Step 5: Deploy and run on the board to verify they pass**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'
```

Expected: full suite passes (296 pre-existing + new).

- [ ] **Step 6: Commit**

```bash
git add rdk/vision/monitor.py rdk/vision/mipi_camera.py rdk/vision/service.py rdk/vision/tests/test_monitor.py rdk/vision/tests/test_mipi_camera.py
git commit -m "feat(vision): a frozen camera now exits loudly instead of serving stale frames forever"
```

---

### Task 11: Reap once per acquisition, not once per camera

**Files:**
- Modify: `rdk/vision/mipi_camera.py` (remove the reap from `start()`), `rdk/vision/camera.py` (`CameraPair.open`), `rdk/vision/tools/record_ride.py`
- Test: `rdk/vision/tests/test_camera_policy.py`

**Interfaces:**
- Consumes: `reap_orphans()` from `mipi_camera.py` (unchanged signature).
- Produces: behavior only — dual-camera startup survives.

- [ ] **Step 1: Write the failing test**

Add to `rdk/vision/tests/test_camera_policy.py`:

```python
def test_open_reaps_exactly_once_before_the_first_camera(monkeypatch):
    import mipi_camera
    import sensors

    calls = []
    monkeypatch.setattr(mipi_camera, "reap_orphans", lambda: calls.append("reap"))

    class FakeMipi:
        def __init__(self, channel, sensor, camera, width, height):
            self.camera = camera

        def start(self):
            calls.append(f"start-{self.camera}")

        def stop(self):
            pass

    monkeypatch.setattr(mipi_camera, "MipiCamera", FakeMipi)
    monkeypatch.setattr(sensors, "discover", lambda: {0: "IMX219", 2: "IMX219"})

    pair = CameraPair(front_channel=0, rear_channel=2)
    pair.open()

    # One reap, before any camera starts — the per-camera reap is what made
    # the rear camera SIGKILL the front one's just-started mipi_cam.
    assert calls == ["reap", "start-front", "start-rear"]
```

- [ ] **Step 2: Run on the board to verify it fails**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_camera_policy.py -q'
```

Expected: the new test FAILS (`calls` is `["start-front", "start-rear"]` — the reap happens inside `start()`, which the fake replaced, and no pair-level reap exists).

- [ ] **Step 3: Implement**

- `mipi_camera.py`: delete the `reap_orphans()` line from `MipiCamera.start()`. Extend `reap_orphans`'s docstring with one sentence: `Called once per acquisition cycle by the opener (CameraPair.open, record_ride) — never per camera, or the second camera reaps the first.`
- `camera.py`, in `CameraPair.open()`, change the import line and add the reap before the loop:

```python
        from mipi_camera import MipiCamera, reap_orphans  # noqa: PLC0415 - board-only

        # Once for the pair, before the first open — a per-camera reap would
        # SIGKILL the front camera's mipi_cam while starting the rear one.
        reap_orphans()
        attached = discover()
```

  (Keep the existing `from sensors import discover` line and its comment.)
- `tools/record_ride.py`: at its camera-open site (the loop around line 60 that constructs `MipiCamera` and calls `camera.start()`), add `reap_orphans()` once before the loop, importing it alongside the existing `from mipi_camera import MipiCamera` import.

- [ ] **Step 4: Run the full board suite to verify**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'
```

Expected: all pass. If any pre-existing test asserted the reap inside `start()`, move that assertion to the pair-level test — the invariant it protects (crash recovery reacquires the camera) now lives in `open()`.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/mipi_camera.py rdk/vision/camera.py rdk/vision/tools/record_ride.py rdk/vision/tests/test_camera_policy.py
git commit -m "fix(vision): reap ISP orphans once per acquisition so the rear camera stops killing the front"
```

---

### Task 12: The recording writer survives a disk error

**Files:**
- Modify: `rdk/vision/camera.py`
- Test: `rdk/vision/tests/test_camera_policy.py`

**Interfaces:**
- Produces: `CameraPair._append_frame(path: Path, data: bytes)` — the seam the test overrides.

- [ ] **Step 1: Write the failing test**

Add to `rdk/vision/tests/test_camera_policy.py`, reusing the file's existing `pair` and gallery fixtures (match the fixture names the surrounding recording tests use):

```python
def test_a_disk_error_stops_the_recording_with_a_finished_manifest(pair, tmp_path):
    gallery = Gallery(str(tmp_path), min_free_mb=0)
    result = pair.start_recording(gallery, drive=False)
    assert result["status"] == "ok"
    pair_id = pair.recording_id

    pair.write_recording_frame()  # one healthy write first

    def refuse(path, data):
        raise OSError(28, "No space left on device")

    pair._append_frame = refuse
    pair.write_recording_frame()

    # The writer stopped itself cleanly: no recording in flight, and the
    # manifest describes a finished clip rather than staying "recording": true
    # until the next restart's reconcile.
    assert pair.recording_id is None
    manifest = json.loads((gallery.pair_dir(pair_id) / "manifest.json").read_text())
    assert manifest["recording"] is False
```

(If `start_recording`'s signature or the manifest filename differs in the fixture file, mirror how the neighbouring recording tests construct and assert — the invariants under test are `recording_id is None` and `recording: false`.)

- [ ] **Step 2: Run on the board to verify it fails**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_camera_policy.py -q'
```

Expected: FAIL — `_append_frame` does not exist, and once it does exist but is unguarded, the `OSError` propagates out of `write_recording_frame`.

- [ ] **Step 3: Implement in `camera.py`**

Extract the append into a method (below `write_recording_frame`):

```python
    def _append_frame(self, path: Path, data: bytes) -> None:
        with path.open("ab") as handle:
            handle.write(data)
```

In `write_recording_frame`'s per-side loop, replace the inline `open`/`write` with:

```python
            directory.mkdir(parents=True, exist_ok=True)
            try:
                self._append_frame(directory / filename, data)
            except OSError as error:
                # ENOSPC or a dying card. The thread dying here is what left
                # manifests stuck at "recording": true; stop cleanly instead,
                # keeping the frames already on disk. A truncated final JPEG is
                # fine — every reader scans for SOI markers.
                print(f"[vision] recording write failed ({error}); stopping with the frames on disk", flush=True)
                if gallery is not None:
                    self.stop_recording(gallery)
                return
```

- [ ] **Step 4: Run on the board to verify it passes**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_camera_policy.py -q'
```

Expected: PASS, including the existing low-space and cap tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/camera.py rdk/vision/tests/test_camera_policy.py
git commit -m "fix(vision): a disk error finalises the recording instead of killing the writer thread"
```

---

### Task 13: Serialized control-socket writes, and a clean stop that finishes the job

**Files:**
- Modify: `rdk/vision/service.py`
- Test: `rdk/vision/tests/test_control_socket.py` (create)

**Interfaces:**
- Produces: `service.finalize(cameras, gallery, ride) -> None` (extracted shutdown path).

- [ ] **Step 1: Write the failing tests**

`rdk/vision/tests/test_control_socket.py`:

```python
import json
import socket
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import service


def test_concurrent_writes_do_not_interleave(tmp_path):
    """RPC responses and hazard broadcasts share one wfile; every line must
    still parse alone."""
    sock_path = str(tmp_path / "ctl.sock")
    server = service.ControlServer(sock_path, service.ControlHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(sock_path)
        client.settimeout(5.0)

        hammer_done = threading.Event()

        def hammer():
            for i in range(200):
                service.events.broadcast({"event": "hazard", "threat": f"t{i}"})
            hammer_done.set()

        threads = [threading.Thread(target=hammer) for _ in range(4)]
        for thread in threads:
            thread.start()
        for i in range(50):
            client.sendall(
                (json.dumps({"id": i, "method": "camera.photo", "args": {}}) + "\n").encode()
            )
        for thread in threads:
            thread.join(timeout=5.0)

        received = b""
        client.settimeout(1.0)
        try:
            while True:
                chunk = client.recv(65536)
                if not chunk:
                    break
                received += chunk
        except socket.timeout:
            pass

        lines = [line for line in received.decode("utf-8").split("\n") if line]
        assert len(lines) >= 50
        for line in lines:
            json.loads(line)  # raises if two writes interleaved mid-line
    finally:
        server.shutdown()


class FakeRecordingPair:
    def __init__(self):
        self.recording_id = "pair-1"
        self.stopped_with = None
        self.front = None
        self.rear = None

    def stop_recording(self, gallery):
        self.stopped_with = gallery
        self.recording_id = None
        return {"status": "ok"}


class FakeRide:
    def __init__(self):
        self.stopped = False

    def stop(self):
        self.stopped = True


def test_finalize_finishes_a_live_recording_and_stops_the_ride():
    pair = FakeRecordingPair()
    ride = FakeRide()
    sentinel_gallery = object()
    service.finalize(pair, sentinel_gallery, ride)
    assert pair.stopped_with is sentinel_gallery
    assert ride.stopped is True


def test_finalize_tolerates_no_recording_and_no_ride():
    pair = FakeRecordingPair()
    pair.recording_id = None
    service.finalize(pair, object(), None)
    assert pair.stopped_with is None
```

- [ ] **Step 2: Run on the board to verify they fail**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_control_socket.py -q'
```

Expected: `finalize` tests FAIL (`AttributeError`); the interleave test may pass or fail depending on thread timing — it exists to pin the lock in place either way.

- [ ] **Step 3: Implement in `service.py`**

In `ControlHandler.handle`, serialize the shared `wfile`:

```python
    def handle(self) -> None:
        # RPC responses (this thread) and hazard broadcasts (ADAS threads)
        # share one wfile; unsynchronised, they interleave bytes mid-line on a
        # channel whose whole contract is one JSON message per line.
        write_lock = threading.Lock()

        def write(line: str) -> None:
            with write_lock:
                self.wfile.write(line.encode("utf-8"))
                self.wfile.flush()
```

Add module-level `finalize` (above `main()`):

```python
def finalize(cameras, gallery, ride) -> None:
    """Shutdown: finish a live recording, stop the ride, release the cameras.

    An ordinary `systemctl stop` should produce a finished manifest itself
    rather than leaning on the next boot's reconcile.
    """
    if cameras.recording_id is not None:
        cameras.stop_recording(gallery)
    # Ride first among the readers: its threads read from the cameras, so
    # stopping the cameras out from under them would raise on the way down.
    if ride is not None:
        ride.stop()
    for camera in (cameras.front, cameras.rear):
        if camera is not None:
            camera.stop()
```

Replace `main()`'s `finally` body with:

```python
        finally:
            finalize(cameras, gallery, ride)
            import contextlib  # noqa: PLC0415

            with contextlib.suppress(OSError):
                os.unlink(SOCKET_PATH)
```

(Move the `import contextlib` to the top of the file with the other imports instead if the linter prefers — it does.)

- [ ] **Step 4: Run the full board suite**

```bash
scp -r rdk/vision root@10.42.0.11:/opt/max/rdk/
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/service.py rdk/vision/tests/test_control_socket.py
git commit -m "fix(vision): serialized control-socket writes; a clean stop finishes the recording"
```

---

### Task 14: systemd units, hardware watchdog, README

**Files:**
- Modify: `rdk/systemd/max-agent.service`, `rdk/systemd/max-vision.service`, `rdk/README.md`
- Create: `rdk/systemd/10-max-watchdog.conf`

**Interfaces:**
- Consumes: heartbeats from Tasks 8 and 10 (`WatchdogSec` is only safe once both services send `WATCHDOG=1`).

- [ ] **Step 1: Edit `rdk/systemd/max-agent.service`**

Add `StartLimitIntervalSec=0` at the end of `[Unit]`, and `WatchdogSec=30`, `NotifyAccess=all`, `TimeoutStopSec=10` after `RestartSec=2`:

```ini
[Unit]
Description=Max helmet agent (RDK X5)
After=network-online.target max-vision.service
Wants=network-online.target
# Five fast failures inside systemd's default 10 s window would otherwise put
# the unit in permanent `failed` — a silent helmet until someone SSHes in. A
# broken unit should restart visibly forever instead.
StartLimitIntervalSec=0

[Service]
Type=simple
EnvironmentFile=/etc/max/agent.env
WorkingDirectory=/opt/max
ExecStart=/opt/max/node_modules/.bin/tsx /opt/max/rdk/agent/src/main.ts
Restart=always
RestartSec=2
# The agent sends WATCHDOG=1 while mic frames flow (src/watchdog.ts). A
# wedged-but-alive process misses the deadline and gets restarted.
WatchdogSec=30
# Heartbeats arrive from short-lived systemd-notify children, not the main PID.
NotifyAccess=all
TimeoutStopSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Edit `rdk/systemd/max-vision.service`**

Same four directives, same placement (`StartLimitIntervalSec=0` goes under `[Unit]` with the same comment; the vision heartbeat comment reads: `# The sidecar's frame-age monitor sends WATCHDOG=1 while frames flow (monitor.py).`). Everything else stays.

- [ ] **Step 3: Create `rdk/systemd/10-max-watchdog.conf`**

```ini
# Installed to /etc/systemd/system.conf.d/ (see rdk/README.md provisioning).
# PID 1 pets /dev/watchdog (the board's idle dw_wdt): a hard kernel hang
# reboots the board instead of hanging until someone cycles power. Stopping or
# debugging services never trips this — it fires only if systemd itself stops
# running.
[Manager]
RuntimeWatchdogSec=30
```

- [ ] **Step 4: Update `rdk/README.md`**

In "Provisioning", after the `mkdir`/`chown` block, add:

```bash
# Hardware watchdog: a kernel-level hang reboots the board instead of hanging.
sudo mkdir -p /etc/systemd/system.conf.d
sudo cp rdk/systemd/10-max-watchdog.conf /etc/systemd/system.conf.d/
sudo systemctl daemon-reexec
```

In "Running", after the `systemctl enable --now` block, add a short paragraph:

> Both units run under `WatchdogSec=30`: the agent heartbeats while mic frames
> flow, the sidecar while camera frames do, so a wedged-but-alive process is
> restarted instead of impersonating a healthy one. `StartLimitIntervalSec=0`
> means a service that cannot start keeps retrying every 2 s, visibly, instead
> of entering systemd's permanent `failed` state. Bench work is unaffected:
> stopping a service, or running the agent by hand outside systemd (no
> `NOTIFY_SOCKET`), trips nothing.

- [ ] **Step 5: Commit**

```bash
git add rdk/systemd/max-agent.service rdk/systemd/max-vision.service rdk/systemd/10-max-watchdog.conf rdk/README.md
git commit -m "feat(rdk): service and hardware watchdogs, and start limits that never brick"
```

---

### Task 15: Full local gate

**Files:** none new — this is the repo-wide check.

- [ ] **Step 1: Run the full gate**

Run: `npm run check`
Expected: protocol check, prettier, eslint, knip, vitest (all suites), fault matrix, and build all green. Fix anything that falls out (likely candidates: prettier on edited files, an unused import, the `events.test.ts` rename from Task 4).

- [ ] **Step 2: Commit any fixes**

```bash
git add -A
git commit -m "chore(rdk): satisfy the repo gate"
```

(Skip the commit if the gate passed with nothing to fix.)

---

### Task 16: Deploy to the board and verify the failure drills

**Files:** none — deployment and on-hardware verification.

Board IP: `10.42.0.11` as of 2026-07-29 (rediscover per Global Constraints if unreachable). Note: this deploy also ships the agent changes from 2026-07-28 (`camera.look` wiring) that never reached the board — expected, and worth mentioning in the report.

- [ ] **Step 1: Deploy code and units**

```bash
scp -r rdk/agent rdk/vision rdk/aec root@10.42.0.11:/opt/max/rdk/
scp rdk/systemd/max-agent.service rdk/systemd/max-vision.service root@10.42.0.11:/etc/systemd/system/
ssh root@10.42.0.11 'mkdir -p /etc/systemd/system.conf.d'
scp rdk/systemd/10-max-watchdog.conf root@10.42.0.11:/etc/systemd/system.conf.d/
ssh root@10.42.0.11 'systemctl daemon-reload && systemctl daemon-reexec && systemctl restart max-vision max-agent'
```

- [ ] **Step 2: Confirm both services healthy and heartbeating**

```bash
ssh root@10.42.0.11 'sleep 15; systemctl is-active max-agent max-vision; \
  systemctl show max-agent -p WatchdogTimestamp; systemctl show max-vision -p WatchdogTimestamp'
```

Expected: both `active`; both `WatchdogTimestamp` values recent (a fresh timestamp proves `WATCHDOG=1` is arriving — without it, systemd would restart the unit after 30 s).

- [ ] **Step 3: Drill — capture child death**

```bash
ssh root@10.42.0.11 'MAIN=$(systemctl show max-agent -p MainPID --value); \
  AEC=$(pgrep -P "$MAIN" -f max-aec); kill -9 "$AEC"; sleep 8; \
  journalctl -u max-agent -n 40 --no-pager | grep -E "capture|session ready"; systemctl is-active max-agent'
```

Expected: a `[capture] max-aec exited code=null signal=SIGKILL; exiting for systemd to restart` line, then a fresh `[relay] session ready`, service `active`.

- [ ] **Step 4: Drill — wedged agent**

```bash
ssh root@10.42.0.11 'MAIN=$(systemctl show max-agent -p MainPID --value); kill -STOP "$MAIN"; \
  sleep 50; systemctl is-active max-agent; \
  journalctl -u max-agent -n 20 --no-pager | grep -i watchdog'
```

Expected: within ~40 s systemd logs a watchdog timeout and restarts; `is-active` reports `active` with a new MainPID.

- [ ] **Step 5: Drill — frozen camera**

```bash
ssh root@10.42.0.11 'pkill -9 -f "mipi_cam/mipi_cam"; sleep 20; \
  journalctl -u max-vision -n 30 --no-pager | grep -E "stale|recovered|vision"; \
  systemctl is-active max-vision; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8081/preview/front'
```

Expected: a `[vision] camera frames stale: front …; exiting for systemd to restart` line, service back `active`, preview responding `200` again.

- [ ] **Step 6: Run the board pytest suite one final time**

```bash
ssh root@10.42.0.11 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'
```

Expected: all pass.

- [ ] **Step 7: Report the human-only checks**

These need a person wearing the headset; list them in the completion report as outstanding:

1. Live conversation with barge-in (the standing AEC regression bar): Max replies once and stops; talking over him cuts the reply.
2. Kill the hotspot mid-session → `[relay] no pong within the liveness window` within ~30 s; restore → reconnect.
3. Hazard alert with a mid-alert `status: hearing` → the alert plays to completion.
4. The power-meter bench test for the crash-loop root cause (USB power meter or a known-good 5 V/4 A brick during a live voice session) — explicitly outside this plan's scope but the top open reliability question.

---

## Self-review notes

- **Spec coverage:** capture-fatal (T1), playback self-heal + stray pump (T2), alert priority (T3), handover rename (T4), relay logging/guard (T5), liveness ping (T6), gate wiring (T7), process nets + agent heartbeat (T8), sd_notify (T9), frame-age monitor + service wiring (T10), reap-once (T11), writer OSError (T12), write lock + clean stop + unlink (T13), systemd + hardware watchdog + README (T14), repo gate (T15), board drills incl. manual checklist (T16). Every spec section maps to a task; the spec's error-handling table rows are each exercised by a test or drill.
- **Type consistency:** `ChildProcessLike.on` overloads defined in T1 are what T2 registers against; `SocketLike`/`RelayClientOptions` defined in T5 are what T6 consumes; `sd_notify(state, env)` from T9 matches `notify("WATCHDOG=1")` in T10; `finalize(cameras, gallery, ride)` matches its tests.
- **Known flexibility points (not placeholders):** T12's test defers to the fixture file's existing fixture names, and T4's step 2 is a mechanical rename across named files — both are bounded instructions against code the implementer will have open.
