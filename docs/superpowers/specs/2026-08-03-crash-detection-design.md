# Crash Detection & Emergency Escalation Design

## Summary

Give Max the ability to notice a crash and get help. During a hands-free
session, the iOS app watches the phone's IMU for the signature of a real
crash (a broad high-G pulse or a tumble, followed by stillness). When it sees
one, Max asks the rider "你还好吗？" through the alert-priority audio path. No
answer escalates in two independent channels: a full-screen local alarm with a
siren, large GPS coordinates, and a pre-filled emergency call button — and, in
parallel, a `crash.alert` to the relay, whose pluggable notifier texts the
rider's emergency contact with who/where/when. Max only claims "已通知紧急联系人"
after the notifier's real outcome comes back, the same truth-reconciliation
rule the device-action layer established.

Detection and every countdown run entirely on the phone: a crash and a dead
network correlate, so the network is never on the decision path — it is only a
delivery channel with retry.

## Scope

### Goals

- A pure, trace-testable `CrashEngine` state machine on iOS:
  `armed → impactCandidate → checkIn → alarm → escalated`.
- Two-stage detection (spike/tumble, then post-impact confirmation) with all
  thresholds in one tunable struct.
- Check-in speech and siren through the existing alert-priority path that
  already interrupts agent speech for ADAS hazards.
- A full-screen alarm UI whose lifetime is decoupled from the session.
- `crash.alert` / `crash.ack` / `crash.cancel` protocol events in the shared
  JSON Schema, generated into TS/Kotlin/Swift like every other event.
- A relay-side `CrashNotifier` interface: log-only mock by default, real SMS
  provider behind env config. Full incident logging into QA storage.
- Emergency-contact picker plus an explicit opt-in toggle for relay
  escalation in settings.
- A mock 事故 scenario so all clients rehearse the full flow without hardware
  or anyone crashing a motorcycle.
- A log-only detector mode to harvest real-ride traces before escalation is
  armed for real.

### Non-goals

- Android and web implementations. Both gain the generated event names;
  neither gains a detector. They must ignore the new events without erroring.
- Background / screen-off detection. The detector is armed only during the
  foreground hands-free session, the same premise as turn-by-turn guidance.
- Automatic call placement. iOS does not allow it; the call button needs a
  human tap and the design says so honestly.
- A voice-call notifier, ML-based detection, or board (RDK) involvement.
  All are future work; the notifier interface and the pure engine leave room.
- Choosing a production SMS provider. The interface ships with the mock; the
  provider account is an ops decision taken when credentials exist.

## Honest limits

- **Voice cancel needs the network.** ASR is server-side (Doubao), so "我没事"
  by voice works only while connected. Tap is the primary cancel; voice is an
  enhancement. The check-in banner and alarm screen both carry giant tap
  targets.
- **The phone cannot place the call itself.** Escalation that works while the
  rider is unconscious is the relay SMS path, which needs network and an
  opted-in contact. The local alarm covers the conscious-rider and bystander
  cases. Both together cover the realistic cases; neither alone does.
- **The contact number leaves the device exactly once** — inside an actual
  `crash.alert`, and only when the settings opt-in is on. This is the one
  documented carve-out to the "contact numbers never leave the device" rule.

## Architecture

### iOS — new `ios/MaxHelmet/Crash/` module

- **`CrashEngine.swift`** — pure state machine in the `GuidanceEngine` mold:
  no CoreMotion, no timers, no I/O. Consumes IMU samples (acceleration
  magnitude, rotation rate), speed, monotonic clock ticks, and rider
  responses. Emits state transitions and commands (speak check-in, start
  siren, show alarm, send `crash.alert`). All constants in one `CrashTuning`
  struct, mirroring the ADAS tuning dataclass.
- **`MotionFeed.swift`** — thin CoreMotion adapter streaming accelerometer +
  gyro at ~100 Hz, only while a session is live.
- **`CrashController.swift`** — the glue. Owns the engine, arms it on session
  start, drives the alert-priority audio path, presents the alarm UI, sends
  and retries the escalation events, reconciles `crash.ack` into truthful
  speech.
