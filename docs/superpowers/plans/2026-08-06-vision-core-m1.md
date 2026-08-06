# Vision Core + M1 (Live Q&A) Implementation Plan — Plan V-A

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `server/vision.ts` into a provider-neutral vision service (Ark + mock, multi-image, question-aware) and make live look answer the rider's actual question on both voice providers.

**Architecture:** `VisionProvider.describe(frames, question?)` replaces the single-purpose `createDescriber`; `selectVisionProvider` picks Ark or mock by `ARK_API_KEY`+`ARK_MODEL` presence (warn-once). The grammar learns specific vision questions and carries the raw utterance in `camera.look` args; the question rides the `PendingDeviceCommands` entry to the `cameraFrame` handler. The mock voice provider gains the same `cameraFrame` handling backed by the mock vision provider, so 看看 demos work with no credentials at all.

**Tech Stack:** TypeScript (Node 22, ES modules), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-06-vision-expansion-design.md` (V-A scope: "The vision core" + "M1" sections). V-B (gallery) and V-C (watching) are separate later plans — build nothing for them (no `vision.frames`, no `gallery.describe`, no governor).

## Global Constraints

- Fail-null everywhere: `describe` returns null on every failure (missing key/model, HTTP error, timeout, empty content), reporting through `onFailure` exactly once per call; callers speak "我看不清。" on null. Never throw to a caller.
- Ark request content order is **images first, then text**: `[{image_url}, …, {type:"text", text}]`; the text part is `question?.trim() || DEFAULT_PROMPT` (the existing fixed prompt).
- The 10 s model timeout (`DEFAULT_TIMEOUT_MS = 10_000` in vision.ts) is unchanged — describe calls happen after the device round trip closes, outside the relay's 8 s device-result window.
- Preserve vision.ts's "UNVERIFIED response shape" comment block verbatim (no successful Ark call has ever been made; the parser is a documented guess).
- Mock vision answers are deterministic, exactly: one frame + no question → `"前方道路畅通，天气晴朗。"`; multiple frames + no question → `"这段视频里，前方道路畅通，一路顺利。"`; any frames + question → `` `关于“${question}”：我看到前方道路畅通。` ``.
- `selectVisionProvider` warns once per process when unconfigured (module-level latch — same documented pattern as `selectRouteProvider` in server/routing.ts; sessions re-select per connection, so a per-selection warn would spam).
- The mock **voice** provider always uses `createMockVisionProvider()` directly (never the real key): the mock provider is the no-credential demo surface and must never spend Ark quota — spec M1 says so explicitly.
- `camera.look`'s platform gate (embedded-only, `PLATFORM_RESTRICTED_ACTIONS`) is unchanged.
- Speech ownership unchanged: vision events forward to voice providers (`provider.cameraFrame`); providers speak.
- Generic look phrases (你能看到什么 / 看看前面 / what do you see) send **no question** (fixed prompt); only specific question phrases carry `question: <raw utterance>`.
- 2-space indent, double quotes, semicolons; `npx prettier --write` before each commit; `npx tsc --noEmit` clean per task; full `npm run check` green at the end of the final task (knip fails on dead exports — every export added must have a consumer by then).

---

### Task 1: Vision core (`server/vision.ts` service shape)

**Files:**

- Modify: `server/vision.ts` (keep `VISION_ENDPOINT`, `buildChatCompletionsEndpoint`, the header comment, `DEFAULT_PROMPT`, the UNVERIFIED comment; keep `createDescriber` TEMPORARILY — Task 3 deletes it after migrating its one consumer)
- Modify: `tests/vision.test.ts` (extend; migrate nothing yet — existing `createDescriber` tests keep passing untouched in this task)

**Interfaces:**

- Consumes: existing `DescriberOptions` internals (fetch shape, abort/timeout pattern at vision.ts:66-114).
- Produces (Tasks 3 and 4 rely on these exact names):

```ts
export type VisionProvider = {
  mode: "ark" | "mock";
  describe(frames: string[], question?: string): Promise<string | null>;
};

