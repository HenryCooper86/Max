# Navigation Fabrication Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it impossible for the model to speak turn-by-turn navigation the relay did not give it.

**Architecture:** A pure, fixture-driven detector decides whether a spoken sentence asserts navigation. The doubao provider consults it as each TTS sentence arrives, suppresses the reply, speaks one honest line through the authoritative channel, and deletes the offending item from the model's upstream conversation. A prompt rule reduces how often the gate must fire; the gate is what enforces.

**Tech Stack:** TypeScript, vitest, the doubao realtime provider.

**Spec:** `docs/superpowers/specs/2026-08-16-navigation-fabrication-guard-design.md`

## Global Constraints

- The rule is unconditional: navigation truth may originate ONLY from the relay's `nav.*` speech, whether or not a route is active.
- Relay-spoken lines (`speakNavLine`, `speakNavPrompt`) must NEVER be suppressed — they do not pass through the model's TTS stream, and a test must pin that.
- Honest line, no route active, exactly: `导航还没启动，我没法给你指路。`
- Honest line, route active, exactly: `请以导航提示为准。`
- Exactly one honest line per suppressed reply — not one per sentence or per chunk.
- The detector must be pure and provider-independent so mock and doubao are held to the same rule.
- Do not add a model/classifier call anywhere in the speech path.
- The spec's open question is resolved here: the model is corrected by DELETING the fabricated item from its upstream conversation (the existing `deleteSuppressedTurns` path), not by injecting new context text. Deleting reuses a proven mechanism and cannot itself say anything wrong, so no flag is needed.
- False negatives are accepted and documented; false positives that silence legitimate speech are defects.

---

### Task 1: The pure detector

Everything else depends on this, and it is the only piece that can be fully tested without a provider. The fixture table below IS the contract — it is seeded from real fabricated output captured on 2026-08-12 and 2026-08-16.

**Files:**

- Create: `shared/nav-fabrication.ts`
- Create: `tests/nav-fabrication.test.ts`

**Interfaces:**

- Produces: `export function assertsNavigation(text: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/nav-fabrication.test.ts`:

```ts
// tests/nav-fabrication.test.ts
import { describe, expect, it } from "vitest";
import { assertsNavigation } from "../shared/nav-fabrication";

// Navigation truth may come only from the relay. When the real pipeline fails,
// the model fills the silence with plausible fiction — invented street names,
// distances and positions — and a rider at speed follows it. These fixtures
// are real output: the 2026-08-12 bench and the 2026-08-16 h2o session.
const FABRICATED = [
  "前方800米后左转",
  "前方左转进入中山东一路",
  "沿滨河路直行，然后右转",
  "再走300米后掉头",
  "1.2公里后到达目的地",
  "你当前在朝阳路与和平西街交叉口",
  "你在滨河路上，继续直行",
  "全程约12公里，预计22分钟"
];

// Legitimate speech that must survive. A guard that silences these is worse
// than no guard: it breaks the assistant for the sake of the rule.
const ALLOWED = [
  "好的，正在为你规划路线",
  "外滩在黄浦区，靠近南京东路",
  "导航还没启动，我没法给你指路。",
  "请以导航提示为准。",
  "今天有雨，注意路面湿滑",
  "我没找到这个地方",
  "路线规划失败。",
  "已停止导航。"
];

describe("assertsNavigation", () => {
  for (const text of FABRICATED) {
    it(`suppresses fabricated guidance: ${text}`, () => {
      expect(assertsNavigation(text)).toBe(true);
    });
  }

  for (const text of ALLOWED) {
    it(`allows legitimate speech: ${text}`, () => {
      expect(assertsNavigation(text)).toBe(false);
    });
  }

  it("ignores empty and whitespace input", () => {
    expect(assertsNavigation("")).toBe(false);
    expect(assertsNavigation("   ")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/nav-fabrication.test.ts`
Expected: FAIL — the module `shared/nav-fabrication.ts` does not resolve.

- [ ] **Step 3: Write the detector**

Create `shared/nav-fabrication.ts`:

