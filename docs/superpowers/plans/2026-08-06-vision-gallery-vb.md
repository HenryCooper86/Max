# Vision V-B: iOS Gallery Understanding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "看看我刚拍的照片 / 刚才录的视频里有什么" — Max describes the most recent iOS gallery capture; videos travel as 8 on-device key frames over a new chunked `vision.frames` event, never as uploads.

**Architecture:** The relay grammar emits `gallery.describe { kind, question? }` (iOS-gated). iOS resolves the latest capture of that kind, extracts frames (photo → one 640 px JPEG; video → 8 evenly-spaced `AVAssetImageGenerator` frames), base64s each under the 200 k-char cap, sends them as `vision.frames` chunks through the CrashController-style send closure, then returns the single `device.result ok`. A pure relay-side assembler collects the set (10 s timeout) and both voice providers speak `describe(frames, question)` — or "我看不清。" on an incomplete set — through their existing speech paths.

**Tech Stack:** TypeScript (Node 22, vitest) on the relay; Swift/XCTest on iOS (AVFoundation, UIKit). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-06-vision-expansion-design.md`, section "M2 — iOS gallery understanding". V-C (watching) is a later plan: `reason: "watch"` stays INVALID, no sampler/governor code.

## Global Constraints

- Sequencing (binding): iOS sends ALL `vision.frames` chunks, THEN `device.result ok`. Exactly one `device.result` per command. The relay's ok-reconciliation speaks the filler "我看看…"; the description (or "我看不清。") arrives afterwards through the provider speech path — `camera.look`'s exact sequencing.
- Caps (binding): `total` ≤ 8, `index` < `total` (integers), `image` non-empty ≤ 200,000 base64 chars, `question` ≤ 500 bytes. Assembly timeout 10 s; an incomplete set speaks "我看不清。" (never silence after the filler).
- `reason` enum is `["gallery"]` only until V-C; `commandId` required.
- Failure speech (exact strings, trailing 。): `"gallery.empty"`: "相册里还没有照片或视频。", `"gallery.unreadable"`: "这段内容我处理不了。". Success filler for `gallery.describe` = "我看看…" (same as `camera.look`).
- Platform gate: `PLATFORM_RESTRICTED_ACTIONS["gallery.describe"] = "ios"` — V-B implements iOS only; an Android/web/board client must never receive the command (it would sit out the 8 s timeout).
- Privacy (binding, README must state it): captures never leave the device except the frames of the one capture the rider just asked about by voice — sent for description, never stored server-side, never cached, never in QA transcripts.
- The relay uses `issued.question` (grammar-parsed, carried via `PendingDeviceCommands`) as the authoritative question; the event's `question` field is a redundant carrier (spec shape) — validated, but `issued.question` wins.
- iOS frame extraction is fail-honest: any failure → `nil` → `failed("gallery.unreadable")`; never a partial frame set.
- Mock vision provider already answers multi-frame sets deterministically ("这段视频里，前方道路畅通，一路顺利。") — keyless demos of video description must work end-to-end on the mock voice provider via a driven test (no scenario change needed in this plan).
- iOS build/test (verified working): run from `ios/` with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17'`. New .swift files under `ios/MaxHelmet/` and `ios/MaxHelmetTests/` compile automatically (synchronized root groups — no pbxproj edits). SourceKit "No such module" diagnostics on standalone reads are editor noise; trust xcodebuild.
- After editing `protocol/agent-events.schema.json`: `npm run generate:protocol`, commit ALL generated outputs (`shared/generated/agent-protocol.ts` + the Swift/Kotlin siblings) in the same commit; `npm run check:protocol` exit 0.
- V-A carry-over cleanups folded into Task 4 (they live in files that task touches): literal fullwidth quotes replacing `\u{201C}` escapes in server/vision.ts + tests; `describeFrame` ghost references in doubao.ts's detached-execution comment; stale `tests/setup.ts` mechanism comment.
- 2-space indent, double quotes, semicolons; prettier before every commit; `npx tsc --noEmit` clean per server task; full `npm run check` AND the xcodebuild suite green at the end.

---

### Task 1: `vision.frames` protocol event + schema action sync

**Files:**
- Modify: `protocol/agent-events.schema.json` (ClientEvent.oneOf += VisionFrames; DeviceCommand action enum += "gallery.describe", "camera.look", "system.shutdown")
- Modify: `shared/generated/agent-protocol.ts` + Swift/Kotlin siblings (via `npm run generate:protocol` only)
- Modify: `shared/agent.ts` (`VisionFramesEvent` type + `ClientEvent` union)
- Modify: `server/session-controller.ts` (`parseClientEvent` branch)
- Test: `tests/vision-frames-protocol.test.ts`

**Interfaces:**
- Produces (every later task relies on):

```ts
// shared/agent.ts
export type VisionFramesEvent = {
  type: "vision.frames";
  commandId: string;
  /** Only "gallery" until V-C adds "watch". */
  reason: "gallery";
  index: number;
  total: number;
  image: string;
  question?: string;
};
```

Schema note (include as a comment in the commit message body, not the JSON): the DeviceCommand action enum was missing the already-shipped `camera.look` and `system.shutdown` — this task syncs them alongside the new `gallery.describe` so the schema matches `DeviceActionName` again.

