# RDK Fail-Loud Reliability — Design

## Summary

The embedded client's hard problems are solved — AEC, barge-in, ADAS on the
BPU — but the layer around them fails silently, which is the one trait a helmet
appliance cannot afford. A dead `max-aec` leaves the agent holding a live relay
session with a dead microphone, forever, logging nothing. A dead `mipi_cam`
leaves a frozen preview, a recorder appending the same stale JPEG at 10 fps,
and an ADAS thread blocked without a word. A missing config value restarts the
service five times in ten seconds and then systemd gives up permanently. A
black-holed WebSocket keeps `ready === true` for the rest of the ride.

This design applies one rule everywhere: **a component that can no longer do
its job says why in one journal line, then either recovers by an
already-designed path or exits and lets systemd bring it back.** No new
supervision framework. `Gallery.reconcile()`, `reap_orphans()` and
`Restart=always` are the recovery machinery this codebase already trusts; the
work is making failures actually reach them.

The board's crash-loop (see `rdk/README.md`, "The board dies hard") is
explicitly _not_ fixed here — the evidence points at power, and only a bench
test with a power meter can confirm that. This design makes the board survive
and report such a death; it cannot prevent one.

## Scope

### Goals

- No silent failure modes in the audio path, the relay link, or the camera
  path: every failure is journaled with its concrete reason.
- Recovery without human intervention wherever an automatic path exists:
  process restart, child respawn, or watchdog reboot.
- A service that cannot start keeps saying so — it never enters systemd's
  permanent `failed` state.
- The hazard alert priority lock protects the audible alert, not just its
  enqueue.

### Non-goals

- Security hardening (`User=`, sandboxing, gating `/preview`) — separate track.
- A versioned board deploy pipeline or CI for the embedded surface.
- HUD memory growth, uplink/reference backpressure, the WAV chunk parser.
- The `MAX_AEC_DELAY_MS` 25-vs-80 question.
- Anything inside the ADAS pipeline (tracker, TTC, shadow-record versioning) —
  that is the next track's spec.
- The crash-loop root cause. That is a bench task for a human with a power
  meter, run during a live voice session.

## Agent (`rdk/agent`)

### Capture child death is fatal, loudly

`createCapture` (`src/audio/capture.ts`) registers `exit` and `error` handlers
on the spawned child. `ChildProcessLike` grows the real signatures:
`on("exit", (code, signal) => void)` and `on("error", (error) => void)`.

An unexpected exit or spawn error of `max-aec`/`arecord` logs one line with the
code/signal (`[capture] max-aec exited code=1 signal=null`) and exits the
process with status 1. systemd restarts it 2 s later.

Why not respawn in place: a respawned `max-aec` means reasoning about fd-3
reference continuity, APM adaptation state, and half-open pipes — the exact
partially-alive states this design exists to eliminate. A full restart
re-converges AEC in seconds (measured; see README "In-process AEC") and is the
path every reboot already exercises. `stop()` marks the kill intentional so
shutdown does not trip the handler.

### Playback child death self-heals

`aplay` dying is routine — every barge-in `flush()` SIGKILLs it and `ensure()`
respawns on the next write. The failure mode is a child that dies _uninvited_
while still referenced: `child` stays non-null, every write lands on a dead
pipe through the swallowing `error` handler, and playback is silent forever.

Fix, in `src/audio/playback.ts`: on an exit that was not caused by `flush()`
or `stop()`, log it and null the reference; the next `write()` respawns via
the existing `ensure()`. No new respawn machinery. Intentional kills are
flagged the same way as in capture.

Additionally `pump()` no longer calls `ensure()` when the queue is empty, so a
timer still pending after `flush()` cannot respawn an idle `aplay` that then
sits holding the ALSA device.

### Process-level nets

`main.ts` registers `uncaughtException` and `unhandledRejection` handlers that
log the stack and exit 1. Today either one kills the agent with no journal
explanation at all.

### Relay liveness and diagnosable closes

In `createRelayClient` (`src/relay.ts`):

- A liveness timer pings every 15 s. A ping that has not been answered by the
  next tick calls `socket.terminate()`, which fires the existing `close` path
  and its backoff. A bike that rides out of coverage now reconnects within
  ~30 s of coverage returning instead of never.
- Every `close` logs its code and reason; every `error` logs its message. A
  401 from a missing `MAX_RELAY_TOKEN` — the failure the README documents as
  "reconnects in a loop with no explanation" — becomes distinguishable from a
  Wi-Fi drop in one journal read.
- `open()` refuses to run when a socket is already open or connecting (logged),
  closing the reconnect race that leaks a WebSocket whose later close schedules
  a second reconnect loop.