- **`CrashAlarmView.swift`** — full-screen alarm: countdown, siren, GPS
  coordinates rendered large enough for a bystander to read to 120, giant
  我没事 cancel, and the pre-filled call button reusing `CallDialer`.

### Protocol — `protocol/agent-events.schema.json`

- `crash.alert` (client → server): location, recent speed summary, contact
  number + opt-in flag, incident timestamps.
- `crash.ack` (server → client): the notifier's real outcome, per incident.
- `crash.cancel` (client → server): post-escalation cancel; triggers a
  follow-up "误报，我没事" SMS.

### Server — `server/crash-escalation.ts`

Receives `crash.alert`, invokes the configured `CrashNotifier`
(`logNotifier` default; `smsNotifier` activated by env config), answers with
a truthful `crash.ack`, and logs the incident into QA/transcript storage.

### Settings

Emergency-contact picker via `ContactResolver`; a choice of call-button
target (contact or 120); the relay-escalation opt-in toggle, off by default.

## Detection logic

All numbers are v1 starting points in `CrashTuning`, to be tuned from
recorded traces.

- **`armed`** — on session start. The engine keeps a rolling 5 s buffer of
  samples and speed so every incident carries pre-context.
- **`armed → impactCandidate`** — either signal promotes:
  - Impact: acceleration magnitude > **4.5 g** sustained ≥ **20 ms** (a crash
    is a broad pulse; a pothole or phone tap is a narrow one).
  - Tumble: rotation rate > **6 rad/s** for ≥ **100 ms**.
  - Speed gates sensitivity, not the trigger: above **10 km/h** recent speed
    either signal alone promotes; below it, both are required together. A
    dropped phone at a standstill never reaches check-in; a low-speed fall
    still can.
- **`impactCandidate → checkIn`** — a **5 s** confirmation window looks for
  what a crash leaves behind: stillness (speed < 2 km/h, low acceleration
  variance) or continued anomaly. Normal riding resumes → silently back to
  `armed`.
- **`checkIn`** — **15 s**. Max asks "你还好吗？" via the alert-priority path.
  Cancel by tap on the banner, or voice while connected. Cancel → `armed`;
  the incident is logged as a near-miss for tuning.
- **`checkIn → alarm`** — **30 s**. Full-screen `CrashAlarmView`, siren at
  maximum, visible countdown. Cancel still ends everything.
- **`alarm → escalated`** — countdown expires; one `crash.alert` with
  retry/backoff. The engine latches: one incident at a time, re-arm only
  after explicit cancel or app restart.

Impact-to-escalation is ~50 s — deliberately more conservative than Apple's
~20 s, because a false SMS to a family member is expensive. Both windows are
tuning constants.

## Error handling

- **Network down at escalation:** `crash.alert` queues with exponential
  backoff and survives reconnect (reusing the delivery-ID exactly-once
  machinery). The local alarm never waits on the network.
- **No ack:** after 10 s without `crash.ack`, the alarm screen shows
  "服务器未确认 — 请手动拨打".
- **Notifier failure / unconfigured:** `crash.ack` says so and Max speaks the
  truth, exactly as failed device actions do.
- **False positive after escalation:** cancel sends `crash.cancel`; the relay
  sends the follow-up SMS.
- **Session death mid-incident:** the alarm UI's lifetime is decoupled from
  `AgentSession`; it keeps running.

## Testing

- **`CrashEngineTests`** — literal IMU traces through the pure engine:
  synthetic crash pulses, pothole spikes, phone-drop at standstill, hard
  braking, tumble-only, low-speed fall. Each asserts the exact state
  sequence, `GuidanceEngineTests`-style.
- **Mock 事故 scenario** — `server/providers/mock.ts` injects a simulated
  crash so every client rehearses the full UX without hardware. Also the
  demo path.
- **Relay tests** — notifier plumbing, ack truthfulness, queue-and-retry,
  `crash.cancel` follow-up.
- **Contract drift test** — generated Swift/Kotlin/TS types for the new
  events, like existing events.
- **Human bench protocol** — phone in pocket + couch drop; shake test; then a
  real ride with the detector in log-only mode to harvest false-positive
  traces before escalation is armed. Log-only mode is a settings toggle in
  the developer panel.