- [ ] **Step 1: Write the failing test**

```ts
// tests/vision-frames-protocol.test.ts
import { describe, expect, it } from "vitest";
import { CLIENT_EVENT_TYPES } from "../shared/generated/agent-protocol";
import { parseClientEvent } from "../server/session-controller";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const base = { type: "vision.frames", commandId: "c1", reason: "gallery", index: 0, total: 2, image: "aGVsbG8=" };

describe("generated protocol", () => {
  it("includes vision.frames and the synced device actions", () => {
    expect(CLIENT_EVENT_TYPES).toContain("vision.frames");
  });
});

describe("parseClientEvent vision.frames", () => {
  it("accepts a frame chunk with and without a question", () => {
    expect(parseClientEvent(encode(base))).toMatchObject({ type: "vision.frames", commandId: "c1", index: 0, total: 2 });
    const withQuestion = parseClientEvent(encode({ ...base, question: "有什么" }));
    expect(withQuestion).toMatchObject({ question: "有什么" });
  });

  it("rejects a watch reason until V-C", () => {
    expect(() => parseClientEvent(encode({ ...base, reason: "watch" }))).toThrow(/reason/);
  });

  it("rejects out-of-range index/total", () => {
    expect(() => parseClientEvent(encode({ ...base, total: 9, index: 8 }))).toThrow(/total/);
    expect(() => parseClientEvent(encode({ ...base, index: 2 }))).toThrow(/index/);
    expect(() => parseClientEvent(encode({ ...base, index: 0.5 }))).toThrow(/index/);
    expect(() => parseClientEvent(encode({ ...base, total: 0, index: 0 }))).toThrow(/total/);
  });

  it("rejects an oversized or empty image and an oversized question", () => {
    expect(() => parseClientEvent(encode({ ...base, image: "" }))).toThrow(/image/);
    expect(() => parseClientEvent(encode({ ...base, image: "x".repeat(200_001) }))).toThrow(/image/);
    expect(() => parseClientEvent(encode({ ...base, question: "问".repeat(200) }))).toThrow(/question/);
  });

  it("returns an allowlisted reconstruction, not the raw blob", () => {
    const event = parseClientEvent(encode({ ...base, extra: "smuggled" })) as Record<string, unknown>;
    expect(event).not.toHaveProperty("extra");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vision-frames-protocol.test.ts`
Expected: FAIL — CLIENT_EVENT_TYPES lacks "vision.frames".

- [ ] **Step 3: Schema + regen + types + validation**

Schema — append to `$defs.ClientEvent.oneOf`:

```json
{
  "title": "VisionFrames",
  "type": "object",
  "properties": {
    "type": { "const": "vision.frames" },
    "commandId": { "type": "string", "minLength": 1 },
    "reason": { "enum": ["gallery"] },
    "index": { "type": "number" },
    "total": { "type": "number" },
    "image": { "type": "string" },
    "question": { "type": "string" }
  },
  "required": ["type", "commandId", "reason", "index", "total", "image"]
}
```

DeviceCommand action enum: add `"camera.look"`, `"gallery.describe"`, `"system.shutdown"` (keep existing order, append). Run `npm run generate:protocol`.

`shared/agent.ts`: add `VisionFramesEvent` (exact shape above) + `| VisionFramesEvent` in the `ClientEvent` union, placed like the crash events.