In `main.ts`, `onClosed` passes the real voice-gate state to
`decideReconnect` instead of the literal `false` at `main.ts:173`. The
`"now"`-on-gate-open branch — the one branch with a dedicated test — becomes
reachable: an idle close that lands while the rider is mid-sentence reconnects
immediately instead of waiting 400 ms for the gate to re-arm.

### Alert priority covers the audible alert

`playback` gains a deferred release: `releasePriority()` called while alert
audio is still queued or playing computes when that audio finishes — the drain
point of everything already handed to `aplay` plus everything still queued at
that moment — and schedules the actual release for then. Audio the relay
queues _after_ the release request does not extend the hold, so a barge-in
against Max's ordinary speech right after an alert is not refused. A `status: hearing` or
`hazard.alert.interrupt` flush arriving mid-alert is refused for the alert's
whole audible duration, which is what `alert-player.ts`'s header already
claims.

The value `play()` returns is renamed to what it measures — time to handover —
so it can never again be read as time-to-audible in M2 arming evidence.
`hazard.ts`'s report field follows.

### Watchdog heartbeat

Every 10 s, if a mic frame arrived within the last 10 s, the agent sends
`WATCHDOG=1` by spawning `systemd-notify`. Mic frames flow continuously while
the capture chain is healthy (the gate reads them even when closed), so
"frames arriving" attests the whole input path — device, child process, pipe,
framer — not merely that the event loop spins. No frames, no heartbeat, and
systemd restarts the service after `WatchdogSec`.

Heartbeating is skipped entirely when `NOTIFY_SOCKET` is unset, so running the
agent by hand on the bench behaves exactly as today. Node cannot send unix
datagrams natively, hence `systemd-notify` (one short-lived process per 10 s,
negligible); `NotifyAccess=all` in the unit accepts it.

## Vision sidecar (`rdk/vision`)

### Frame-age monitor: freeze detector and heartbeat in one thread

`FrameBuffer.put()` stamps a monotonic `received_at`. One daemon thread wakes
every 10 s and checks each camera that is nominally open:

- All fresh (newest frame under 5 s old): send `WATCHDOG=1` via a ~10-line
  stdlib `sd_notify` helper (unix datagram, handles the abstract-namespace `@`
  prefix; no-op when `NOTIFY_SOCKET` is unset).
- Any stale: log which camera froze and how old its newest frame is, then exit
  1. systemd restarts the service; `reap_orphans()` clears the dead
     `mipi_cam`, `Gallery.reconcile()` finalises an interrupted recording — both
     already verified on the board ("max-vision restart reacquires").

A process wedged hard enough to stop the monitor thread stops heartbeating,
and the systemd watchdog catches what the monitor cannot. A camera that never
opened is not checked — front-only rides stay legitimate.

### Recording writer survives disk errors

The per-side write in `write_recording_frame` (`camera.py`) catches `OSError`,
logs the errno and path, and calls `stop_recording()` so the manifest
finalises with the frames already on disk. Today the exception kills the
writer thread, `recording_id` stays set, and the manifest stays
`"recording": true` until the next restart's reconcile. A truncated final JPEG
in the `.mjpeg` is acceptable: readers scan for SOI markers and the corpus
tolerates a torn tail the same way `recorder/metadata.py` already tolerates a
torn final JSONL line.

### Reap once per acquisition, not once per camera

`reap_orphans()` moves out of `MipiCamera.start()` to the top of
`CameraPair.open()` — once per acquisition cycle, before the first open. This
fixes dual-camera startup destroying itself (the rear camera's `start()`
currently SIGKILLs the front camera's just-started `mipi_cam`, since both hold
`/dev/vs-isp0_cap`) while preserving crash recovery, which only ever needed
the reap to happen before the _first_ open. `tools/record_ride.py`'s
independent path keeps the same once-before-open behavior.

### Control-socket writes are serialized

The per-connection `write()` in `service.py`'s `ControlHandler` takes a
`threading.Lock`. It is called from the connection thread (RPC responses) and
from every ADAS thread (`EventBus.broadcast` hazard events); unsynchronised,
the two interleave bytes mid-line and hand the agent malformed JSON on a
channel whose contract is one message per line.

### Clean stop finalises a live recording

The shutdown path in `service.py` calls `stop_recording()` if a recording is
active — an ordinary `systemctl stop` produces a finished manifest instead of
relying on next-boot reconcile — and unlinks the control socket on the way
out.

## systemd and the hardware watchdog

Both units (`rdk/systemd/*.service`) gain:

| Directive                 | Why                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `StartLimitIntervalSec=0` | Five fast failures currently put the unit in permanent `failed` — the helmet goes silent until an SSH. A broken unit should restart visibly forever instead. |
| `WatchdogSec=30`          | A wedged-but-alive process is currently indistinguishable from a healthy one.                                                                                |
| `NotifyAccess=all`        | Heartbeats arrive from `systemd-notify` children (agent) and a thread (vision).                                                                              |
| `TimeoutStopSec=10`       | A hung stop must not block a restart indefinitely.                                                                                                           |