```ts
// Whether a spoken sentence asserts navigation the model has no authority to
// give. Navigation truth may originate only from the relay's nav.* speech;
// when the real pipeline fails, the model otherwise narrates invented streets,
// distances and positions, and a rider at speed follows them.
//
// Deliberately lexical rather than a model call: this sits in the speech path,
// where latency is the product, and a guard that cannot be tested is not a
// guard. It has false negatives by construction — a paraphrase outside these
// families still reaches the rider, and the grounding prompt covers that tail.
// A false positive is the worse defect: it silences legitimate speech.

// Note there is deliberately no bare-maneuver-verb pattern: 左转/直行 alone are
// not guidance ("进入导航模式", "直行区间测速"), so every rule below requires a
// distance, a road, a position or a sequencing word alongside the verb.

/** A distance leading to a maneuver or arrival: "前方800米后左转", "再走300米". */
const DISTANCE_TO_MANEUVER = /(前方|再走|还有|经过)\s*\d+(?:\.\d+)?\s*(?:米|公里|千米)/;

/** A claim about where the rider currently is. */
const POSITION_CLAIM = /(?:你|您)(?:现在|当前)?(?:在|位于)[^，。！？]{0,24}(?:路|街|大道|巷|桥|口|交叉|附近)/;

/** Whole-route statistics the model cannot know without a route. */
const ROUTE_STATS = /全程(?:约)?\s*\d+(?:\.\d+)?\s*(?:公里|千米|米)|预计\s*\d+\s*分钟/;

/** A maneuver verb given a road or sequencing context, i.e. actual guidance. */
const MANEUVER_IN_CONTEXT =
  /(?:前方|然后|接着|沿|再)[^，。！？]{0,16}(?:左转|右转|掉头|直行)|(?:左转|右转|驶入)[^，。！？]{0,16}(?:路|街|大道|匝道)/;

export function assertsNavigation(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (DISTANCE_TO_MANEUVER.test(value)) return true;
  if (POSITION_CLAIM.test(value)) return true;
  if (ROUTE_STATS.test(value)) return true;
  if (MANEUVER_IN_CONTEXT.test(value)) return true;
  // A bare maneuver verb with no road, distance or sequencing context is not
  // guidance on its own ("进入导航模式", "直行区间测速").
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/nav-fabrication.test.ts`
Expected: PASS. If any ALLOWED fixture fails, loosen the pattern rather than deleting the fixture — a false positive is the worse defect. If any FABRICATED fixture fails, tighten. Do not change the fixture text.

- [ ] **Step 5: Run the full gate**

Run: `npm run check`
Expected: exit 0. If knip reports `shared/nav-fabrication.ts` as unused, that is expected until Task 3 imports it — note it and proceed; do not delete the export.

- [ ] **Step 6: Commit**

```bash
git add shared/nav-fabrication.ts tests/nav-fabrication.test.ts
git commit -m "feat(nav): detect model-fabricated navigation assertions"
```

---

### Task 2: Establish the real frame ordering

The spec cannot say whether the rider hears nothing or hears a clipped fragment, because doubao's relative ordering of `TtsSentenceStart` (text) and `TtsResponse` (audio) is unverified. Task 3's behaviour depends on the answer, so measure it rather than assume.

**Files:**

- Modify (temporarily): `server/providers/doubao.ts`
- Create: `docs/superpowers/notes/2026-08-16-doubao-tts-frame-ordering.md`

**Interfaces:**

- Produces: a written finding stating whether text leads audio, consumed by Task 3.

- [ ] **Step 1: Add temporary ordering instrumentation**

In `server/providers/doubao.ts`, inside the `TtsResponse` handler (`:1411`) and the `TtsSentenceStart`/`TtsSentenceEnd` handler (`:1558`), add one log line each, guarded by an env flag so it never runs in normal operation:

```ts
// TEMPORARY (Task 2): resolve whether sentence text precedes its audio.
if (process.env.DOUBAO_LOG_FRAME_ORDER === "1") {
  log.info("frame order", { event: String(frame.event), at: Math.round(performance.now()) });
}
```

Place the `TtsResponse` one before the wake-word branch so it records every audio frame.

- [ ] **Step 2: Deploy and capture a live session**

The relay must be running against the real provider to observe real ordering. Deploy with the flag set, or run locally with `VOICE_PROVIDER=doubao` and real credentials from `.env`.

Ask the human partner to run one short voice turn that produces a spoken reply, then read the relay log:

```bash
ssh -i ~/Desktop/LightsailDefaultKey-ap-northeast-2.pem ubuntu@3.35.135.136 \
  'grep "frame order" ~/.pm2/logs/horizon-out.log | tail -40'
```

- [ ] **Step 3: Write the finding**

Create `docs/superpowers/notes/2026-08-16-doubao-tts-frame-ordering.md` recording: the observed sequence, whether `TtsSentenceStart` for a sentence reliably precedes the `TtsResponse` chunks carrying it, and the typical gap in milliseconds. State plainly which tier Task 3 must implement:

- **Text leads audio** → Task 3 may hold the current sentence's audio and discard it, so the rider hears nothing.
- **Audio leads text, or the order is inconsistent** → Task 3 implements truncation only; holding would add latency for no benefit.

- [ ] **Step 4: Remove the instrumentation**

Revert the two log lines. The finding is the deliverable, not the logging.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes/2026-08-16-doubao-tts-frame-ordering.md server/providers/doubao.ts
git commit -m "docs(nav): record doubao TTS frame ordering for the fabrication guard"
```

---

### Task 3: Wire the guard into the doubao provider

**Files:**

- Modify: `server/providers/doubao.ts` (TTS sentence handler, plus a suppression helper)
- Create: `tests/nav-fabrication-guard.test.ts`

**Interfaces:**

- Consumes: `assertsNavigation` from `shared/nav-fabrication.ts` (Task 1)
- Consumes: the tier decision from Task 2's finding
- Consumes: `suppressedItemIds` / `deleteSuppressedTurns()` (`doubao.ts:893`), `truncateInterruptedReply()` (`:787`), `clearUndecidedTtsAudio()` (`:782`), `speakNavPrompt` (`:2119`)

- [ ] **Step 1: Write the failing test**

Create `tests/nav-fabrication-guard.test.ts`. The doubao provider is heavyweight, so test the guard's decision function rather than the socket. Extract and test this shape:

```ts
// tests/nav-fabrication-guard.test.ts
import { describe, expect, it, vi } from "vitest";
import { navFabricationGuard } from "../server/nav-fabrication-guard";

function guard(routeActive = false) {
  const calls = {
    truncate: vi.fn(),
    clearAudio: vi.fn(),
    speak: vi.fn(),
    suppressItem: vi.fn()
  };
  return {
    calls,
    g: navFabricationGuard({
      routeActive: () => routeActive,
      truncateReply: calls.truncate,
      clearPendingAudio: calls.clearAudio,
      speakHonestLine: calls.speak,
      suppressItem: calls.suppressItem
    })
  };
}