`parseClientEvent` (next to the `camera.frame` branch; reuse the file's error-message style):

```ts
if (value.type === "vision.frames") {
  if (typeof value.commandId !== "string" || !value.commandId.trim() || value.commandId.length > 120) {
    throw new Error("Invalid vision.frames commandId");
  }
  if (value.reason !== "gallery") throw new Error("Invalid vision.frames reason");
  if (typeof value.total !== "number" || !Number.isInteger(value.total) || value.total < 1 || value.total > 8) {
    throw new Error("Invalid vision.frames total");
  }
  if (typeof value.index !== "number" || !Number.isInteger(value.index) || value.index < 0 || value.index >= value.total) {
    throw new Error("Invalid vision.frames index");
  }
  if (typeof value.image !== "string" || !value.image || value.image.length > 200_000) {
    throw new Error("Invalid vision.frames image");
  }
  if (value.question !== undefined && (typeof value.question !== "string" || Buffer.byteLength(value.question) > 500)) {
    throw new Error("Invalid vision.frames question");
  }
  return {
    type: "vision.frames",
    commandId: value.commandId,
    reason: "gallery",
    index: value.index,
    total: value.total,
    image: value.image,
    question: value.question as string | undefined
  };
}
```

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/vision-frames-protocol.test.ts` → PASS. `npm run check:protocol` → 0. `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write protocol/agent-events.schema.json shared/agent.ts server/session-controller.ts tests/vision-frames-protocol.test.ts
git add protocol/agent-events.schema.json shared/generated shared/agent.ts server/session-controller.ts tests/vision-frames-protocol.test.ts ios/MaxHelmet/Agent/GeneratedAgentProtocol.swift android
git commit -m "feat(vision): add the chunked vision.frames client event"
```

(If `git status` shows the Kotlin sibling under a different path, add that path; commit whatever the generator regenerated.)

---

### Task 2: `gallery.describe` grammar + action plumbing

**Files:**
- Modify: `server/device-actions.ts` (DeviceActionName, DeviceCommand union, DEVICE_ACTION_TIERS, PLATFORM_RESTRICTED_ACTIONS, deviceSuccessSpeech, FAILURE_SPEECH, extraction)
- Test: `tests/device-actions.test.ts` (append)

**Interfaces:**
- Produces:
  - `DeviceCommand` variant: `{ action: "gallery.describe"; args: { kind: "photo" | "video" | "latest"; question?: string } }`
  - `DEVICE_ACTION_TIERS["gallery.describe"] = "low"`; `PLATFORM_RESTRICTED_ACTIONS["gallery.describe"] = "ios"`; `deviceSuccessSpeech` case → `"我看看…"`; `FAILURE_SPEECH` += `"gallery.empty": "相册里还没有照片或视频。"`, `"gallery.unreadable": "这段内容我处理不了。"`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/device-actions.test.ts
describe("gallery.describe", () => {
  it("detects photo, video, and latest references", () => {
    expect(extractDeviceCommand("看看我刚拍的照片")).toMatchObject({
      action: "gallery.describe",
      args: { kind: "photo" }
    });
    expect(extractDeviceCommand("描述一下我拍的相片")).toMatchObject({ action: "gallery.describe", args: { kind: "photo" } });
    expect(extractDeviceCommand("刚才录的视频里有什么")).toMatchObject({
      action: "gallery.describe",
      args: { kind: "video", question: "刚才录的视频里有什么" }
    });
    expect(extractDeviceCommand("看看我刚拍的")).toMatchObject({ action: "gallery.describe", args: { kind: "latest" } });
  });

  it("carries a question only when one is asked", () => {
    const bare = extractDeviceCommand("看看我刚拍的照片");
    expect(bare?.args).not.toHaveProperty("question");
    expect(extractDeviceCommand("我刚拍的照片里那辆车是什么")).toMatchObject({
      action: "gallery.describe",
      args: { kind: "photo", question: "我刚拍的照片里那辆车是什么" }
    });
  });

  it("does not steal neighboring commands", () => {
    expect(extractDeviceCommand("拍照")).toMatchObject({ action: "camera.photo" });
    expect(extractDeviceCommand("看看相册")).toMatchObject({ action: "gallery.open" });
    expect(extractDeviceCommand("打开相册")).toMatchObject({ action: "gallery.open" });
    expect(extractDeviceCommand("你能看到什么")).toMatchObject({ action: "camera.look" });
  });

  it("is gated to ios", () => {
    expect(extractDeviceCommandForPlatform("看看我刚拍的照片", "ios")).toMatchObject({ action: "gallery.describe" });
    expect(extractDeviceCommandForPlatform("看看我刚拍的照片", "android")).toBeNull();
    expect(extractDeviceCommandForPlatform("看看我刚拍的照片", "embedded")).toBeNull();
  });

  it("speaks the filler on success and honest failures", () => {
    expect(deviceSuccessSpeech({ action: "gallery.describe", args: { kind: "photo" } })).toBe("我看看…");
    expect(deviceFailureSpeech("gallery.describe", "failed", "gallery.empty")).toBe("相册里还没有照片或视频。");
    expect(deviceFailureSpeech("gallery.describe", "failed", "gallery.unreadable")).toBe("这段内容我处理不了。");
  });
});
```

(Add `deviceFailureSpeech`/`deviceSuccessSpeech`/`extractDeviceCommandForPlatform` to the test file's imports if missing.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/device-actions.test.ts` — new describe FAILS; existing pass.

- [ ] **Step 3: Implement**

Extraction — add a `matchGalleryDescribe(raw)` called from `extractDeviceCommand` BEFORE `matchCamera` (the 拍-verbs would otherwise collide with camera.photo, and 看看 with the vision branch; state this in a short comment in the file's forensic style):

```ts
const GALLERY_REF = /(我|刚|刚才).{0,4}(拍|录)的/;
const GALLERY_QUESTION = /(是什么|什么样|写的什么|写着什么|有什么|有没有)/;

function matchGalleryDescribe(raw: string): DeviceCommand | null {
  if (!GALLERY_REF.test(raw) && !/\b(photo|picture|video) (i|we) (just )?(took|recorded|shot)\b/i.test(raw)) return null;
  const kind = /(视频|录像|影片|video)/i.test(raw)
    ? ("video" as const)
    : /(照片|相片|photo|picture)/i.test(raw)
      ? ("photo" as const)
      : ("latest" as const);
  const question = GALLERY_QUESTION.test(raw) || /\bwhat('s| is)\b/i.test(raw) ? raw : undefined;
  return { action: "gallery.describe", args: question ? { kind, question } : { kind } };
}
```

Union/tier/gate/speech entries per Interfaces. The union type addition also flows to `shared/agent.ts` consumers automatically (`DeviceActionName` is the source; verify `tsc`).

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/device-actions.test.ts tests/device-grounding.test.ts tests/device-protocol.test.ts` → PASS. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/device-actions.ts tests/device-actions.test.ts
git add server/device-actions.ts tests/device-actions.test.ts
git commit -m "feat(vision): gallery.describe grammar, gate, and speech strings"
```

---

### Task 3: Frame assembler (`server/vision-frames.ts`)

**Files:**
- Create: `server/vision-frames.ts`
- Test: `tests/vision-frames.test.ts`

**Interfaces:**
- Consumes: `VisionFramesEvent` (Task 1).
- Produces (Task 4 consumes):

```ts
export type AssembledFrames = { commandId: string; frames: string[]; question?: string };
export function createFrameAssembler(options: {
  onComplete(assembled: AssembledFrames): void;
  onIncomplete(commandId: string): void; // timeout fired with frames missing
  timeoutMs?: number; // default 10_000
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}): { accept(event: VisionFramesEvent): void };
```

Behavior (binding): first chunk for a commandId opens a set sized `total` and starts the timer; `question` is captured from the first chunk carrying one; a duplicate index is ignored (first write wins); a chunk whose `total` disagrees with the open set is ignored; when all `total` slots are filled → clear timer, call `onComplete` with frames in index order, drop the set; timer fires first → drop the set, call `onIncomplete`. One set per commandId; a chunk for a completed/expired commandId opens a NEW set (harmless — the provider guard upstream only accepts issued commandIds).

- [ ] **Step 1: Write the failing test**

```ts
// tests/vision-frames.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameAssembler } from "../server/vision-frames";
import type { VisionFramesEvent } from "../shared/agent";

const chunk = (commandId: string, index: number, total: number, image: string, question?: string): VisionFramesEvent => ({
  type: "vision.frames",
  commandId,
  reason: "gallery",
  index,
  total,
  image,
  ...(question ? { question } : {})
});

describe("createFrameAssembler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function harness() {
    const completed: Array<{ commandId: string; frames: string[]; question?: string }> = [];
    const incomplete: string[] = [];
    const assembler = createFrameAssembler({
      onComplete: (a) => completed.push(a),
      onIncomplete: (id) => incomplete.push(id)
    });
    return { assembler, completed, incomplete };
  }

  it("assembles frames in index order regardless of arrival order", () => {
    const { assembler, completed } = harness();
    assembler.accept(chunk("c1", 1, 3, "B"));
    assembler.accept(chunk("c1", 0, 3, "A", "有什么"));
    assembler.accept(chunk("c1", 2, 3, "C"));
    expect(completed).toEqual([{ commandId: "c1", frames: ["A", "B", "C"], question: "有什么" }]);
  });

  it("times out an incomplete set and never completes it later", () => {
    const { assembler, completed, incomplete } = harness();
    assembler.accept(chunk("c2", 0, 2, "A"));
    vi.advanceTimersByTime(10_000);
    expect(incomplete).toEqual(["c2"]);
    assembler.accept(chunk("c2", 1, 2, "B")); // opens a NEW 2-slot set, does not complete the old one
    expect(completed).toEqual([]);
  });

  it("ignores duplicate indexes and mismatched totals", () => {
    const { assembler, completed } = harness();
    assembler.accept(chunk("c3", 0, 2, "A"));
    assembler.accept(chunk("c3", 0, 2, "OVERWRITE"));
    assembler.accept(chunk("c3", 1, 3, "WRONG_TOTAL"));
    assembler.accept(chunk("c3", 1, 2, "B"));
    expect(completed).toEqual([{ commandId: "c3", frames: ["A", "B"] }]);
  });

  it("completes a single-frame set immediately without waiting", () => {
    const { assembler, completed } = harness();
    assembler.accept(chunk("c4", 0, 1, "ONLY"));
    expect(completed).toEqual([{ commandId: "c4", frames: ["ONLY"] }]);
  });

  it("tracks independent commands independently", () => {
    const { assembler, completed, incomplete } = harness();
    assembler.accept(chunk("a", 0, 1, "A"));
    assembler.accept(chunk("b", 0, 2, "B0"));
    vi.advanceTimersByTime(10_000);
    expect(completed.map((c) => c.commandId)).toEqual(["a"]);
    expect(incomplete).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/vision-frames.test.ts` → module missing.

- [ ] **Step 3: Implement** per the behavior table. Header comment in the vision.ts voice: why assembly is command-scoped, why first-write-wins, why an expired set never resurrects (the rider already heard "我看不清" — a late completion would answer twice).

- [ ] **Step 4: Verify** — `npx vitest run tests/vision-frames.test.ts` PASS; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/vision-frames.ts tests/vision-frames.test.ts
git add server/vision-frames.ts tests/vision-frames.test.ts
git commit -m "feat(vision): pure chunked-frame assembler with timeout"
```

---

### Task 4: Provider wiring (doubao + mock speak assembled sets)

**Files:**
- Modify: `server/providers/types.ts` (`visionFrames?(event: VisionFramesEvent): Promise<void>;` on AgentProvider, below cameraFrame)
- Modify: `server/session-controller.ts` (`if (event.type === "vision.frames") await this.provider.visionFrames?.(event);` beside the camera.frame forward at ~line 535)
- Modify: `server/providers/doubao.ts` (assembler + visionFrames + carry-over comment cleanups)
- Modify: `server/providers/mock.ts` (assembler + visionFrames)
- Modify: `server/vision.ts` + `tests/vision.test.ts` + `tests/mock-camera-frame.test.ts` (V-A carry-over: replace `\u{201C}`/`\u{201D}` escapes with literal “ ” — behavior-identical, tests prove it)
- Modify: `tests/setup.ts` (stale "describeFrame() describer" comment → current mechanism)
- Test: `tests/doubao-vision-frames.test.ts` (create, mirroring tests/doubao-camera-frame.test.ts's harness), `tests/mock-vision-frames.test.ts` (create, mirroring tests/mock-camera-frame.test.ts's harness)

**Interfaces:**
- Consumes: `createFrameAssembler` (Task 3), `visionProvider.describe` (V-A), `pendingDeviceCommands.peek` (V-A), `issued.question`.
- Produces: both providers implement `visionFrames`:

```ts
async visionFrames(event) {
  const issued = pendingDeviceCommands.peek(event.commandId) ?? recentGalleryCommands.get(event.commandId);
  if (!issued || issued.action !== "gallery.describe") return;
  frameAssembler.accept(event);
}
```

IMPORTANT wire-order subtlety the implementation MUST handle: iOS sends chunks then `device.result ok`, and `deviceResult()` RESOLVES (deletes) the pending entry. Chunks all arrive before the result in wire order, so `peek` succeeds during acceptance — but the assembler's `onComplete` fires synchronously on the LAST chunk, still before the result: capture `issued.question` at accept-or-complete time, not later. However the 10 s `onIncomplete` timer CAN fire after the entry is resolved — the timeout path must not need the registry: it speaks "我看不清。" unconditionally for a set it opened. To keep the guard airtight without a leak, keep a small `recentGalleryCommands: Map<commandId, {action, question}>` recorded at accept time and pruned on completion/timeout (bounded by the assembler's own lifecycle — at most one live entry per in-flight command).

On complete: detached fire-and-forget describe + speak, exactly the cameraFrame pattern per provider — doubao captures `agentDelivery` synchronously and speaks via `transcriptEvent` + `speaker.speak` (null → "我看不清。"); mock emits its final agent transcript with `useBrowserSpeech: true`. On incomplete: speak "我看不清。" through the same per-provider path.

- [ ] **Step 1: Read both existing camera-frame test files** — their harness idioms govern the two new test files.

- [ ] **Step 2: Write the failing tests.** Behavioral contracts (adapt harness plumbing, keep assertions):

```ts
// tests/mock-vision-frames.test.ts — contracts:
// 1. Drive the mock provider (platform "ios") with "看看我刚拍的视频" so it issues
//    gallery.describe; feed visionFrames() three chunks (out of order) for that
//    commandId; assert a final agent transcript with useBrowserSpeech: true and
//    text "这段视频里，前方道路畅通，一路顺利。" (multi-frame mock answer).
// 2. A single-chunk set for a photo command speaks "前方道路畅通，天气晴朗。".
// 3. Chunks for a commandId never issued produce no transcript.
// 4. An incomplete set (1 of 2 chunks) speaks "我看不清。" after vi.advanceTimersByTime(10_000)
//    — use fake timers around the provider's assembler.
```

```ts
// tests/doubao-vision-frames.test.ts — contracts (doubao harness, mocked selectVisionProvider):
// 1. Issue gallery.describe with question "里面有什么" via the dispatch path; feed
//    two chunks; assert describe was called with (["F0","F1"], "里面有什么") and the
//    stubbed answer reaches the transcript/speech assertions the camera-frame tests use.
// 2. Incomplete set → transcript "我看不清。" after the timeout.
```

- [ ] **Step 3: Run to verify failure** — both new files fail (`visionFrames` undefined).

- [ ] **Step 4: Implement** providers + forwarding + types, plus the carry-over cleanups (quote literals in vision.ts/tests — run the vision + mock-camera tests to prove byte-identical behavior; comment fixes in doubao.ts and tests/setup.ts).

- [ ] **Step 5: Verify** — `npx vitest run tests/mock-vision-frames.test.ts tests/doubao-vision-frames.test.ts tests/vision.test.ts tests/mock-camera-frame.test.ts tests/doubao-camera-frame.test.ts` PASS; `npm test` once → all green; `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
npx prettier --write server/providers/types.ts server/session-controller.ts server/providers/doubao.ts server/providers/mock.ts server/vision.ts tests/setup.ts tests/vision.test.ts tests/mock-camera-frame.test.ts tests/doubao-vision-frames.test.ts tests/mock-vision-frames.test.ts
git add -A -- server tests
git commit -m "feat(vision): providers assemble and speak gallery frame sets"
```

---

### Task 5: iOS wire types — action case, parsing, event builder

**Files:**
- Modify: `ios/MaxHelmet/Agent/AgentProtocol.swift` (DeviceAction case, parseDeviceAction branch, `buildVisionFrame`)
- Modify: `ios/MaxHelmet/Actions/DeviceActionHandler.swift` (`DeviceActionRoute` case `galleryDescribe` + init mapping; new `IdentifiedDeviceActionHandler` protocol)
- Modify: `ios/MaxHelmet/Actions/DeviceActionRouter.swift` (route to the identified variant when the handler implements it)
- Test: `ios/MaxHelmetTests/GalleryDescribeProtocolTests.swift` (create)

**Interfaces:**
- Consumes: `ClientEventTypes.visionFrames` (generated in Task 1); existing `DeviceAction`/`DeviceActionResult`/`parseDeviceAction`/`buildDeviceResult` shapes in AgentProtocol.swift.
- Produces (Task 7 relies on):
  - `case galleryDescribe(kind: String, question: String?)` on `DeviceAction`.
  - `parseDeviceAction("gallery.describe", args)` → `.galleryDescribe(kind: args["kind"] as? String ?? "latest", question: args["question"] as? String)`.
  - `DeviceActionRoute.galleryDescribe`.
  - `protocol IdentifiedDeviceActionHandler: DeviceActionHandler { func perform(_ action: DeviceAction, commandId: String) async -> DeviceActionResult }` — the router calls this variant when conformed to (`if let identified = handler as? IdentifiedDeviceActionHandler { return await identified.perform(command.action, commandId: command.commandId) }`), else the existing `perform(_:)`. Rationale comment: chunked events must carry the commandId, which `perform(_:)` never receives; this seam adds it without touching the seven existing handlers.
  - `func buildVisionFrame(commandId: String, index: Int, total: Int, image: String, question: String?) -> String` — JSON with `type: ClientEventTypes.visionFrames`, `reason: "gallery"`, and the five fields; question omitted when nil; built with JSONSerialization exactly like `buildCrashAlert`.

- [ ] **Step 1: Write the failing tests**

```swift
// ios/MaxHelmetTests/GalleryDescribeProtocolTests.swift
import XCTest
@testable import MaxHelmet

final class GalleryDescribeProtocolTests: XCTestCase {
    func testParsesGalleryDescribe() {
        XCTAssertEqual(parseDeviceAction("gallery.describe", ["kind": "photo"]), .galleryDescribe(kind: "photo", question: nil))
        XCTAssertEqual(
            parseDeviceAction("gallery.describe", ["kind": "video", "question": "有什么"]),
            .galleryDescribe(kind: "video", question: "有什么")
        )
        XCTAssertEqual(parseDeviceAction("gallery.describe", [:]), .galleryDescribe(kind: "latest", question: nil))
    }

    func testRouteMapping() {
        XCTAssertEqual(DeviceActionRoute(.galleryDescribe(kind: "photo", question: nil)), .galleryDescribe)
    }

    func testBuildVisionFrameShape() throws {
        let json = buildVisionFrame(commandId: "c9", index: 1, total: 8, image: "QUJD", question: "有什么")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "vision.frames")
        XCTAssertEqual(object["commandId"] as? String, "c9")
        XCTAssertEqual(object["reason"] as? String, "gallery")
        XCTAssertEqual(object["index"] as? Int, 1)
        XCTAssertEqual(object["total"] as? Int, 8)
        XCTAssertEqual(object["image"] as? String, "QUJD")
        XCTAssertEqual(object["question"] as? String, "有什么")
        let bare = buildVisionFrame(commandId: "c9", index: 0, total: 1, image: "QUJD", question: nil)
        let bareObject = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(bare.utf8)) as? [String: Any])
        XCTAssertNil(bareObject["question"])
    }

    func testIdentifiedHandlerReceivesCommandId() async {
        final class Probe: IdentifiedDeviceActionHandler {
            var seen: (DeviceAction, String)?
            func perform(_ action: DeviceAction) async -> DeviceActionResult { .unsupported("wrong.path") }
            func perform(_ action: DeviceAction, commandId: String) async -> DeviceActionResult {
                seen = (action, commandId)
                return .ok
            }
        }
        let probe = Probe()
        let router = DeviceActionRouter(handlers: [.galleryDescribe: probe], isDeviceUnlocked: { true })
        let result = await router.handle(DeviceCommand(commandId: "c1", action: .galleryDescribe(kind: "latest", question: nil), tier: .low))
        XCTAssertEqual(result, .ok)
        XCTAssertEqual(probe.seen?.1, "c1")
    }
}
```

(Adjust the `DeviceCommand`/tier initializer spelling to the real one in AgentProtocol.swift.)

- [ ] **Step 2: Run to verify failure**

Run from `ios/`: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:MaxHelmetTests/GalleryDescribeProtocolTests 2>&1 | tail -20`
Expected: compile failure (case/protocol missing).