export function createArkVisionProvider(options: {
  apiKey?: string;
  model?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number; // default 10_000, unchanged
  onFailure?: (reason: string) => void;
}): VisionProvider;

export function createMockVisionProvider(): VisionProvider;

export function selectVisionProvider(
  options: {
    apiKey?: string;
    model?: string;
    endpoint?: string;
    onFailure?: (reason: string) => void;
  },
  log?: { warn(message: string, meta?: Record<string, unknown>): void }
): VisionProvider;
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/vision.test.ts` (do not modify existing tests in this task):

```ts
import { createArkVisionProvider, createMockVisionProvider, selectVisionProvider } from "../server/vision";

const FRAME = "aGVsbG8="; // any base64 string; the provider never decodes it
const ARK_OK = JSON.stringify({ choices: [{ message: { content: "前方有一个蓝色路牌。" } }] });

function fetchCapturing(body: string, captured: { url?: string; body?: unknown }): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    captured.url = String(url);
    captured.body = JSON.parse(String(init?.body));
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

describe("createArkVisionProvider", () => {
  it("sends images first, then the question as the text part", async () => {
    const captured: { url?: string; body?: unknown } = {};
    const provider = createArkVisionProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: fetchCapturing(ARK_OK, captured)
    });
    const answer = await provider.describe([FRAME, FRAME], "路牌写的什么");
    expect(answer).toBe("前方有一个蓝色路牌。");
    const content = (captured.body as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages[0]
      .content;
    expect(content).toHaveLength(3);
    expect(content[0].type).toBe("image_url");
    expect(content[1].type).toBe("image_url");
    expect(content[2]).toEqual({ type: "text", text: "路牌写的什么" });
  });

  it("falls back to the fixed describe prompt when no question is asked", async () => {
    const captured: { url?: string; body?: unknown } = {};
    const provider = createArkVisionProvider({ apiKey: "k", model: "m", fetchImpl: fetchCapturing(ARK_OK, captured) });
    await provider.describe([FRAME]);
    const content = (captured.body as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages[0]
      .content;
    expect(content).toHaveLength(2);
    expect((content[1] as { text: string }).text).toContain("描述");
  });

  it("returns null with one onFailure on missing credentials, HTTP error, and empty content", async () => {
    for (const setup of [
      { options: { apiKey: undefined, model: "m" } },
      { options: { apiKey: "k", model: undefined } },
      {
        options: {
          apiKey: "k",
          model: "m",
          fetchImpl: (async () => new Response("no", { status: 500 })) as typeof fetch
        }
      },
      {
        options: {
          apiKey: "k",
          model: "m",
          fetchImpl: (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch
        }
      }
    ]) {
      const reasons: string[] = [];
      const provider = createArkVisionProvider({ ...setup.options, onFailure: (r) => reasons.push(r) });
      expect(await provider.describe([FRAME], "q")).toBeNull();
      expect(reasons.length).toBe(1);
    }
  });
});

describe("createMockVisionProvider", () => {
  it("answers deterministically for photo, clip, and question", async () => {
    const provider = createMockVisionProvider();
    expect(provider.mode).toBe("mock");
    expect(await provider.describe([FRAME])).toBe("前方道路畅通，天气晴朗。");
    expect(await provider.describe([FRAME, FRAME, FRAME])).toBe("这段视频里，前方道路畅通，一路顺利。");
    expect(await provider.describe([FRAME], "前面是什么")).toBe("关于“前面是什么”：我看到前方道路畅通。");
  });
});

describe("selectVisionProvider", () => {
  it("selects ark with credentials, mock without, warning once per process", () => {
    const warnings: string[] = [];
    const log = { warn: (m: string) => warnings.push(m) };
    expect(selectVisionProvider({ apiKey: "k", model: "m" }, log).mode).toBe("ark");
    expect(warnings.length).toBe(0);
    expect(selectVisionProvider({ apiKey: "k" }, log).mode).toBe("mock"); // model missing counts as unconfigured
    expect(warnings.length).toBe(1);
    selectVisionProvider({}, log); // second unconfigured selection: latch already fired
    expect(warnings.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/vision.test.ts`
Expected: existing tests PASS; new tests FAIL (`createArkVisionProvider` is not exported).

- [ ] **Step 3: Implement the service shape**

In `server/vision.ts`, below the existing code (leave `createDescriber` in place):

- `createArkVisionProvider` reuses the exact fetch/abort/timeout/parse pattern of `createDescriber` (vision.ts:66-114), with the body's `content` built as: every frame mapped to `{ type: "image_url", image_url: { url: \`data:image/jpeg;base64,${frame}\` } }`in order, then`{ type: "text", text: question?.trim() || prompt }`where`prompt`defaults to`DEFAULT_PROMPT`. Missing `apiKey`/`model`→ one`onFailure("not configured")`per call, null (defensive:`selectVisionProvider`never constructs it unconfigured, but the contract stays airtight). Keep (move, don't duplicate) the UNVERIFIED response-shape comment so it sits on the one parser both functions share — extract a small private`parseArkContent(body): string | null`used by both`createDescriber` and the new provider so the comment lives once.
- `createMockVisionProvider` returns the three exact strings from Global Constraints, keyed only on `frames.length > 1` and `question` presence.
- `selectVisionProvider`: ark when `apiKey` and `model` are both non-empty; otherwise mock plus one process-lifetime `log?.warn("ARK_API_KEY/ARK_MODEL is not set; vision uses the mock provider")` behind a module-level latch with a comment referencing the deliberate once-per-process divergence documented in `server/routing.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/vision.test.ts` — Expected: PASS (old and new).
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/vision.ts tests/vision.test.ts
git add server/vision.ts tests/vision.test.ts
git commit -m "feat(vision): provider-neutral vision core with ark and mock providers"
```

---

### Task 2: Vision-question grammar + question plumbing types

**Files:**

- Modify: `server/device-actions.ts` (camera.look args type at line ~43; extraction block at lines ~248-249; `IssuedDeviceCommand` type and `PendingDeviceCommands.issue` at lines ~455-465)
- Test: `tests/device-actions.test.ts` (append)

**Interfaces:**

- Consumes: existing `extractDeviceCommand` and `PendingDeviceCommands` (device-actions.ts).
- Produces (Task 3 relies on these):
  - `DeviceCommand` variant becomes `{ action: "camera.look"; args: { question?: string } }`.
  - `IssuedDeviceCommand` gains `question?: string`.
  - `issue(action: DeviceActionName, okSpeech?: string, now: number = Date.now(), question?: string)` — fourth positional parameter; existing call sites compile unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `tests/device-actions.test.ts` (match the file's existing describe/it style):

```ts
describe("camera.look vision questions", () => {
  it("keeps generic look phrases question-free (fixed prompt)", () => {
    for (const phrase of ["你能看到什么", "看看前面", "what do you see"]) {
      const command = extractDeviceCommand(phrase);
      expect(command).toMatchObject({ action: "camera.look", args: {} });
      expect(command?.args).not.toHaveProperty("question");
    }
  });

  it("carries the raw utterance for specific questions", () => {
    for (const phrase of ["前面那个路牌写的什么", "前方的标志是什么", "前面那辆车是什么样", "what is that ahead"]) {
      const command = extractDeviceCommand(phrase);
      expect(command).toMatchObject({ action: "camera.look", args: { question: phrase } });
    }
  });

  it("does not swallow gallery phrases", () => {
    expect(extractDeviceCommand("看看相册")).toMatchObject({ action: "gallery.open" });
    expect(extractDeviceCommand("打开相册")).toMatchObject({ action: "gallery.open" });
  });

  it("threads the question through PendingDeviceCommands.issue", () => {
    const pending = new PendingDeviceCommands();
    const issued = pending.issue("camera.look", "我看看…", Date.now(), "路牌写的什么");
    expect(pending.peek(issued.commandId)?.question).toBe("路牌写的什么");
    const plain = pending.issue("torch.set", "好的");
    expect(pending.peek(plain.commandId)?.question).toBeUndefined();
  });
});
```

(Import `PendingDeviceCommands` alongside the file's existing imports from `../server/device-actions` if not already imported.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/device-actions.test.ts`
Expected: new tests FAIL (question arg not produced / not stored); existing tests PASS.

- [ ] **Step 3: Implement**

In `server/device-actions.ts`:

1. Type: `| { action: "camera.look"; args: { question?: string } }` (line ~43).
2. Extraction — replace the block at lines ~248-249 with (order matters: this sits BEFORE the gallery block at ~254, and the specific-question test must run before the generic one so a phrase matching both carries its question):

```ts
const visionQuestionPattern =
  /(前面|前方).{0,8}(是什么|什么样|写的什么|写着什么)|(路牌|标志|招牌|牌子).{0,6}(写的什么|写着什么|是什么)/;
if (visionQuestionPattern.test(raw) || /what('s| is)\s+(that|ahead)/i.test(raw)) {
  return { action: "camera.look", args: { question: raw } };
}
if (/(你能?看到?什么|看看前面|看一下前面)/.test(raw) || /what\s+(do|can)\s+you\s+see/i.test(raw)) {
  return { action: "camera.look", args: {} };
}
```

Note the generic block drops `前面是什么` (now caught above, with a question — it IS a specific question) — verify no existing grammar test asserts `前面是什么` maps to question-free args; if one does, update it to expect the question form and say so in your report.

3. `IssuedDeviceCommand`: add `question?: string`; `issue` gains the fourth parameter and stores it on the entry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/device-actions.test.ts tests/device-grounding.test.ts tests/device-protocol.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/device-actions.ts tests/device-actions.test.ts
git add server/device-actions.ts tests/device-actions.test.ts
git commit -m "feat(vision): detect specific vision questions and thread them to camera.look"
```

---

### Task 3: Doubao provider migration (question-threaded describe)

**Files:**

- Modify: `server/providers/doubao.ts` (module-scope describer at lines ~515-534; `cameraFrame` at lines ~1714-1751; the `pendingDeviceCommands.issue` dispatch site — grep for it in this file)
- Modify: `server/vision.ts` (DELETE `createDescriber` and its `DescriberOptions` type — its last consumer migrates here; keep everything else)
- Modify: `tests/vision.test.ts` (migrate the old `createDescriber` tests to `createArkVisionProvider` single-frame equivalents — preserve every failure-class case; delete none)
- Test: `tests/doubao-camera-frame.test.ts` (extend)

**Interfaces:**

- Consumes: `selectVisionProvider`/`VisionProvider` (Task 1); `IssuedDeviceCommand.question` + `issue(..., question)` (Task 2); `buildChatCompletionsEndpoint` (unchanged).
- Produces: no new exports. The doubao provider's `cameraFrame` behavior contract: describes `[event.image]` with `issued.question`, speaks the description (or "我看不清。") through the existing transcript+speaker path, detached from the session message queue exactly as today (vision.ts's fire-and-forget block at doubao.ts:1743-1750 — keep the comment).

- [ ] **Step 1: Read the existing test harness**

Read `tests/doubao-camera-frame.test.ts` fully before writing. It already drives the provider's `cameraFrame` with a stubbed describer/fetch; your new assertions must use its existing harness idioms (whatever it stubs — `fetchImpl` via env or module injection). Do not restructure the harness.

- [ ] **Step 2: Write the failing test**

Add to `tests/doubao-camera-frame.test.ts`, using its existing setup helpers, a case with this exact behavioral contract (adapt harness plumbing, not the assertions):

```ts
it("threads the rider's question into the vision request", async () => {
  // Arrange the harness so the provider issues camera.look with
  // question "路牌写的什么" (drive the same dispatch path the existing
  // tests use, now passing the question), deliver a camera.frame for that
  // commandId, and capture the outbound Ark request body.
  // Assert:
  //   - the captured request's content ends with { type: "text", text: "路牌写的什么" }
  //   - the spoken/transcript line equals the stubbed model answer
});
```

If the harness stubs at a level where the outbound body is invisible (e.g. it fakes the whole describer), assert instead that the describe call received `(["<frame>"], "路牌写的什么")` — the harness level decides which of the two equivalent assertions you write; say which in your report.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/doubao-camera-frame.test.ts` — Expected: new case FAILS (no question threaded).

- [ ] **Step 4: Implement the migration**

1. `server/providers/doubao.ts` module scope (replace lines ~529-534, keep the surrounding comments updated from "createDescriber" to the provider names):

```ts
const visionProvider = selectVisionProvider(
  {
    apiKey: process.env.ARK_API_KEY,
    model: process.env.ARK_MODEL,
    endpoint: arkBaseUrl ? buildChatCompletionsEndpoint(arkBaseUrl) : undefined,
    onFailure: (reason) => visionLog.warn("scene description failed", { reason })
  },
  visionLog
);
```

2. `cameraFrame` (line ~1744): `const description = await visionProvider.describe([event.image], issued.question);` — everything else in the handler, including the detached-execution comment block, stays byte-identical.
3. The dispatch site that calls `pendingDeviceCommands.issue(...)`: pass the question — `pendingDeviceCommands.issue(command.action, deviceSuccessSpeech(command), Date.now(), command.action === "camera.look" ? command.args.question : undefined)`.
4. `server/vision.ts`: delete `createDescriber` + `DescriberOptions`; migrate `tests/vision.test.ts`'s old describer tests to `createArkVisionProvider({...}).describe([frame])` equivalents preserving every failure-class assertion (missing key, HTTP error, timeout, empty content, malformed body).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/doubao-camera-frame.test.ts tests/doubao-frame.test.ts tests/vision.test.ts`
Expected: PASS.
Run: `npm test` once — Expected: all green (doubao.ts is widely exercised).
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
npx prettier --write server/providers/doubao.ts server/vision.ts tests/vision.test.ts tests/doubao-camera-frame.test.ts
git add server/providers/doubao.ts server/vision.ts tests/vision.test.ts tests/doubao-camera-frame.test.ts
git commit -m "feat(vision): thread rider questions through the doubao camera.look path"
```

---

### Task 4: Mock voice provider camera.look demo path

**Files:**

- Modify: `server/providers/mock.ts` (add a `cameraFrame` method to the provider object; module- or factory-scope `createMockVisionProvider()`)
- Test: `tests/mock-camera-frame.test.ts` (create; model its harness on `tests/doubao-camera-frame.test.ts`'s structure and on how existing mock-provider tests in `tests/agent.test.ts` / `tests/golden-replay.test.ts` construct the mock provider — read those first)

**Interfaces:**

- Consumes: `createMockVisionProvider` (Task 1); mock.ts's existing `pendingDeviceCommands` instance (line ~247) and its transcript/speech emission utilities (study `dispatchDeviceCommand` at ~244 and the turn machinery at ~310-334 before writing).
- Produces: the mock provider answers `camera.frame` events for issued `camera.look` commands with the deterministic mock strings, emitted as a final agent transcript with `useBrowserSpeech: true` — so an embedded (or any) client demoing against the mock voice provider hears a description with zero credentials.

- [ ] **Step 1: Write the failing test**

Create `tests/mock-camera-frame.test.ts`:

```ts
import { describe, expect, it } from "vitest";
// Imports: construct the mock provider exactly the way tests/agent.test.ts does
// (fake client WebSocket capturing sent JSON), then:

describe("mock provider camera.look", () => {
  it("describes a frame for an issued camera.look and speaks via transcript", async () => {
    // 1. Start a session on the mock provider with platform "embedded".
    // 2. Drive the rider utterance "你能看到什么" through the same path the
    //    existing mock tests use, capturing the dispatched device.command
    //    (action camera.look) and its commandId.
    // 3. Call provider.cameraFrame({ commandId, image: "aGVsbG8=" }).
    // 4. Assert a transcript event was sent with speaker "agent",
    //    final: true, useBrowserSpeech: true, and text
    //    "前方道路畅通，天气晴朗。" (the deterministic mock answer).
  });

  it("ignores a camera.frame whose commandId was never issued", async () => {
    // provider.cameraFrame({ commandId: "forged", image: "x" }) sends nothing.
  });

  it("answers the rider's question with the question-form mock string", async () => {
    // Utterance "前面那个路牌写的什么" → camera.look with question →
    // transcript text "关于“前面那个路牌写的什么”：我看到前方道路畅通。"
  });
});
```

The comments above are the behavioral contract; write them as real code against the harness you find in the existing mock-provider tests. If the mock provider cannot be driven this way (no test constructs it directly), report NEEDS_CONTEXT with what you found instead of inventing a new harness style.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mock-camera-frame.test.ts` — Expected: FAIL (`cameraFrame` is undefined on the mock provider).

- [ ] **Step 3: Implement**

In `server/providers/mock.ts`:

- Construct one `createMockVisionProvider()` (module scope; it is stateless). Deliberately NOT `selectVisionProvider`: the mock voice provider is the zero-credential demo surface and must never spend Ark quota (spec M1) — put that sentence in a comment.
- Add `async cameraFrame(event)` to the returned provider object, mirroring doubao.ts's guard exactly: `const issued = pendingDeviceCommands.peek(event.commandId); if (!issued || issued.action !== "camera.look") return;` then `const description = await mockVision.describe([event.image], issued.question);` (mock never returns null, but keep the `?? "我看不清。"` fallback for contract symmetry) and emit it through the mock's existing final-agent-transcript path with `useBrowserSpeech: true`.
- Ensure mock's `dispatchDeviceCommand` passes the question into `issue(...)` the same way Task 3 did for doubao (fourth argument).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mock-camera-frame.test.ts tests/agent.test.ts tests/golden-replay.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/providers/mock.ts tests/mock-camera-frame.test.ts
git add server/providers/mock.ts tests/mock-camera-frame.test.ts
git commit -m "feat(vision): keyless camera.look demos on the mock voice provider"
```

---

### Task 5: Closeout — full check, README, env template

**Files:**

- Modify: `README.md` (Current Capabilities — extend the vision-related bullet: live look now answers the rider's actual question; works keylessly on the mock provider; the real Ark key drops in via `ARK_API_KEY`/`ARK_MODEL`)
- Verify: `.env.example` already documents `ARK_API_KEY` / `ARK_BASE_URL` / `ARK_MODEL` (`grep ARK .env.example`) — add the three with one-line comments only if absent.

- [ ] **Step 1: README + env template**

Make the edits above, matching the README's long, factual bullet voice. Do not claim gallery or watching capabilities — those are V-B/V-C.

- [ ] **Step 2: Full repository gate**

Run: `npm run check`
Expected: exit 0. Fix fallout inline (prettier, knip on any now-unconsumed export, eslint), never by deleting functionality.

- [ ] **Step 3: Commit**

```bash
git add README.md .env.example
git commit -m "docs(vision): document question-answering live look and keyless demos"
```

- [ ] **Step 4: Verify branch state**

Run: `git log --oneline -8`
Expected: the 5 task commits; nothing touches `ios/`, `android/`, `rdk/` source (the board's flow is byte-identical in V-A), and no `vision.frames`/`gallery.describe`/governor code exists anywhere.

---

## Deferred to V-B and V-C (do not implement here)

- **V-B:** `gallery.describe` command + grammar, `vision.frames` chunked protocol event + relay assembly, iOS key-frame extraction and latest-capture resolution, `FAILURE_SPEECH` entries `gallery.empty`/`gallery.unreadable`.
- **V-C:** `vision.watch` toggle, board sampler + histogram change gate, `server/vision-governor.ts` + metrics, watching prompt.