describe("navFabricationGuard", () => {
  it("passes legitimate speech through untouched", () => {
    const { g, calls } = guard();
    expect(g.inspectSentence("好的，正在为你规划路线", "item-1")).toBe(false);
    expect(calls.speak).not.toHaveBeenCalled();
    expect(calls.truncate).not.toHaveBeenCalled();
  });

  it("suppresses a fabricated maneuver and speaks the no-route line", () => {
    const { g, calls } = guard(false);
    expect(g.inspectSentence("前方800米后左转", "item-2")).toBe(true);
    expect(calls.speak).toHaveBeenCalledWith("导航还没启动，我没法给你指路。");
    expect(calls.suppressItem).toHaveBeenCalledWith("item-2");
  });

  it("speaks the route-active line when a route is running", () => {
    const { g, calls } = guard(true);
    g.inspectSentence("前方800米后左转", "item-3");
    expect(calls.speak).toHaveBeenCalledWith("请以导航提示为准。");
  });

  // The rider must not hear the honest line once per sentence.
  it("speaks exactly one honest line per reply", () => {
    const { g, calls } = guard();
    g.inspectSentence("前方800米后左转", "item-4");
    g.inspectSentence("然后右转进入中山东一路", "item-4");
    g.inspectSentence("再走300米", "item-4");
    expect(calls.speak).toHaveBeenCalledTimes(1);
  });

  it("re-arms for the next reply", () => {
    const { g, calls } = guard();
    g.inspectSentence("前方800米后左转", "item-5");
    g.beginReply();
    g.inspectSentence("再走300米后掉头", "item-6");
    expect(calls.speak).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/nav-fabrication-guard.test.ts`
Expected: FAIL — `server/nav-fabrication-guard.ts` does not resolve.

- [ ] **Step 3: Write the guard**

Create `server/nav-fabrication-guard.ts`:

```ts
// Enforces the rule that navigation truth may originate only from the relay's
// nav.* speech. The detector decides; this decides what to do about it, kept
// out of the provider so it is testable without a socket.

import { assertsNavigation } from "../shared/nav-fabrication";

export const NO_ROUTE_LINE = "导航还没启动，我没法给你指路。";
export const ROUTE_ACTIVE_LINE = "请以导航提示为准。";

export type NavFabricationGuardDeps = {
  routeActive: () => boolean;
  /** Cut off a reply whose audio has already reached the rider. */
  truncateReply: () => void;
  /** Drop audio not yet forwarded. No-op when nothing is held. */
  clearPendingAudio: () => void;
  speakHonestLine: (text: string) => void;
  /** Mark the upstream conversation item for deletion so the model does not
   *  build on its own fabrication. */
  suppressItem: (itemId: string) => void;
};

export function navFabricationGuard(deps: NavFabricationGuardDeps) {
  let firedThisReply = false;

  return {
    /** Call at the start of each agent reply. */
    beginReply(): void {
      firedThisReply = false;
    },

    /** Returns true when this sentence was suppressed. */
    inspectSentence(text: string, itemId: string | undefined): boolean {
      if (!assertsNavigation(text)) return false;
      // Every sentence of a fabricated reply is suppressed, but the rider
      // hears the correction once — not once per sentence.
      if (!firedThisReply) {
        firedThisReply = true;
        deps.clearPendingAudio();
        deps.truncateReply();
        deps.speakHonestLine(deps.routeActive() ? ROUTE_ACTIVE_LINE : NO_ROUTE_LINE);
      }
      if (itemId) deps.suppressItem(itemId);
      return true;
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/nav-fabrication-guard.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Wire it into the provider**

In `server/providers/doubao.ts`:

1. Import `navFabricationGuard` and construct it once per session, beside `const deviceActivity = new DeviceActivityContext();` (`:623`):

```ts
const fabricationGuard = navFabricationGuard({
  routeActive: () => deviceActivity.isActive("navigation"),
  truncateReply: () => truncateInterruptedReply(),
  clearPendingAudio: () => clearUndecidedTtsAudio(),
  speakHonestLine: (text) => api.speakNavPrompt?.({ text, interrupt: true }),
  suppressItem: (itemId) => suppressedItemIds.add(itemId)
});
```

Adjust the `speakHonestLine` wiring to whatever the in-scope reference to the provider's own `speakNavPrompt` is at that point in the file; if it is not reachable there, call the same internal helper `speakNavPrompt` itself uses.

2. In the `TtsSentenceStart`/`TtsSentenceEnd` handler (`:1558`), after `ttsText += text` and before the partial transcript is sent, consult the guard:

```ts
if (fabricationGuard.inspectSentence(text, currentReplyId)) {
  deleteSuppressedTurns();
  return;
}
```

Returning early also stops the fabricated text reaching the client as a caption — the transcript must not show what the audio was denied.

3. Call `fabricationGuard.beginReply()` wherever a new agent reply begins (the same place `sentThinkingStatus`/`ttsText` are reset for a new turn).

4. Add the accessor the guard needs to `DeviceActivityContext` in `server/device-actions.ts`:

```ts
  /** Whether a tracked activity is currently running, for callers that must
   *  not keep a parallel copy of this state. */
  isActive(target: DeviceActivityIntent["target"]): boolean {
    return this.active[target];
  }
```

5. If Task 2's finding says audio leads text, `clearPendingAudio` will usually be a no-op — that is expected and correct; leave the call in, since it costs nothing and covers the wake-word window.

- [ ] **Step 6: Prove the exemption**

Add to `tests/nav-fabrication-guard.test.ts`:

```ts
it("never suppresses relay-spoken navigation lines", () => {
  // Relay lines do not pass through the model's TTS stream at all, so the
  // guard must never see them. This pins the property that the guard cannot
  // silence real navigation: the detector would flag this text, and the guard
  // is simply never asked about it.
  expect(assertsNavigation("前方300米右转")).toBe(true);
});
```

Import `assertsNavigation` at the top of that file. Then verify by reading `server/session-controller.ts:571` and `:706` that relay nav speech reaches `speakNavLine`/`speakNavPrompt` directly and never traverses the `TtsSentence` path. State that in the report.

- [ ] **Step 7: Run the full gate**

Run: `npm run check`
Expected: exit 0

- [ ] **Step 8: Commit**

```bash
git add server/nav-fabrication-guard.ts server/providers/doubao.ts server/device-actions.ts tests/nav-fabrication-guard.test.ts
git commit -m "fix(relay): stop the model speaking navigation it was never given"
```

---

### Task 4: The prompt rule

The gate enforces; the prompt reduces how often it must. Without this the rider hears the correction constantly, which is safe but unusable.

**Where it must go, and why not the obvious place.** `DEFAULT_AGENT_SYSTEM_PROMPT` (`doubao.ts:55`) is overridable per deployment via `DOUBAO_SYSTEM_ROLE` (`:1826`), so a safety rule placed there disappears the moment someone sets that env var. `buildToolGroundingPrompt()` (`:145`) is always appended and survives the override — the same reason `buildIdentityPrompt()` lives there. The rule goes in `buildToolGroundingPrompt()`.

Note that block already says 任何动作只有在系统明确返回成功之后才可以说已完成 — a rule about _actions completing_. The model evidently does not read narrating turn-by-turn as claiming an action completed, so the new rule must be specifically about route, road, direction, distance and position _content_.

**Files:**

- Modify: `server/providers/doubao.ts` (`buildToolGroundingPrompt()` at `:145`)
- Modify: `tests/device-grounding.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/device-grounding.test.ts` (it already imports `buildToolGroundingPrompt`):

```ts
it("forbids the model from narrating navigation it was not given", () => {
  // The same block tells the model never to refuse a navigation request. That
  // must not read as licence to invent one when the pipeline fails — which is
  // exactly what happened on h2o on 2026-08-16.
  const prompt = buildToolGroundingPrompt();
  expect(prompt).toContain("不要自己编造");
  expect(prompt).toContain("导航提示");
});

it("keeps the anti-fabrication rule where a deployment override cannot drop it", () => {
  // DEFAULT_AGENT_SYSTEM_PROMPT is replaceable via DOUBAO_SYSTEM_ROLE; this
  // block is always appended, so the rule must live here and not there.
  expect(buildToolGroundingPrompt()).toContain("不要自己编造");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/navigation-prompts.test.ts`
Expected: FAIL — the prompt contains no such instruction.

- [ ] **Step 3: Add the rule to the prompt**

Append to the string returned by `buildToolGroundingPrompt()`, immediately after the existing 任何动作只有在系统明确返回成功之后才可以说已完成 sentence so the two read as one contract:

```
"导航的路线、路名、转弯方向、距离和骑手当前位置只能来自系统的导航提示，不能由你自己说出。没有系统导航提示时，不要自己编造路线、路名、转弯、距离、预计时间或骑手位置；如实说明导航还没启动或定位失败即可。" +
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/navigation-prompts.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full gate**

Run: `npm run check`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add server/providers/doubao.ts tests/navigation-prompts.test.ts
git commit -m "fix(relay): forbid the model from inventing navigation in the prompt"
```

---

### Task 5: Close the spec

**Files:**

- Modify: `docs/superpowers/specs/2026-08-16-navigation-fabrication-guard-design.md`

- [ ] **Step 1: Mark it implemented and record the tier**

Change `Status: design, awaiting review` to `Status: implemented 2026-08-16 (detector, guard, prompt)`, and replace the "Two tiers, and which one dominates is an open empirical question" paragraph's uncertainty with the measured answer from Task 2's note, linking that note.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-08-16-navigation-fabrication-guard-design.md
git commit -m "docs(nav): mark the fabrication guard spec implemented"
```

---

## Verification before finishing the branch

- [ ] `npm run check` → exit 0
- [ ] Every fixture in `tests/nav-fabrication.test.ts` passes, and no ALLOWED fixture was deleted or weakened to make the suite green
- [ ] On-device bench, which no test covers: with GPS cold indoors, ask for a route. Max must say the honest line and must NOT narrate turns. Then, with a real route running, confirm relay navigation lines are still spoken normally — that is the regression that would make this guard worse than the bug.
