# Vision Expansion — Q&A, Gallery Understanding, and Proactive Watching

## Summary

The relay's vision path today is one feature wide: on the embedded board,
"你能看到什么" sends a single frame to a describer that has never had a real
credential, and answers with a fixed one-sentence prompt
(`docs/superpowers/specs/2026-07-28-vision-describe-design.md`). This spec
grows that seed into a provider-neutral vision service with three consumers:

1. **Live look becomes Q&A (M1).** The rider's actual question travels with
   the frame — "前面那个路牌写的什么" gets an answer about the road sign, not
   a generic scene description.
2. **The iOS gallery becomes queryable (M2).** "看看我刚拍的照片 /
   刚才录的视频里有什么" describes the most recent capture; videos are
   understood via on-device key-frame sampling, never uploaded.
3. **Proactive scene watching (M3).** Opt-in, Conservative-posture ambient
   observation from the helmet camera the board already streams — Max
   volunteers "前方施工" at most once per two minutes, never duplicating
   ADAS, never interrupting speech.

Everything works keylessly on a mock vision provider, exactly as the mock
voice provider and the mock route provider established: demos and tests need
no credential, and `ARK_API_KEY` + `ARK_MODEL` light the real path up with
zero code change.

Second half of the project split started by
`docs/superpowers/specs/2026-08-06-amap-navigation-design.md` (its "first
half" note); provider confirmed as Volcano Ark Doubao vision.

## Scope

### Goals

- A provider-neutral vision core in `server/vision.ts`:
  `describe(frames, question?) → string | null`, with `ArkVisionProvider`
  (multi-image chat-completions, question threading) and
  `MockVisionProvider` (canned deterministic answers), selected by
  `ARK_API_KEY` presence with the warn-once posture.
- M1: vision-question grammar; `camera.look` args carry the question; both
  providers answer it (mock voice provider gains a camera.look demo path).
- M2: `gallery.describe` device command (phone-gated), latest-capture
  resolution on iOS, 8-key-frame video sampling, chunked `vision.frames`
  transport, spoken answers with truthful result ordering.
- M3: board-side 30 s sampler with a scene-change gate; relay-side governor
  (cooldown, hourly cap, speech gate, ADAS dedupe, drop-not-queue);
  "开启/关闭环境观察" voice toggle, off by default.
- Fail-honest everywhere; fail-silent specifically for unprompted watching.
- Metrics for every governor drop reason.

### Non-goals

- Video upload / Ark `video_url` / object storage. Key-frame sampling only;
  the chunked-frames protocol leaves room to add upload later.
- Historical gallery retrieval language ("昨天的第三张照片"). Latest capture
  of the requested kind only.
- Phone-camera watching, RDK-gallery querying, watching on iOS/web.
- Caching described frames or storing them server-side. Describe-and-discard.
- Tuning the change-gate threshold beyond fixture-tested defaults (real-ride
  tuning is V-C follow-up work, like ADAS threshold tuning was).

## The vision core

`server/vision.ts` keeps its name, its fail-null philosophy, and its header
rationale, and gains the service shape:

```text
VisionProvider
  mode: "ark" | "mock"
  describe(frames: string[], question?: string) → Promise<string | null>
```

- `ArkVisionProvider` wraps today's chat-completions call: content becomes
  `[image, image, …, text]` with every frame as a base64 `image_url` part and
  the text part the rider's question, or the existing fixed describe prompt
  when no question was asked. Endpoint/key/model config is unchanged
  (`ARK_API_KEY`, `ARK_BASE_URL`, `ARK_MODEL`); the 10 s model timeout stays —
  every describe call happens _after_ the device-result round trip closes, so
  the relay's 8 s device window is never in play (the 07-28 spec's sequencing,
  kept deliberately).
- `MockVisionProvider` answers deterministically: one frame →
  "前方道路畅通，天气晴朗。", multiple frames → a short clip summary, a
  question → an answer that echoes the question so demos read sensibly.
- `selectVisionProvider(arkApiKey, log?)` mirrors `selectRouteProvider`:
  mock + one process-lifetime warning when the key is missing.
- The existing `createDescriber` consumers migrate to the new interface; the
  describer core exists once.

