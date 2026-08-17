# Navigation fabrication guard

Status: implemented 2026-08-17 (detector, runtime guard, prompt) — frame ordering unmeasured, see below
Date: 2026-08-16

## Problem

When navigation fails, Max invents it instead.

Reproduced live on `h2o` three times consecutively, 2026-08-16 11:27-11:30, on
the deployed relay (`fbca3ac`):

- Each attempt: `session.start`, a completed turn, then a `device.result`
  **with no preceding `nav.request`**. No route was ever requested of AMap,
  so no route existed, no guidance card rendered, and no map appeared.
- The rider nonetheless reported being "led verbally" — turn-by-turn spoken
  guidance, with no location data behind any of it.

The absent map was correct. The voice was not.

This was recorded as a MUST-FIX on 2026-08-12 and stayed unfixed until this
branch (see Status above). At the time, the grounding prompt
(`server/providers/doubao.ts:56`, plus the hands-free override at `:152`)
instructed the model to help with 导航 and never to refuse navigation
requests, and nothing anywhere forbade it from _narrating_ navigation it did
not have — a repo-wide search found no guard.

A rider following invented directions at speed is worse off than one told
"navigation failed": the honest failure is safe, the fabrication is not. It
also masks every failure beneath it — tonight's first-fix retry work looked
plausibly successful precisely because Max kept talking.

## The rule

**Navigation truth may originate only from the relay's own `nav.*` speech.**

Not "only when no route is active". Always. With a route active the model can
still invent a _wrong_ turn, and a rider following a confidently-wrong
instruction mid-ride is at least as dangerous as one following a fictional
route. The relay already owns the authoritative channel (`speakNavLine`,
`speakNavPrompt`); this makes that ownership exclusive.

Making the rule unconditional also makes it simpler: the gate does not need to
know whether a route is active. Route state selects only _which_ honest line
to speak after a suppression.

## Why prompt-only is not enough

Prompt text is prevention without enforcement. It reduces frequency, cannot
guarantee anything, and silently regresses whenever the upstream model
changes — with no test that would catch it. A classifier call was considered
and rejected: it adds latency to the one path where latency is the product,
costs money per turn, and puts a second model in charge of deciding what is
safe, which is the thing that just failed.

The design is therefore defense in depth: a **deterministic gate** that
enforces, and a **prompt rule** that reduces how often the gate must fire.

## Architecture

The relay already sees the model's words before the rider hears them, and
already has hold-and-decide audio machinery built for the wake-word gate:

- Incremental `ChatResponse` text arrives at `server/providers/doubao.ts:1740`
- Audio accumulates in `pendingUndecidedAudio` (`:702`)
- `flushUndecidedTtsAudio()` (`:842`) releases it; `clearUndecidedTtsAudio()`
  (`:849`) discards it
- `truncateInterruptedReply()` (`:854`) cuts off a reply already speaking

The guard adds a second reason to discard, alongside "not addressed to Max".

**Correction to an earlier draft of this section:** that buffer is NOT a
general hold. `bufferUndecidedTtsAudio()` (`:1572`) buffers only while
`wakeWordEnabled && !replyIsAddressed()` — i.e. during the wake-word decision.
Once the reply is addressed (the normal case), `flushUndecidedTtsAudio()`
(`:1575`) forwards every chunk immediately. Reusing it as-is would therefore
protect only a narrow window, not the common path.

**Superseded — the "two tiers" question below was answered; kept for
history, not as current guidance.** An earlier draft treated "does the
guard need a new per-sentence audio hold, or is the truncate-after-forward
fallback the only achievable behaviour" as an open, frame-ordering-dependent
question. It is not: the shipped implementation gates on a single boolean
(`fabricationSuppressed`, set the instant a sentence is flagged) checked at
every audio-forwarding call site, which covers both "not yet forwarded" and
"already forwarded" with no dependency on which frame — text or audio —
arrives first. See the paragraph below this one for what that means for the
frame-ordering measurement itself.

**The frame ordering was never measured; the probe deploy was blocked by a
permission gate.** It turned out not to matter: the implementation suppresses
audio at `forwardTtsAudio` via a `fabricationSuppressed` flag, which drops
both already-buffered audio and any later chunks regardless of which frame
arrives first. Both tiers are therefore covered by a single mechanism. What
remains unmeasured is only how much of a fabricated syllable a rider might
hear before detection lands — a UX question, not a safety one.

**After suppression**, in order:

1. Speak one honest line through `speakFabricationGuardLine`
   (`server/providers/doubao.ts` — its own dedicated function, deliberately
   NOT `speakNavPrompt`: that method's non-interrupt branch waits on
   `waitForOrdinarySpeech` before it will even start, which the correction
   must not do, since it is replacing speech that was just truncated).
2. **Delete**, not inject — the fabricated item is removed from the upstream
   conversation via `EventSend.ConversationDelete`
   (`deleteSuppressedTurns()`, `server/providers/doubao.ts:960`, and
   `markCurrentTurnSuppressed()`, `:982`), so the model does not build on its
   own fabrication on the next turn. No text is ever added to its context;
   the fabricated turn is simply gone from the history it sees.

Relay-spoken `nav.*` lines are exempt by construction: they never travel
through the model's `ChatResponse` stream.

## What counts as a navigation assertion

