# Vision V-C: Proactive Scene Watching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in ambient observation from the helmet camera: the board samples 1 frame/30 s behind a scene-change gate, and Max volunteers at most one short non-hazard observation per two minutes — never over ADAS, never over speech, ≤40 model calls/hour, every drop metered.

**Architecture:** "开启环境观察" → `vision.watch { on }` (embedded-gated) reaches the board's existing vision RPC path untouched; the Python vision process runs a sampler thread (ride.py's `_stop.wait` idiom) over the same `FrameBuffer` ADAS reads, gates on grayscale-histogram distance vs the last _shipped_ frame, and broadcasts a `watch.frame` event; the TS agent forwards it as an unsolicited `vision.frames { reason: "watch" }`. The relay's pure `server/vision-governor.ts` (per session, per provider) applies the Conservative rules in order — disabled, budget, ADAS window, speech gate, cooldown — then asks the vision core with a dedicated watching prompt whose "无。" sentinel separates nothing-notable from model failure. Watching dies with the session twice over: the agent switches the board off when the relay socket drops, and the governor's `disabled` rule refuses frames from any session that never enabled it.

**Tech Stack:** TypeScript (relay + rdk/agent, vitest), Python 3.10 (rdk/vision, pytest, cv2/numpy via requirements-dev — available off-board). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-06-vision-expansion-design.md`, section "M3 — proactive scene watching".

**Conscious scope note (surfaced at plan review):** the spec's "also a switch in the settings sheet" is DEFERRED — no client has a path to issue relay device commands from a settings toggle today, and inventing one is out of Conservative-v1 proportion. Voice toggle only; ledger the deferral.

## Global Constraints

- Conservative constants (binding, one tunable block per side): sample interval 30 s; hourly model-call cap 40/session; spoken cooldown 2 min; ADAS-dedupe window 30 s; watch frames are single (`total` 1, `index` 0), no `commandId`.
- Governor rule ORDER is binding: 1 disabled → 2 budget → 3 adas-window → 4 speech (drop, never queue) → 5 cooldown → describe → sentinel/null handling. Drop reasons exactly: `"disabled" | "budget" | "adas-window" | "speech" | "cooldown" | "nothing-notable" | "model-failure"`, each metered.
- Watching failures are SILENT (no unprompted "我看不清"); rider-initiated paths keep speaking failures.
- The watching prompt (exact, exported as `WATCH_PROMPT` from server/vision.ts): "如果这张照片里有一件值得骑手注意的非危险情况，用一句话说出来。如果没有值得说的，只回答：无。" — an answer of "无" / "无。" (trimmed) = nothing-notable; null = model failure. `MockVisionProvider` answers the watch prompt with exactly "前方有施工路段，注意慢行。" so keyless demos speak (the cooldown governs frequency).
- Toggle speech (exact): on → "已开启环境观察。", off → "已关闭环境观察。". Grammar: /(开启|打开)(一下)?环境观察/ → on, /(关闭|停止|取消)(一下)?环境观察/ → off, English /\bstart (scene )?watching\b/i → on, /\bstop (scene )?watching\b/i → off. `PLATFORM_RESTRICTED_ACTIONS["vision.watch"] = "embedded"`; tier low; `ACTION_LABELS["vision.watch"] = "环境观察"`.
- Off by default; dies with the session: (a) rdk/agent disables the board sampler when the relay socket closes; (b) the vision process disables it when the control connection that owns it disconnects; (c) the governor's `disabled` rule is the relay-side belt-and-braces.
- Wire validation: `reason: "watch"` becomes valid; for watch, `commandId` must be ABSENT, `index` must be 0, `total` must be 1 (throw otherwise); gallery validation unchanged.
- Board gate bookkeeping: the "last shipped" reference frame updates ONLY when a frame is actually broadcast (a gated-out frame never becomes the reference).
- rdk Python constants live in a frozen `WatchTuning` dataclass with a `fingerprint()` (mirroring `rdk/vision/adas/tuning.py`); the Python suite must stay hermetic off-board: `python3 -m pytest -c rdk/vision/pytest.ini -m "not hardware" --strict-markers rdk/vision/tests` green with cv2/numpy from requirements-dev, no camera/ROS/BPU imports.
- After schema edits: `npm run generate:protocol`, commit ALL generated siblings, `npm run check:protocol` exit 0. No ios/ or android/ changes beyond generated files.
- 2-space indent, double quotes, semicolons (TS); prettier + `npx tsc --noEmit` per TS task; full `npm run check` AND the rdk Python gate green at the end.

---

### Task 1: Protocol + `vision.watch` action plumbing

**Files:**

- Modify: `protocol/agent-events.schema.json` (DeviceCommand action enum += "vision.watch"; VisionFrames `reason` enum → ["gallery", "watch"], `commandId` dropped from `required`)
- Modify: generated siblings via `npm run generate:protocol` only
- Modify: `shared/agent.ts` (`VisionFramesEvent`: `reason: "gallery" | "watch"`, `commandId?: string`, doc comment updated)
- Modify: `server/session-controller.ts` (reason-conditional validation)
- Modify: `server/device-actions.ts` (action name/union/tier/gate/label/okSpeech/grammar; `IssuedDeviceCommand.watchOn?: boolean` + `issue(action, okSpeech?, now = Date.now(), question?, watchOn?)`)
- Test: `tests/vision-frames-protocol.test.ts` (extend), `tests/device-actions.test.ts` (extend)

**Interfaces:**

- Produces (later tasks rely on):
  - `VisionFramesEvent` with `reason: "gallery" | "watch"` and `commandId?: string`.
  - `DeviceCommand` variant `{ action: "vision.watch"; args: { on: boolean } }`.
  - `issue(...)` fifth positional `watchOn?: boolean`, stored on the entry (Task 3 flips the governor on the result ok).
  - Validation contract: gallery → commandId required (≤120), question ≤500 bytes; watch → commandId ABSENT (throw if present), index === 0, total === 1, question absent (throw if present — watch carries no question).

- [ ] **Step 1: Write the failing tests**

Append to `tests/vision-frames-protocol.test.ts`:

```ts
describe("parseClientEvent vision.frames watch reason", () => {
  const watch = { type: "vision.frames", reason: "watch", index: 0, total: 1, image: "aGVsbG8=" };

  it("accepts a bare watch frame", () => {
    expect(parseClientEvent(encode(watch))).toMatchObject({
      type: "vision.frames",
      reason: "watch",
      index: 0,
      total: 1
    });
  });

  it("rejects watch frames with a commandId, a question, or multi-frame shape", () => {
    expect(() => parseClientEvent(encode({ ...watch, commandId: "c1" }))).toThrow(/commandId/);
    expect(() => parseClientEvent(encode({ ...watch, question: "x" }))).toThrow(/question/);
    expect(() => parseClientEvent(encode({ ...watch, total: 2, index: 1 }))).toThrow(/total/);
  });

  it("still requires commandId for gallery", () => {
    expect(() =>
      parseClientEvent(encode({ type: "vision.frames", reason: "gallery", index: 0, total: 1, image: "x" }))
    ).toThrow(/commandId/);
  });
});
```

Append to `tests/device-actions.test.ts`:

```ts
describe("vision.watch", () => {
  it("detects the toggle phrases in both languages", () => {
    expect(extractDeviceCommand("开启环境观察")).toMatchObject({ action: "vision.watch", args: { on: true } });
    expect(extractDeviceCommand("打开一下环境观察")).toMatchObject({ action: "vision.watch", args: { on: true } });
    expect(extractDeviceCommand("关闭环境观察")).toMatchObject({ action: "vision.watch", args: { on: false } });
    expect(extractDeviceCommand("stop watching")).toMatchObject({ action: "vision.watch", args: { on: false } });
    expect(extractDeviceCommand("start scene watching")).toMatchObject({ action: "vision.watch", args: { on: true } });
  });

  it("does not fire on unrelated 观察/watch phrases", () => {
    expect(extractDeviceCommand("观察一下路况")).toBeNull();
    expect(extractDeviceCommand("watch out")).toBeNull();
  });

  it("is embedded-gated with honest toggle speech", () => {
    expect(extractDeviceCommandForPlatform("开启环境观察", "embedded")).toMatchObject({ action: "vision.watch" });
    expect(extractDeviceCommandForPlatform("开启环境观察", "ios")).toBeNull();
    expect(deviceSuccessSpeech({ action: "vision.watch", args: { on: true } })).toBe("已开启环境观察。");
    expect(deviceSuccessSpeech({ action: "vision.watch", args: { on: false } })).toBe("已关闭环境观察。");
  });

  it("carries watchOn through PendingDeviceCommands", () => {
    const pending = new PendingDeviceCommands();
    const issued = pending.issue("vision.watch", "已开启环境观察。", Date.now(), undefined, true);
    expect(pending.peek(issued.commandId)?.watchOn).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — both files: new tests fail, existing pass.

- [ ] **Step 3: Implement**

Schema: add `"vision.watch"` to the action enum; VisionFrames `reason` enum `["gallery", "watch"]`; remove `"commandId"` from the `required` array (runtime enforces conditionally). Regenerate.

`shared/agent.ts`: update the type + comment ("gallery frames carry the commandId of the gallery.describe they answer; watch frames are unsolicited and carry none").

`parseClientEvent` vision.frames branch becomes reason-first:

```ts
if (value.reason !== "gallery" && value.reason !== "watch") throw new Error("Invalid vision.frames reason");
if (value.reason === "watch") {
  if (value.commandId !== undefined) throw new Error("Invalid vision.frames commandId for watch");
  if (value.question !== undefined) throw new Error("Invalid vision.frames question for watch");
  if (value.total !== 1) throw new Error("Invalid vision.frames total for watch");
  if (value.index !== 0) throw new Error("Invalid vision.frames index for watch");
  // image check shared below; return { type, reason: "watch", index: 0, total: 1, image }
} else {
  // existing gallery checks unchanged (commandId required, caps, question ≤500 bytes)
}
```

(Structure it so the image cap check is written once; allowlisted reconstruction per branch.)

`device-actions.ts`: all entries per Global Constraints; grammar block placed with the other toggles (before matchCamera is not needed — 环境观察 collides with nothing; put it near the top-level toggle matches and add one negative-lookahead-free comment); `watchOn` stored by `issue`.

- [ ] **Step 4: Verify** — `npx vitest run tests/vision-frames-protocol.test.ts tests/device-actions.test.ts tests/device-protocol.test.ts` green; `npm run check:protocol` 0; `npm test` once (widely-imported files); `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write protocol/agent-events.schema.json shared/agent.ts server/session-controller.ts server/device-actions.ts tests/vision-frames-protocol.test.ts tests/device-actions.test.ts
git add -A -- protocol shared server tests ios/MaxHelmet/Agent/GeneratedAgentProtocol.swift android
git commit -m "feat(vision): vision.watch toggle and the watch frame reason"
```

---

### Task 2: The governor (`server/vision-governor.ts`) + watch prompt + metrics

**Files:**

- Create: `server/vision-governor.ts`
- Modify: `server/vision.ts` (export `WATCH_PROMPT`; MockVisionProvider answers it with "前方有施工路段，注意慢行。")
- Modify: `server/metrics.ts` (a `watchDrops` per-reason counter object on the existing `metrics` export at ~line 75, following its current fields' style, plus a `watchDrop(reason: string)` increment method; surface the counters wherever that object's fields already surface)
- Test: `tests/vision-governor.test.ts`, `tests/vision.test.ts` (extend: WATCH_PROMPT mock answer)

**Interfaces:**

- Consumes: `VisionProvider.describe(frames, question?)` (V-A).
- Produces (Task 3 consumes):

```ts
export type WatchDropReason =
  "disabled" | "budget" | "adas-window" | "speech" | "cooldown" | "nothing-notable" | "model-failure";

export function createVisionGovernor(options: {
  describe(frames: string[], question?: string): Promise<string | null>;
  speak(line: string): void;
  isSpeechOpen(): boolean;
  onDrop(reason: WatchDropReason): void;
  now?(): number; // injectable clock
  hourlyCap?: number; // default 40
  cooldownMs?: number; // default 120_000
  adasWindowMs?: number; // default 30_000
}): {
  setEnabled(on: boolean): void;
  noteHazard(): void;
  handleWatchFrame(image: string): Promise<void>;
};
```

Behavior (binding, rule order from Global Constraints): `handleWatchFrame` evaluates rules 1-5 with `now()`; a drop calls `onDrop(reason)` and returns without describing. Surviving frames call `describe([image], WATCH_PROMPT)` — the call itself counts against the hourly budget (a rolling window: count calls whose timestamp is within the last 3 600 000 ms). Answer handling: null → `onDrop("model-failure")` silently; trimmed "无" or "无。" → `onDrop("nothing-notable")`; anything else → `speak(line)` and record the spoken timestamp for the cooldown. `setEnabled(false)` does not reset the budget window (quota is per session-hour regardless of toggling). `noteHazard()` records the hazard timestamp for rule 3.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/vision-governor.test.ts
import { describe, expect, it } from "vitest";
import { createVisionGovernor, type WatchDropReason } from "../server/vision-governor";
import { WATCH_PROMPT } from "../server/vision";

function harness(overrides: Partial<Parameters<typeof createVisionGovernor>[0]> = {}) {
  const drops: WatchDropReason[] = [];
  const spoken: string[] = [];
  const described: Array<{ frames: string[]; question?: string }> = [];
  let clock = 0;
  let speechOpen = false;
  let answer: string | null = "前方有慢车。";
  const governor = createVisionGovernor({
    describe: async (frames, question) => {
      described.push({ frames, question });
      return answer;
    },
    speak: (line) => spoken.push(line),
    isSpeechOpen: () => speechOpen,
    onDrop: (reason) => drops.push(reason),
    now: () => clock,
    ...overrides
  });
  return {
    governor,
    drops,
    spoken,
    described,
    setClock: (t: number) => (clock = t),
    setSpeechOpen: (v: boolean) => (speechOpen = v),
    setAnswer: (a: string | null) => (answer = a)
  };
}

describe("createVisionGovernor", () => {
  it("drops disabled frames — off by default", async () => {
    const h = harness();
    await h.governor.handleWatchFrame("F");
    expect(h.drops).toEqual(["disabled"]);
    expect(h.described).toHaveLength(0);
  });

  it("speaks a notable observation with the watch prompt", async () => {
    const h = harness();
    h.governor.setEnabled(true);
    await h.governor.handleWatchFrame("F");
    expect(h.described).toEqual([{ frames: ["F"], question: WATCH_PROMPT }]);
    expect(h.spoken).toEqual(["前方有慢车。"]);
    expect(h.drops).toEqual([]);
  });

  it("enforces the 2 min cooldown after speaking", async () => {
    const h = harness();
    h.governor.setEnabled(true);
    await h.governor.handleWatchFrame("A");
    h.setClock(60_000);
    await h.governor.handleWatchFrame("B");
    expect(h.drops).toEqual(["cooldown"]);
    h.setClock(121_000);
    await h.governor.handleWatchFrame("C");
    expect(h.spoken).toHaveLength(2);
  });

  it("drops inside the 30 s ADAS window", async () => {
    const h = harness();
    h.governor.setEnabled(true);
    h.governor.noteHazard();
    h.setClock(29_000);
    await h.governor.handleWatchFrame("F");
    expect(h.drops).toEqual(["adas-window"]);
    h.setClock(31_000);
    await h.governor.handleWatchFrame("F");
    expect(h.spoken).toHaveLength(1);
  });

  it("drops while speech is open — never queues", async () => {
    const h = harness();
    h.governor.setEnabled(true);
    h.setSpeechOpen(true);
    await h.governor.handleWatchFrame("F");
    expect(h.drops).toEqual(["speech"]);
    h.setSpeechOpen(false);
    expect(h.spoken).toHaveLength(0); // nothing replays later
  });

  it("caps model calls at 40 per rolling hour", async () => {
    const h = harness({ cooldownMs: 0 });
    h.governor.setEnabled(true);
    for (let call = 0; call < 40; call += 1) {
      h.setClock(call * 1000);
      await h.governor.handleWatchFrame("F");
    }
    expect(h.described).toHaveLength(40);
    await h.governor.handleWatchFrame("F");
    expect(h.drops).toEqual(["budget"]);
    h.setClock(3_601_000); // first call ages out of the rolling window
    await h.governor.handleWatchFrame("F");
    expect(h.described).toHaveLength(41);
  });

  it("separates nothing-notable from model failure", async () => {
    const h = harness({ cooldownMs: 0 });
    h.governor.setEnabled(true);
    h.setAnswer("无。");
    await h.governor.handleWatchFrame("F");
    h.setAnswer(null);
    await h.governor.handleWatchFrame("F");
    expect(h.drops).toEqual(["nothing-notable", "model-failure"]);
    expect(h.spoken).toHaveLength(0);
  });

  it("rules apply in order — disabled wins over everything", async () => {
    const h = harness();
    h.governor.setEnabled(true);
    h.governor.setEnabled(false);
    h.governor.noteHazard();
    h.setSpeechOpen(true);
    await h.governor.handleWatchFrame("F");
    expect(h.drops).toEqual(["disabled"]);
  });
});
```

Extend `tests/vision.test.ts`:

```ts
it("answers the watch prompt with the fixed observation", async () => {
  const provider = createMockVisionProvider();
  expect(await provider.describe(["F"], WATCH_PROMPT)).toBe("前方有施工路段，注意慢行。");
});
```

(Import `WATCH_PROMPT` at the top.)

- [ ] **Step 2: Run to verify failure** — modules/exports missing.

- [ ] **Step 3: Implement** the governor (header comment in the vision.ts voice: why drop-not-queue — a stale observation is worse than none; why the sentinel exists — the core's empty-content null cannot distinguish "nothing to say" from "the model broke"), `WATCH_PROMPT` + the mock branch (checked BEFORE the generic question branch in MockVisionProvider), and the metrics counter.

- [ ] **Step 4: Verify** — `npx vitest run tests/vision-governor.test.ts tests/vision.test.ts tests/metrics.test.ts` green; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/vision-governor.ts server/vision.ts server/metrics.ts tests/vision-governor.test.ts tests/vision.test.ts
git add server/vision-governor.ts server/vision.ts server/metrics.ts tests/vision-governor.test.ts tests/vision.test.ts
git commit -m "feat(vision): the watch governor with metered conservative rules"
```

---

### Task 3: Provider wiring — watch frames reach the governor

**Files:**

- Modify: `server/providers/types.ts` (`hazardReport?(event: HazardReportEvent): Promise<void>;` — check shared/agent.ts for the parsed hazard.report type name and use it)
- Modify: `server/session-controller.ts` (forward: `if (event.type === "hazard.report") await this.provider.hazardReport?.(event);` beside the other forwards — the FIRST consumer of this event; keep the existing "never echo back" comment intact)
- Modify: `server/providers/doubao.ts`, `server/providers/mock.ts`
- Test: `tests/doubao-watch.test.ts` (create), `tests/mock-watch.test.ts` (create) — study the harnesses of tests/doubao-vision-frames.test.ts and tests/mock-vision-frames.test.ts first; their idioms govern

**Interfaces:**

- Consumes: `createVisionGovernor` + `WatchDropReason` (Task 2), `metrics.watchDrop` (Task 2), `IssuedDeviceCommand.watchOn` (Task 1), each provider's existing visionFrames/speech machinery (V-B).
- Produces, per provider:
  - `visionFrames` branches on reason FIRST: `"watch"` → `void governor.handleWatchFrame(event.image)` (fire-and-forget with a `.catch` backstop — the session queue must never stall behind a describe); `"gallery"` → the existing V-B path (guard on `event.commandId` presence for type narrowing).
  - Governor construction per provider instance: `describe` = the provider's vision provider; `speak` = the provider's own speech path (doubao: transcriptEvent + speaker.speak with a FRESH delivery captured at speak time — watch lines belong to no rider turn, so mirror how the mock allocates a fresh delivery rather than reusing a turn's; mock: final agent transcript, useBrowserSpeech true); `isSpeechOpen` = provider-specific probe (see below); `onDrop` = `metrics.watchDrop`.
  - `isSpeechOpen` contract: true while the agent is audibly speaking or a rider turn is mid-flight. doubao: derive from its existing turn/speaking state (the implementer locates the bindings that drive the "speaking"/"hearing"/"thinking" status events and the speaker's active playback; document the exact fields chosen in the report — the reviewer will judge the choice). mock: true while a scripted turn's reply timer is pending.
  - Enable/disable: in `deviceResult`, when the resolved entry has `action === "vision.watch"` and `status === "ok"`, call `governor.setEnabled(issued.watchOn === true)`. The dispatch site passes `watchOn` (from `command.args.on`) into `issue(...)`.
  - Hazards: `hazardReport` → `governor.noteHazard()`; ALSO call `noteHazard()` where each provider emits its own injected `hazard.alert` (the hazard-injector path), so relay-injected ADAS scenarios gate watching too.

- [ ] **Step 1: Write the failing tests.** Behavioral contracts (adapt to each harness):

```ts
// tests/mock-watch.test.ts — contracts:
// 1. Session on the mock provider (platform "embedded"); drive "开启环境观察" through
//    the dispatch path; deliver device.result ok for that commandId; then
//    provider.visionFrames({ type: "vision.frames", reason: "watch", index: 0, total: 1, image: "F" })
//    → a final agent transcript "前方有施工路段，注意慢行。" (useBrowserSpeech true).
// 2. WITHOUT the toggle, the same watch frame produces no transcript (disabled drop).
// 3. After a spoken observation, a second frame within 2 min produces no transcript;
//    advance the injected clock past 2 min → speaks again. (Constructor-inject now()
//    the way the vision-frames tests inject fake timers; if the provider builds its
//    governor internally, expose the clock the same way the assembler timeout is
//    already made testable in this harness.)
// 4. A hazard.report delivered via provider.hazardReport just before a watch frame
//    → no transcript (adas-window drop).
```

```ts
// tests/doubao-watch.test.ts — contracts (doubao harness, mocked selectVisionProvider):
// 1. Toggle on via dispatch + device.result ok; watch frame → describe called with
//    (["F"], WATCH_PROMPT); stubbed answer "前方有慢车。" reaches the transcript, and
//    the transcript's delivery ids are FRESH (not the ids of any prior rider turn).
// 2. While the harness holds a rider turn open (the same interposed-turn machinery
//    the vision-frames delivery test uses), a watch frame is dropped (speech gate) —
//    no transcript, and nothing speaks after the turn closes (drop, not queue).
// 3. Disabled by default: frame before any toggle → no describe call.
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** per Interfaces. Watch-line delivery on doubao: allocate a fresh delivery (mirroring mock's `createTranscriptDelivery()` idiom or doubao's equivalent for unprompted lines — the ADAS hazard.alert speech path is the precedent for agent-initiated speech; study it and reuse its delivery handling, naming what you reused in the report).

- [ ] **Step 4: Verify** — `npx vitest run tests/mock-watch.test.ts tests/doubao-watch.test.ts tests/doubao-vision-frames.test.ts tests/mock-vision-frames.test.ts` green; `npm test` once → all green; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/providers/types.ts server/session-controller.ts server/providers/doubao.ts server/providers/mock.ts tests/mock-watch.test.ts tests/doubao-watch.test.ts
git add -A -- server tests
git commit -m "feat(vision): providers govern and speak watch observations"
```

---

### Task 4: Board Python — sampler, change gate, toggle op

**Files:**

- Create: `rdk/vision/watch/__init__.py`, `rdk/vision/watch/tuning.py`, `rdk/vision/watch/gate.py`, `rdk/vision/watch/sampler.py`
- Modify: `rdk/vision/service.py` (handlers dict += `"vision.watch"`; sampler wired into `build_runtime`; ControlHandler disables watching on disconnect)
- Test: `rdk/vision/tests/test_watch_gate.py`, `rdk/vision/tests/test_watch_sampler.py` (create)

**Interfaces:**

- Produces:

```python
# rdk/vision/watch/tuning.py — frozen dataclass + fingerprint, mirroring adas/tuning.py
@dataclass(frozen=True)
class WatchTuning:
    sample_interval_s: float = 30.0
    # Grayscale-histogram correlation below this = "the scene changed". Tuned
    # against the fixture pairs in test_watch_gate.py; real-ride tuning is
    # follow-up work, like the ADAS thresholds were.
    change_threshold: float = 0.90
    frame_width: int = 640

DEFAULT = WatchTuning()
# fingerprint() -> str, same hashlib construction as adas/tuning.py

# rdk/vision/watch/gate.py — pure; lazy cv2/numpy imports (# noqa: PLC0415 - board-only style)
def histogram_correlation(jpeg_a: bytes, jpeg_b: bytes) -> float:
    """Grayscale-histogram correlation in [-1, 1]; 1.0 = identical distributions.
    Raises ValueError on undecodable input (caller treats as 'changed')."""

def scene_changed(previous_jpeg: bytes | None, current_jpeg: bytes, tuning: WatchTuning = DEFAULT) -> bool:
    """None previous (first frame after enable) -> True. Undecodable -> True
    (fail toward shipping; the relay governor is the spend guard)."""

# rdk/vision/watch/sampler.py
class WatchSampler:
    def __init__(self, grab_jpeg: Callable[[], bytes | None], broadcast: Callable[[dict], None],
                 tuning: WatchTuning = DEFAULT, interval_override_s: float | None = None): ...
    def set_enabled(self, on: bool) -> None: ...   # idempotent; starts/stops the thread
    def stop(self) -> None: ...                    # process shutdown
    @property
    def enabled(self) -> bool: ...
```

Sampler behavior (binding): a `threading.Thread` loop on `self._stop.wait(interval)` (ride.py's idiom — no busy loops); each tick calls `grab_jpeg()` (None → skip tick); `scene_changed(last_shipped, jpeg)` → if False, drop locally (last_shipped UNCHANGED); if True, `broadcast({"event": "watch.frame", "image": base64.b64encode(jpeg).decode("ascii")})` and only then `last_shipped = jpeg`. `set_enabled(False)` clears `last_shipped` (re-enabling starts fresh). Disable joins the thread promptly (stop event, not daemon-and-forget).

`service.py` wiring: `build_runtime` constructs `WatchSampler(grab_jpeg=lambda: runtime.cameras.front_jpeg_for_watch(), broadcast=runtime.events.broadcast, ...)` — implement the grab through the SAME `FrameBuffer.jpeg(...)`/downscale path `/frame/front` uses (in-process, no HTTP; reuse `downscale(jpeg, DEFAULT.frame_width)`; study `bench_server.py._frame` and `camera.py`'s `CameraPair._grab` for the exact calls and mirror them in a small helper — name it in your report). Handlers dict: `"vision.watch": lambda args: _handle_watch_toggle(watcher, args)` returning the standard ok response (rpc.py's shapes). ControlHandler's connection-cleanup path calls `watcher.set_enabled(False)` (dies-with-connection; note: the agent is the only control client in production).

- [ ] **Step 1: Write the failing tests**

```python
# rdk/vision/tests/test_watch_gate.py — synthesize frames with numpy + cv2.imencode
# (requirements-dev provides both off-board; no @pytest.mark.hardware):
#   same_scene: a 320x240 gradient image, and the same image with tiny gaussian
#     noise -> histogram_correlation >= 0.95, scene_changed(...) is False.
#   new_scene: the gradient vs a checkerboard -> correlation well below 0.90,
#     scene_changed(...) is True.
#   first_frame: scene_changed(None, jpeg) is True.
#   garbage: histogram_correlation raises ValueError on b"not a jpeg";
#     scene_changed(prev, b"not a jpeg") is True (fail toward shipping).
# Write these as real pytest functions with the synthesis helpers in-file.

# rdk/vision/tests/test_watch_sampler.py — fake grab/broadcast, interval_override_s=0.01:
#   enabling starts sampling: broadcast called with the watch.frame dict whose
#     image base64-decodes to the grabbed jpeg.
#   gate drops don't update the reference: feed A, A-with-noise, checkerboard ->
#     broadcasts are exactly [A, checkerboard].
#   disable stops the thread (no broadcasts after set_enabled(False); thread joined).
#   re-enable starts fresh (first frame after re-enable always ships).
#   grab returning None skips the tick without crashing.
# Use threading.Event/time.sleep bounded waits, no unbounded joins.
```

Write these as real pytest code; the comments are the binding contracts.

- [ ] **Step 2: Run to verify failure** — `python3 -m pytest -c rdk/vision/pytest.ini -m "not hardware" --strict-markers rdk/vision/tests/test_watch_gate.py rdk/vision/tests/test_watch_sampler.py` → import errors.

- [ ] **Step 3: Implement** the package + service wiring (handler + disconnect-disable + the grab helper).

- [ ] **Step 4: Verify** — the two new files green, then the FULL Python gate: `python3 -m pytest -c rdk/vision/pytest.ini -m "not hardware" --strict-markers rdk/vision/tests` → all green.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/watch rdk/vision/service.py rdk/vision/tests/test_watch_gate.py rdk/vision/tests/test_watch_sampler.py
git commit -m "feat(rdk): watch sampler with a histogram change gate behind vision.watch"
```

---

### Task 5: Board TS agent — capability, forwarding, dies-with-session

**Files:**

- Modify: `rdk/agent/src/device/capabilities.ts` (`EMBEDDED_CAPABILITIES["vision.watch"]` — supported; the exhaustiveness vitest fails without it)
- Modify: `rdk/agent/src/main.ts` (vision `onEvent`: new `event.event === "watch.frame"` branch → `relay.sendEvent({ type: "vision.frames", reason: "watch", index: 0, total: 1, image: event.image })`; relay socket close handler → best-effort `void vision.request("vision.watch", { on: false }).catch(() => {})` with a comment: watching dies with the session — a reconnecting rider must re-enable it)
- Test: `tests/rdk-device-dispatch.test.ts` (capability exhaustiveness now passes; add a dispatch case), `tests/rdk-watch-forwarding.test.ts` (create — model on how tests/rdk-hazard.test.ts / rdk-relay tests fake the relay and vision client)

**Interfaces:**

- Consumes: `dispatch.ts`'s existing fall-through to `options.vision.request(command.action, command.args)` — vision.watch needs NO new dispatch branch (verify with the test below); `relay.sendEvent` (fire-and-forget); the vision client's `onEvent` plumbing.
- Produces: the board end-to-end: toggle command → vision RPC; vision `watch.frame` push → unsolicited `vision.frames` to the relay; relay disconnect → watching off.

- [ ] **Step 1: Write the failing tests**

```ts
// extend tests/rdk-device-dispatch.test.ts (its fakeVision harness):
it("forwards vision.watch to the vision control plane", async () => {
  const vision = fakeVision({ status: "ok" });
  const dispatch = createDeviceDispatcher({ ...baseOptions, vision });
  const result = await dispatch({
    type: "device.command",
    commandId: "w1",
    action: "vision.watch",
    args: { on: true },
    tier: "low"
  });
  expect(result).toMatchObject({ type: "device.result", commandId: "w1", status: "ok" });
  expect(vision.requests).toContainEqual({ op: "vision.watch", args: { on: true } });
});
```

```ts
// tests/rdk-watch-forwarding.test.ts — contracts (adapt to the rdk harness idioms):
// 1. A vision event { event: "watch.frame", image: "<base64>" } arriving through
//    main.ts's onEvent path calls relay.sendEvent with
//    { type: "vision.frames", reason: "watch", index: 0, total: 1, image: "<base64>" }.
// 2. An unknown vision event still only logs (the existing else branch) — no sendEvent.
// 3. The relay-close path issues vision.request("vision.watch", { on: false }) and
//    swallows a rejection (vision socket may be down too).
// If main.ts's onEvent isn't directly importable, extract it into a small named
// factory (createVisionEventRouter or similar) the way testable pieces of main.ts
// already are — note the refactor in your report.
```

- [ ] **Step 2: Run to verify failure** — capability test fails first (missing entry), then the new cases.

- [ ] **Step 3: Implement** — capability entry, the onEvent branch, the close hook (extracting a testable unit from main.ts if needed, minimal and named).

- [ ] **Step 4: Verify** — `npx vitest run tests/rdk-device-dispatch.test.ts tests/rdk-watch-forwarding.test.ts tests/rdk-vision-client.test.ts tests/rdk-relay.test.ts` green; `npm test` once; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write rdk/agent/src/device/capabilities.ts rdk/agent/src/main.ts tests/rdk-device-dispatch.test.ts tests/rdk-watch-forwarding.test.ts
git add rdk/agent/src tests
git commit -m "feat(rdk): forward watch frames and kill watching with the session"
```

---

### Task 6: Closeout — gates, README, audit

**Files:**

- Modify: `README.md` (Current Capabilities: a 环境观察 bullet — opt-in voice toggle, board samples 1 frame/30 s behind a scene-change gate, relay governor's caps/cooldowns/ADAS-dedupe/speech-gate with the exact numbers, silent failures, keyless mock behavior, honest limits: no promise the model notices everything, off by default, dies with the session)

- [ ] **Step 1: README** per above, dry mechanism-first voice.
- [ ] **Step 2: Gates** — `npm run check` exit 0 AND `python3 -m pytest -c rdk/vision/pytest.ini -m "not hardware" --strict-markers rdk/vision/tests` green.
- [ ] **Step 3: Commit** — `git add README.md` (+ fallout), `git commit -m "docs(vision): document proactive scene watching"`.
- [ ] **Step 4: Audit** — `git log --oneline main..HEAD`: no ios/ or android/ changes beyond generated protocol files; the settings-sheet deferral noted in the ledger.

---

## Deferred (explicit)

- Settings-sheet watching switch (no client→relay command path exists for toggles; voice-only in v1 — spec deviation to surface at review).
- Change-threshold tuning against real rides (fixture-tested default 0.90; same follow-up posture as the ADAS thresholds).
- On-board hardware verification of sampler CPU cost per tick (joins the human bench-check list).
