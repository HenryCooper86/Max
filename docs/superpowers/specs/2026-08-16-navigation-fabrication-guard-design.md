# Navigation fabrication guard

Status: design, awaiting review
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

This was recorded as a MUST-FIX on 2026-08-12 and is still unfixed. The
grounding prompt (`server/providers/doubao.ts:56`, plus the hands-free
override at `:152`) instructs the model to help with 导航 and never to refuse
navigation requests. Nothing anywhere forbids it from _narrating_ navigation
it does not have. A repo-wide search finds no guard.

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

- Incremental `ChatResponse` text arrives at `server/providers/doubao.ts:1574`
- Audio accumulates in `pendingUndecidedAudio` (`:771`)
- `flushUndecidedTtsAudio()` (`:775`) releases it; `clearUndecidedTtsAudio()`
  (`:782`) discards it
- `truncateInterruptedReply()` (`:787`) cuts off a reply already speaking

The guard adds a second reason to discard, alongside "not addressed to Max".

**Correction to an earlier draft of this section:** that buffer is NOT a
general hold. `doubao.ts:1416-1419` buffers only while
`wakeWordEnabled && !replyIsAddressed()` — i.e. during the wake-word decision.
Once the reply is addressed (the normal case), `:1420-1421` flushes and
forwards every chunk immediately. Reusing it as-is would therefore protect
only a narrow window, not the common path.

**Two tiers, and which one dominates is an open empirical question:**

1. **Audio not yet forwarded** — discard it; the rider hears nothing. This
   requires the sentence's text to reach us before its audio. Doubao sends
   `TtsSentenceStart` (text) and `TtsResponse` (audio) as separate frames, and
   **their relative order is unverified**. The existing buffer's own comment
   ("ASR and TTS may overlap") is evidence that audio can arrive early.
2. **Audio already forwarded** — `truncateInterruptedReply()`. The rider hears
   a clipped fragment. Bounded, and far better than a whole fabricated route.

If text reliably leads audio, a per-sentence hold gives tier 1 on the common
path — but that is a **new** hold on the audio path, not a reuse of the
wake-word one, and it adds latency to every reply, which must be measured
before it is accepted. If audio leads text, tier 2 is the only achievable
behaviour and the guard is a fast interrupt rather than a silencer.

**The implementation plan must therefore establish the real frame ordering
first, and choose the tier from measurement rather than from this document.**
Tier 2 alone already fixes the reported danger; tier 1 is an improvement to
pursue only if the ordering supports it.

**After suppression**, in order:

1. Speak one honest line through `speakNavPrompt` (authoritative channel,
   `interrupt: true`).
2. Inject a correction into the model's conversation context, so it stops
   re-attempting for the rest of the session. Without this the model simply
   tries again on the next turn and the rider hears repeated clipping.

Relay-spoken `nav.*` lines are exempt by construction: they never travel
through the model's `ChatResponse` stream.

## What counts as a navigation assertion

Three families, matched lexically — not free-text judgement:

| Family               | Examples that must be suppressed               |
| -------------------- | ---------------------------------------------- |
| Maneuver instruction | 前方左转 / 右转进入中山东一路 / 掉头 / 沿…直行 |
| Distance to maneuver | 前方800米后左转 / 再走300米 / 1.2公里后到达    |
| Position claim       | 你当前在朝阳路与和平西街交叉口 / 你在滨河路上  |

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

Route state comes from `DeviceActivityContext`, which the provider already
owns (`doubao.ts:623`) and which tracks `navigation` active/inactive from real
device results. Its `active` map is currently private; the guard needs a
narrow public accessor rather than a parallel state machine.

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
- **Honest line**: suppression is followed by exactly one `speakNavPrompt`,
  and the line matches route state.
- **Exemption**: a relay `nav.*` line is never suppressed, including when its
  text contains maneuver words — the regression that would make the guard
  silence real navigation.
- **Model context**: a correction is injected once, not once per chunk.

## Limitations, stated deliberately

A lexical gate has false negatives. A paraphrase outside the three families
still reaches the rider; this reduces risk rather than eliminating it, and the
prompt half covers the long tail. Claiming otherwise would be the same
overclaiming this codebase has already been bitten by.

The embedded/RDK speech path (`speakEmbedded`) is a separate surface and is
out of scope here; it needs its own assessment.

## Out of scope

- The RDK/embedded speech path
- Any change to how routes are requested or to the first-fix retry
- Non-navigation fabrication (weather, hazards) — same class, different rule

## Open question for review

Injecting a correction into the model's context is the part most likely to
behave unexpectedly, since it changes what the model believes mid-session. If
it proves to make replies worse, the fallback is suppression plus the honest
line alone, accepting repeated clipping. Worth deciding whether to ship both
halves at once or gate the context injection behind a flag for the first
bench.