Three families, matched lexically — not free-text judgement:

| Family               | Examples that must be suppressed                  |
| -------------------- | ------------------------------------------------- |
| Maneuver instruction | 前方左转 / 右转进入中山东一路 / 掉头 / 沿…直行    |
| Distance to maneuver | 前方800米后左转 / 再走300米后掉头 / 1.2公里后到达 |
| Position claim       | 你当前在朝阳路与和平西街交叉口 / 你在滨河路上     |

Explicitly allowed, and covered by must-not-suppress fixtures:

| Allowed                    | Why                                         |
| -------------------------- | ------------------------------------------- |
| 好的，正在为你规划路线     | Acknowledgement, asserts nothing            |
| 外滩在黄浦区，靠近南京东路 | General place knowledge, not guidance       |
| 导航还没启动               | The honest failure itself                   |
| Any relay `nav.*` line     | Authoritative by definition, different path |

The fixture table is this spec's real contract. It should be seeded from
tonight's transcript — the 2026-08-12 bench captured 滨河路/朝阳路,
"前方800米后左转", "全程约12公里，预计22分钟", and
"你当前在朝阳路与和平西街交叉口" — and grown whenever a real false
negative is found.

## Honest lines

| Situation                   | Line                           |
| --------------------------- | ------------------------------ |
| Suppressed, no route active | 导航还没启动，我没法给你指路。 |
| Suppressed, route active    | 请以导航提示为准。             |

Route state comes from `session-controller.ts`'s `navHandler.activeRoute()`
(the `createNavHandler` closure in `server/routing.ts`), passed down as
`ProviderSessionContext.routeActive` (`server/providers/types.ts`) — a live
accessor evaluated on every guard fire, not a snapshot. `DeviceActivityContext`
(which the provider already owns for other purposes, `doubao.ts:633`) was
tried first: it gained a narrow `isActive()` accessor and the guard read
`deviceActivity.isActive("navigation")`. That was rejected and the accessor
removed — `DeviceActivityContext` only reflects `navigation.start`/`stop`
commands THIS session dispatched by voice, so it read stale-true after a
route was stopped by any other means and reset on every reconnect regardless
of whether a route was still running. `navHandler.activeRoute()` is a better
source, but still not a fully authoritative one — see its own doc comment in
`doubao.ts` for the staleness this still cannot cover.

## Provider parity

`server/providers/mock.ts` also implements `speakNavLine` (`:693`). The mock is
scripted and cannot fabricate, so the gate is a no-op there — but the shared
detection function must live outside the doubao provider so both providers,
and any future one, are held to the same rule rather than each re-deriving it.

## Testing

- **Fixture table** over the detection function: every row in both tables
  above, asserting suppress/allow. Pure, no provider, no network.
- **Buffered-audio path**: a fabricated assertion arriving while audio is
  still pending calls `clearUndecidedTtsAudio()` and never forwards a chunk.
- **Already-speaking path**: the same assertion arriving after flush calls
  `truncateInterruptedReply()`.
- **Honest line**: suppression is followed by exactly one
  `speakFabricationGuardLine` call, and the line matches route state.
- **Exemption**: a relay `nav.*` line is never suppressed, including when its
  text contains maneuver words — the regression that would make the guard
  silence real navigation.
- **Upstream deletion**: the fabricated item is deleted via
  `ConversationDelete` once per suppressed reply, not once per chunk, and not
  a second time for the same QA pair (`markCurrentTurnSuppressed`'s own doc
  comment).

## Limitations, stated deliberately

A lexical gate has false negatives. A paraphrase outside the three families
still reaches the rider; this reduces risk rather than eliminating it, and the
prompt half covers the long tail. Claiming otherwise would be the same
overclaiming this codebase has already been bitten by.

**Correction to an earlier draft of this section:** the embedded/RDK speech
path was originally planned as out of scope. It is not — the honest line
routes through `speakFabricationGuardLine` → `speakEmbedded` on every
platform including embedded, and RDK's own barge-in path
(`rdk/agent/src/main.ts`) was changed to route the guard's client-clear
signal (matched by `NAV_FABRICATION_CLEAR_DETAIL`,
`shared/nav-fabrication.ts`) to an unconditional playback flush instead of
its normal mic-corroborated barge-in path, since a fabrication event has no
rider speech to corroborate.

What remains genuinely out of scope is full automated verification of that
path: the guard's client-side audibility — that the honest line is actually
heard, and no fabricated audio plays — is verified by server-side unit tests
and code tracing only. There is no automated end-to-end audio test. RDK in
particular has no test harness at all, so its flush-routing change was
verified by typecheck (`npm run check:rdk`) and reading the code, not by a
running test.

## Out of scope

- Full automated end-to-end audio verification, RDK's own test harness
  (RDK has none — see Limitations above)
- Any change to how routes are requested or to the first-fix retry
- Non-navigation fabrication (weather, hazards) — same class, different rule

## Review notes

An earlier draft of this design planned to INJECT a correction into the
model's conversation context. The shipped implementation does not inject
anything — it DELETES the fabricated item from the upstream conversation
(`ConversationDelete`, see "After suppression" above), so there is no new
text for the model to react to and no question of it "believing" something
different mid-session. The deletion-vs-injection choice was made during
implementation, not left open for this review.
