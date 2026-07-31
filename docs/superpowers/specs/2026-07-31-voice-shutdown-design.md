# Voice shutdown for the helmet — "Max，关机"

2026-07-31. Motivated by the crash record: every abrupt power cut this week
cost something (dirty FAT mounts, orphaned recordings, a wedged ISP), and the
only clean path was SSH. The rider needs one that works from inside the
helmet.

## Behavior

- "Max，关机" (or "shut down" / "power off" in English) schedules a clean
  poweroff **10 seconds later** on the board and answers immediately.
- The board plays locally generated tones through the ordinary playback path:
  a triple beep when armed, a short tick every 2 s, a long low tone just
  before executing. The tones are the ground-truth signal — they need no TTS
  credentials and cannot be faked by model chatter.
- "取消关机" (also 别关机 / 不要关机 / "cancel the shutdown") within the
  window cancels it, with a rising double beep as acknowledgement.
- Execution is `shutdown -h now`: systemd stops both services, max-vision
  finalizes any live recording with a finished manifest, filesystems unmount.
  The README's "wait ~15 s before cutting power" advice still applies.

## Decisions

**Confirmation is the countdown, not a spoken question.** A relay-side
"确定吗?" depends on the rider hearing a deterministic line, and the embedded
platform cannot speak those until `DOUBAO_TTS_*` lands on the relay — the
model's chatter would carry the question, which is exactly the lying-narrator
failure just fixed for 拍视频. A 10 s cancellable window with unmistakable
local tones is enforceable with today's hardware: wake word + a strict
grammar arms it, and any stray arm is cancellable and audible.

**Embedded-only at the relay.** `system.shutdown` joins
`PLATFORM_RESTRICTED_ACTIONS` beside `camera.look`: phones must never receive
it (they cannot poweroff, and older app builds would time out on an unknown
action). Risk tier is `high`, satisfied on the board by the countdown+cancel
window the way iOS satisfies it with native confirm dialogs.

**A negated 关机 is a command, not noise.** The extractor discards any
utterance matching NEGATION, which is right for "别拍照" but wrong here:
"别关机" during a countdown is the rider cancelling. The cancel pattern is
checked before the negation discard, as a documented exception.

**Grammar stays narrow.** 关机 must not be preceded by 手/机 ("我手机关机了"
is about the rider's phone), and English shut down / power off must not
capture "power off the flashlight" (torch grammar owns that). Tier-guarded by
tests.

## Components

- `server/device-actions.ts` — action type + tier + platform restriction,
  cancel-then-shutdown matching, speech lines ("好的，10秒后关机…" /
  "已取消关机。" / failure "现在没有要关机。"), action label.
- `server/providers/doubao.ts` — grounding prompt gains 关机 so the model
  cooperates instead of refusing or inventing.
- `rdk/agent/src/audio/cues.ts` — deterministic 24 kHz PCM16 tone synthesis
  (armed / tick / final / cancelled), written through `playback.write` in the
  same 20 ms chunks the relay uses, keeping the AEC reference honest.
- `rdk/agent/src/device/poweroff.ts` — the countdown controller: `schedule()`
  → "scheduled" | "already", `cancel()` → boolean; injected timers and exec
  for tests; all timers cleared on cancel.
- `rdk/agent/src/device/dispatch.ts` + `capabilities.ts` + `main.ts` — wire
  `system.shutdown` to the controller; exec spawns `/usr/sbin/shutdown -h now`.

## Error handling

- Cancel with nothing pending → `failed` / `shutdown.notPending`, spoken as
  "现在没有要关机。"
- Schedule while already counting down → ok ("already"); the countdown is not
  extended.
- The dispatcher answers the relay immediately in both directions — nothing
  waits out the 10 s inside the 8 s device-result timeout.

## Testing

Grammar (phrasings, negation-as-cancel, phone false-positive, torch guard,
platform gate), speech lines, controller timing with injected timers
(executes at 10 s, cancel stops everything, tick cadence), cue PCM shape
(rate, chunking, non-silence), dispatch wiring. Live acceptance is the
rider's own voice: arm, hear ticks, cancel; arm and let it power down.