**Speech ownership is unchanged.** Vision events forward to the voice
provider exactly as `camera.frame` does today (`provider.cameraFrame`,
session-controller line ~486); the provider turns descriptions into speech
through its own path. The core service and the M3 governor are pure shared
modules both providers consume — that, plus `MockVisionProvider`, is what
makes every feature work on the mock voice provider.

## M1 — live look becomes Q&A

- Grammar: vision-question detection joins the one relay grammar —
  "你能看到什么 / 看看前面 / 前面…是什么 / 路牌写的什么 / what do you see"
  → `camera.look { question }` (the raw rider utterance; the model reads
  Chinese fine — no reformulation layer). Platform gate unchanged
  (embedded only).
- The board's flow is byte-identical (fetch frame, `camera.frame` up); the
  relay threads `question` from the issued command into `describe`.
- The mock voice provider gains the same `cameraFrame` handling backed by
  `MockVisionProvider`, so 看看 demos stop being live-provider-only.

## M2 — iOS gallery understanding

### Command and resolution

`gallery.describe { kind: "photo" | "video" | "latest", question? }`, low
tier, platform-gated to phones the way `camera.look` is gated to the board
(the same `PLATFORM_RESTRICTED_ACTIONS` map — one more entry, not a new
mechanism). Grammar: "看看/描述 我(刚)拍的照片" → kind photo; "…视频" →
video; "我刚拍的" alone → latest. iOS resolves to the **most recent capture**
of that kind in the in-app gallery; an empty gallery answers
`failed("gallery.empty")` → "相册里还没有照片或视频。" (new `FAILURE_SPEECH`
entry).

### Frames to the relay

- Photos: one 640 px JPEG, base64 ≤ 200,000 chars — `camera.frame`'s exact
  size discipline.
- Videos: **8 evenly-spaced frames** via `AVAssetImageGenerator` (a 10-second
  clip and a 10-minute clip cost the same), each under the same per-frame
  cap. Silent video means frames are the whole signal — nothing is lost by
  not uploading audio that doesn't exist.
- New client event, one WebSocket message per frame:

```text
vision.frames { commandId, reason: "gallery", index, total, image, question? }
```

Validation caps: `total` ≤ 8, `index` < `total`, image ≤ 200,000 chars,
question ≤ 500 bytes. `commandId` is required when `reason` is
`"gallery"` and absent for `"watch"` (the same reason-conditional
validation shape `nav.request` uses). The relay assembles per commandId
with a 10 s assembly timeout; an incomplete set is discarded and — because
the ok result and the "我看看…" filler have already gone out — the relay
speaks "我看不清", the same sentence a null model answer produces, so the
rider is never left in silence after the filler. `reason` exists so M3 can
reuse the event; only `"gallery"` is valid until V-C.

### Ordering and truth