A new `rdk/systemd/10-max-watchdog.conf`, installed to
`/etc/systemd/system.conf.d/`, sets `RuntimeWatchdogSec=30`: PID 1 pets
`/dev/watchdog` (the idle `dw_wdt`), so a kernel-level hang hard-reboots the
board instead of hanging forever. The README's provisioning section documents
installing it.

Bench note for the README: stopping or restarting services normally never
trips any watchdog; `RuntimeWatchdogSec` fires only when PID 1 itself stops
running, and `WatchdogSec` only when a _running_ service stops heartbeating.
Debugging a stopped service is unaffected.

## Error handling summary

| Failure                              | Detection                 | Outcome                                                           |
| ------------------------------------ | ------------------------- | ----------------------------------------------------------------- |
| `max-aec`/`arecord` dies             | child `exit`/`error`      | one journal line; agent exits; systemd restarts; AEC re-converges |
| `aplay` dies uninvited               | child `exit`              | one journal line; respawned on next write                         |
| Uncaught exception/rejection         | process handlers          | stack in journal; exit 1; restart                                 |
| Relay socket black-holed             | ping unanswered 15–30 s   | terminate → existing backoff reconnect                            |
| Relay refuses/drops connection       | `close`/`error` logging   | journal shows code/reason — 401 ≠ Wi-Fi drop                      |
| Camera frames freeze                 | frame-age monitor         | one journal line; sidecar exits; restart reacquires camera        |
| Disk error mid-recording             | `OSError` in writer       | recording stops cleanly; manifest finalised with frames on disk   |
| Agent/vision wedged but alive        | missed `WATCHDOG=1`       | systemd restarts after 30 s                                       |
| Kernel/PID 1 hang                    | `RuntimeWatchdogSec`      | hardware watchdog reboots the board                               |
| Bad config / missing binary at start | `StartLimitIntervalSec=0` | visible 2 s restart loop in the journal, never permanent `failed` |
| Power loss                           | out of scope              | already survivable: `reconcile()` keeps the interrupted clip      |

## Verification

### Automated — vitest (dev machine)

- Capture: fake child emits `exit`/`error` → fatal callback fires with the
  logged reason; intentional `stop()` does not.
- Playback: uninvited fake-child exit → next write respawns; `flush()`-killed
  child does not double-log; empty-queue pump does not respawn `aplay`.
- Relay: injectable WebSocket factory; fake timers drive ping-timeout →
  `terminate` → reconnect path; close codes and error messages logged;
  `connect()` while open is a no-op.
- Alert priority: with the fake clock, `releasePriority()` mid-drain defers
  until the alert's computed end; a `flush()` inside that window is refused;
  release completes after; audio queued after the release request does not
  extend the hold.
- `decideReconnect` receives the live gate state (wiring test).

### Automated — pytest (on the board, as today)

- Frame-age monitor decision function with an injected clock: fresh → notify,
  stale → exit decision, unopened cameras ignored.
- Writer `OSError` → `stop_recording` called, manifest finalised, thread ends
  cleanly.
- Reap-once: `CameraPair.open()` with two fake cameras reaps exactly once,
  before the first `start()` (existing fake-holders seam).
- Two threads writing through one `ControlHandler.write` produce intact,
  parseable lines.
- `sd_notify` helper: datagram bytes and abstract-socket `@` handling, no
  systemd required; no-op without `NOTIFY_SOCKET`.

### Manual — on the board

1. `kill -9` the `max-aec` child mid-conversation → one loud journal line, the
   agent restarts, the session recovers in under 10 s.
2. `SIGSTOP` the agent process → systemd watchdog restarts it within ~60 s;
   repeat for the vision sidecar.
3. `kill -9` the `mipi_cam` process → the sidecar logs the frozen camera,
   exits, restarts, and preview is live again without human help.
4. Kill the hotspot mid-session → `[relay]` liveness timeout logged within
   ~30 s, backoff begins; restore the network → session reconnects.
5. A live conversation with barge-in passes — the standing AEC regression bar:
   Max replies once and stops; talking over him cuts the reply.
6. Trigger a hazard alert, then a `status: hearing` mid-alert → the alert
   plays to completion, and the flush is honoured only after it ends.

## Acceptance criteria

- Every failure in the error-handling table produces exactly the documented
  outcome, with its journal line.
- No failure mode in that table leaves a service running-but-useless or
  permanently `failed`.
- The full vitest suite and the board pytest suite pass.
- Manual checks 1–6 pass on the physical board.