- [ ] **Step 3: Implement** per Interfaces. `buildVisionFrame` sits beside `buildCrashAlert` with the same JSONSerialization pattern.

- [ ] **Step 4: Verify** — same xcodebuild command → tests pass.

- [ ] **Step 5: Commit**

```bash
git add ios/MaxHelmet/Agent/AgentProtocol.swift ios/MaxHelmet/Actions ios/MaxHelmetTests/GalleryDescribeProtocolTests.swift
git commit -m "feat(vision-ios): gallery.describe action, route, and vision.frames builder"
```

---

### Task 6: iOS frame extraction (`FrameExtraction` + shared downscale)

**Files:**
- Create: `ios/MaxHelmet/Capture/ImageDownscale.swift` (internal `extension UIImage { func downscaled(to maxDimension: CGFloat) -> UIImage? }` — MOVED verbatim from CaptureStore.swift's private extension)
- Modify: `ios/MaxHelmet/Capture/CaptureStore.swift` (delete the now-duplicated private extension; thumbnails keep working through the internal one)
- Create: `ios/MaxHelmet/Capture/FrameExtraction.swift`
- Test: `ios/MaxHelmetTests/FrameExtractionTests.swift` (create)

**Interfaces:**
- Produces (Task 7 consumes):

```swift
enum FrameExtraction {
    static let maxDimension: CGFloat = 640
    static let maxBase64Chars = 200_000
    static let videoFrameCount = 8

    /// Downscaled JPEG base64 of a photo, stepping quality down (0.7 → 0.5 → 0.3)
    /// until under maxBase64Chars. nil on any failure — fail-honest, never partial.
    static func photoBase64(from data: Data) -> String?

    /// `count` evenly-spaced frames (at (i + 0.5)/count of the duration, so no
    /// duplicate first/last frames), each a downscaled JPEG base64 under the cap.
    /// nil if the asset is unreadable, has no finite positive duration, or ANY
    /// frame fails — fail-honest, never partial.
    static func videoFramesBase64(from url: URL, count: Int = videoFrameCount) -> [String]?
}
```

Implementation notes: `AVURLAsset(url:)`, `CMTimeGetSeconds(asset.duration)`, `AVAssetImageGenerator` with `appliesPreferredTrackTransform = true` and zero tolerance (`requestedTimeToleranceBefore/After = .zero`) so the 8 frames are genuinely distinct; `copyCGImage(at:actualTime:)` in a loop; each CGImage → UIImage → `downscaled(to: 640)` → JPEG (same quality step-down as photoBase64) → `base64EncodedString()`.

- [ ] **Step 1: Write the failing tests**

```swift
// ios/MaxHelmetTests/FrameExtractionTests.swift
import AVFoundation
import UIKit
import XCTest
@testable import MaxHelmet

final class FrameExtractionTests: XCTestCase {
    private func syntheticJpeg(side: CGFloat) -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side))
        let image = renderer.image { context in
            UIColor.systemRed.setFill()
            context.fill(CGRect(x: 0, y: 0, width: side, height: side))
        }
        return image.jpegData(compressionQuality: 0.9)!
    }

    /// Writes a ~2 s solid-color .mov via AVAssetWriter; returns its URL.
    private func syntheticMov() throws -> URL { /* AVAssetWriter, 320x240, 10 fps, 20 pixel-buffer frames */ }

    func testPhotoBase64UnderCap() {
        let base64 = FrameExtraction.photoBase64(from: syntheticJpeg(side: 3000))
        XCTAssertNotNil(base64)
        XCTAssertLessThanOrEqual(base64!.count, FrameExtraction.maxBase64Chars)
        XCTAssertNotNil(Data(base64Encoded: base64!))
    }

    func testPhotoBase64FailsHonestlyOnGarbage() {
        XCTAssertNil(FrameExtraction.photoBase64(from: Data([0x00, 0x01])))
    }

    func testVideoFramesCountAndCap() throws {
        let url = try syntheticMov()
        defer { try? FileManager.default.removeItem(at: url) }
        let frames = FrameExtraction.videoFramesBase64(from: url)
        XCTAssertEqual(frames?.count, FrameExtraction.videoFrameCount)
        for frame in frames ?? [] {
            XCTAssertLessThanOrEqual(frame.count, FrameExtraction.maxBase64Chars)
            XCTAssertNotNil(Data(base64Encoded: frame))
        }
    }

    func testVideoFramesFailHonestlyOnMissingFile() {
        XCTAssertNil(FrameExtraction.videoFramesBase64(from: URL(fileURLWithPath: "/nonexistent.mov")))
    }
}
```

Write `syntheticMov()` in full: `AVAssetWriter` with `AVAssetWriterInput` (h264, 320×240) + `AVAssetWriterInputPixelBufferAdaptor`, appending 20 solid-color `CVPixelBuffer`s at 10 fps, `finishWriting` awaited via expectation. CaptureStoreTests's synthetic-JPEG helper is the precedent for in-test asset synthesis; there are no bundled fixtures.

- [ ] **Step 2: Run to verify failure** — the `-only-testing:MaxHelmetTests/FrameExtractionTests` xcodebuild run fails to compile (types missing).

- [ ] **Step 3: Implement** `ImageDownscale.swift` (move, not copy — delete the private original), `FrameExtraction.swift`.

- [ ] **Step 4: Verify** — run `FrameExtractionTests` AND `CaptureStoreTests` (thumbnail path must still pass after the extension move); then the full iOS suite once.

- [ ] **Step 5: Commit**

```bash
git add ios/MaxHelmet/Capture ios/MaxHelmetTests/FrameExtractionTests.swift
git commit -m "feat(vision-ios): key-frame and photo extraction under the frame cap"
```

---

### Task 7: iOS `GalleryDescribeController` + AgentSession wiring

**Files:**
- Create: `ios/MaxHelmet/Actions/GalleryDescribeController.swift`
- Modify: `ios/MaxHelmet/Agent/AgentSession.swift` (register in the `deviceRouter` handlers dict, ~line 237-246, with the CrashController-style send closure from ~line 207)
- Test: `ios/MaxHelmetTests/GalleryDescribeControllerTests.swift` (create)

**Interfaces:**
- Consumes: `IdentifiedDeviceActionHandler` + `buildVisionFrame` (Task 5), `FrameExtraction` (Task 6), `CaptureStoring` (`captures()` is newest-first; `fileURL(for:)`), `Capture.Kind`.
- Produces:

```swift
final class GalleryDescribeController: IdentifiedDeviceActionHandler {
    init(
        store: CaptureStoring,
        send: @escaping (String) -> Void,
        extractPhoto: @escaping (Data) -> String? = FrameExtraction.photoBase64,
        extractVideo: @escaping (URL) -> [String]? = { FrameExtraction.videoFramesBase64(from: $0) }
    )
    func perform(_ action: DeviceAction) async -> DeviceActionResult // .unsupported("handler.missing") — identified path only
    func perform(_ action: DeviceAction, commandId: String) async -> DeviceActionResult
}
```

Behavior (binding): resolve target — kind "photo" → `captures().first { $0.type == .photo }`; "video" → first video; anything else → `captures().first`. No target → `.failed("gallery.empty")`. Photo: read `store.fileURL(for:)` data → `extractPhoto`; video → `extractVideo`. nil/empty frames → `.failed("gallery.unreadable")`. Otherwise send every chunk via `send(buildVisionFrame(commandId:index:total:image:question:))` in index order, THEN return `.ok` — the router's caller sends the one `device.result` after, preserving chunks-before-result wire order.

AgentSession wiring: `.galleryDescribe: GalleryDescribeController(store: captureStore, send: { [weak self] json in self?.webSocket?.send(.string(json)) { _ in } })`.

- [ ] **Step 1: Write the failing tests**

```swift
// ios/MaxHelmetTests/GalleryDescribeControllerTests.swift
import XCTest
@testable import MaxHelmet

final class GalleryDescribeControllerTests: XCTestCase {
    // In-memory CaptureStoring fake modeled on CameraControllerTests' FakeStore:
    // configurable captures() list (already newest-first), fileURL(for:) returning
    // temp paths, other methods no-op.

    func testEmptyGallery() async {
        // controller over an empty store → perform(.galleryDescribe(kind:"photo"...), commandId:"c1")
        // == .failed("gallery.empty"); zero sends.
    }

    func testPhotoSendsSingleChunkThenOk() async throws {
        // store with [video(newer), photo(older)]; kind "photo" resolves the PHOTO
        // (not the newer video); extractPhoto stub returns "UEhPVE8=";
        // sends == exactly one JSON with index 0, total 1, commandId "c2",
        // question forwarded when the action carries one; result .ok.
        // Assert the send happened BEFORE perform returned (record order).
    }

    func testVideoSendsEightChunksInOrder() async throws {
        // kind "video"; extractVideo stub returns 8 strings F0...F7;
        // 8 sends, indexes 0-7 in order, every total == 8; result .ok.
    }

    func testLatestPicksNewestOfAnyKind() async {
        // store newest == video; kind "latest" → extractVideo used, not extractPhoto.
    }

    func testExtractionFailure() async {
        // extractVideo stub returns nil → .failed("gallery.unreadable"); zero sends.
    }
}
```

Write these as real code against the fakes; the comments are the binding contract.

- [ ] **Step 2: Run to verify failure** — `-only-testing:MaxHelmetTests/GalleryDescribeControllerTests` compile failure.

- [ ] **Step 3: Implement** controller + AgentSession registration.

- [ ] **Step 4: Verify** — controller tests, then the FULL iOS suite: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -project MaxHelmet.xcodeproj -scheme MaxHelmet -destination 'platform=iOS Simulator,name=iPhone 17' 2>&1 | tail -15` → all green.

- [ ] **Step 5: Commit**

```bash
git add ios/MaxHelmet/Actions/GalleryDescribeController.swift ios/MaxHelmet/Agent/AgentSession.swift ios/MaxHelmetTests/GalleryDescribeControllerTests.swift
git commit -m "feat(vision-ios): gallery.describe handler streams frames then the result"
```

---

### Task 8: Closeout — gates, README, branch audit

**Files:**
- Modify: `README.md` (extend the camera/gallery capability bullet: Max can describe the latest gallery photo or video — video via 8 on-device key frames, never uploaded; the privacy exception sentence VERBATIM from Global Constraints; keyless mock behavior; honest failure lines)

- [ ] **Step 1: README** per above, dry mechanism-first voice, no overclaiming (the live Ark path is still unverified — do not claim description quality).
- [ ] **Step 2: Gates** — `npm run check` exit 0 AND the full iOS xcodebuild suite green; fix fallout inline.
- [ ] **Step 3: Commit** — `git add README.md` (+ fallout), `git commit -m "docs(vision): document gallery understanding and its privacy exception"`.
- [ ] **Step 4: Audit** — `git log --oneline main..HEAD`: no android/ or rdk/ source; no `reason: "watch"` acceptance, no sampler/governor code anywhere.

---

## Deferred to V-C (do not implement here)

`vision.watch` toggle + board sampler + histogram change gate + `server/vision-governor.ts` + metrics + the watching prompt; `reason: "watch"` validation.