iOS sends all frames, then `device.result ok` — the result is truthful ("I
did my part") and the existing reconciliation speaks the filler "我看看…";
the description arrives seconds later through the provider's speech path,
exactly the `camera.look` sequencing. Extraction failure or timeout →
`failed("gallery.unreadable")` → "这段内容我处理不了。" Descriptions of a
null model answer speak "我看不清" as today.

### Privacy

Captures still never leave the device except: the frames of the one capture
the rider just asked about by voice, sent for description and discarded —
the same narrow exception the helmet camera's live look already carved. No
server-side storage, no caching (a scene is never the same twice; neither is
a gallery question), and frames never enter QA transcripts. The spec's
README capability bullet must state this exception in the same breath as the
feature.

## M3 — proactive scene watching

### Toggle and lifecycle

Off by default. "开启环境观察 / 关闭环境观察" →
`vision.watch { on }` device command (embedded-gated, low tier); also a
switch in the settings sheet. State dies with the session — reconnect starts
off. Max confirms honestly via the result path ("已开启环境观察。").

### Board side — sample cheap, ship rarely

Every 30 s while enabled, grab the frame the ADAS feed already produces and
run a grayscale-histogram distance against the last frame that was actually
_shipped_; below threshold → drop locally, zero network, zero model cost (a
highway that looks the same for ten minutes costs nothing). Above threshold →
one `vision.frames { reason: "watch", index: 0, total: 1, image }` (no
commandId — unsolicited). Threshold fixture-tested in V-C against
same-scene/new-scene frame pairs.

### Relay side — the governor

A pure module (`server/vision-governor.ts`), instantiated per session by the
voice provider, deciding for each candidate frame: **describe, or drop with
a reason**. Rules, in order:

1. Watching not enabled for this session → drop `disabled` (belt-and-braces
   against a stale board).
2. Hourly model-call cap: 40 per session → drop `budget`.
3. ADAS alert in the last 30 s → drop `adas-window` (hazards are ADAS's job,
   and it is already faster than a model round trip).
4. Max is speaking or the rider's turn is open → drop `speech` — dropped,
   never queued; a stale observation is worse than none.
5. Last spoken observation < 2 min ago → drop `cooldown`.

Survivors go to `describe(frames)` with the **watching prompt**: name one
notable non-hazard observation in one short sentence, or return an empty
string. Empty/null → silence (drop `nothing-notable` / `model-failure`).
Non-empty → spoken through the provider's speech path, timestamp recorded
for the cooldown. Every drop reason increments a metric so QA can watch the
governor work.

## Error handling

- Missing `ARK_API_KEY` → `MockVisionProvider`, one warning — never a broken
  feature.
- Rider-initiated paths (M1/M2): every failure is spoken and honest, and
  every `device.command` still resolves to exactly one `device.result`.
- Watching (M3): every failure is silent and metered. Unprompted apologies
  are noise.
- All Ark failures remain fail-null with `onFailure` reasons, as vision.ts
  established.

## Configuration

| Variable       | Consumer    | Notes                                  |
| -------------- | ----------- | -------------------------------------- |
| `ARK_API_KEY`  | vision core | absent → mock provider                 |
| `ARK_BASE_URL` | vision core | optional; default Ark Beijing endpoint |
| `ARK_MODEL`    | vision core | must be a vision-capable Doubao model  |

No new credentials. M3's constants (30 s, 40/hr, 2 min, 30 s ADAS window,
8-frame cap, 10 s assembly timeout) live in one tunable block like the crash
thresholds do.

## Verification

- **Vitest:** Ark provider against fixture responses (multi-image request
  shape, question threading, fixed-prompt fallback, null on every failure
  class); mock provider determinism; `selectVisionProvider` latch;
  `vision.frames` assembly (ordering, duplicate index, timeout, ceiling,
  oversize); the governor as a pure unit with a fake clock (each rule, each
  drop reason, cap reset).
- **Grammar tests:** vision-question and gallery/watch phrases, zh + en,
  near-miss negatives ("看一下相册" opens the gallery, doesn't describe).
- **XCTest:** key-frame extraction (≤8 frames, size cap, even spacing on a
  test asset); latest-capture resolution per kind; empty-gallery result.
- **RDK Python:** change-gate on fixture frame pairs; sampler start/stop with
  the toggle.
- **Golden demo:** all three milestones keylessly on mock providers.
- **Live-key smoke test** (when `ARK_API_KEY` arrives): describe a real
  photo and a real 8-frame set from the dev box — same drill as the Amap key.

## Acceptance criteria

- With no Ark key: 看看-questions, gallery questions, and 环境观察 all demo
  end-to-end on the mock providers, and tests cover every governor rule.
- With a key: the board answers the rider's actual question; iOS describes
  the latest photo and video by sampled frames; watching speaks at most one
  observation per 2 min, ≤ 40 model calls/hour, never during speech, never
  within 30 s of an ADAS alert.
- Every rider-initiated command resolves to exactly one truthful
  device.result; watching never speaks a failure.
- No capture or frame is stored server-side; the README documents the
  narrow voice-requested exception.

## Rollout

Three plans, in order, one per milestone — the Amap Plan A/B/C pattern:

- **V-A:** vision core + selection + M1 grammar/question threading + mock
  voice provider camera.look path.
- **V-B:** M2 — protocol event, iOS extraction/resolution, relay assembly,
  speech.
- **V-C:** M3 — board sampler + gate, governor, toggle, metrics.
