# Companion State Re-sync (Pairing Deadlock Fix)

## Summary

A relaunched iOS app does not know it is paired. `authoritativeCompanionState`
starts at `.signedOut` and is never persisted, while the relay still holds the
binding and the board has correctly gone quiet **because** it is paired. The
rider is left with a screen that says `尚未连接 RDK 头盔`, no helmet in the
discovery list, no six-digit code on the HUD, no `解除配对` button, and a
`开始 Helmet Ride` that silently does nothing.

This adds one behaviour: when the companion UI appears with an account session
and no information from the relay, the app opens a socket and lets the relay
tell it the truth.

## Context

The deadlock was hit repeatedly on 2026-08-12 — once per app install — and each
time the only escape was a deliberately **wrong** six-digit pairing code.

Every gate involved is individually correct:

- `authoritativeCompanionState` is not persisted (`MainViewModel.swift`), because
  the relay is the single source of truth for a binding.
- The board stops broadcasting mDNS discovery and stops displaying a pairing code
  once paired — correct, and deliberate.
- `showsUnpair` is gated on `paired`, so an app that believes it is unpaired
  offers no way to unpair.
- `canStartRide` refuses `.signedOut`, so Start no-ops.
- `canPair` allows `.signedOut`, so the pairing controls are live — but there is
  nothing to pair _to_: no beacon, no code.

Each rule is defensible. Together they form a closed loop with no exit.

**The exit already exists, by accident.** `attachCompanion`
(`server/companion-registry.ts`) calls `syncCompanion(session)` immediately on
attach, before handling any client event. So _any_ successful connect with a
valid account session causes the relay to push the authoritative binding.
`performPairHelmet` calls `connect()` **before** validating the code, which is
why a wrong code recovers the app: the pair is rejected, but the attach already
delivered the truth.

The fix is to reach that same path deliberately instead of by side effect.

## Design

### Trigger

When the companion UI appears, if `isLoggedIn` **and**
`authoritativeCompanionState == .signedOut`, connect.

`.signedOut` is the only state that cannot have come from the relay — it is the
app's "I have no information" value. Every other state was pushed by the relay
and is either correct or a failure the rider can already act on.

### What it does

`MainViewModel` gains one entry point, `syncCompanionStateIfNeeded()`, called
from the companion section's `.onAppear` in `AgentSettingsPanel.swift`. The view
decides _when_; the view model decides _whether_ — the guards live in the model
so they are testable without a view, matching how `startHelmetRide()` and
`pairHelmet()` are already structured.

It does exactly what `performPairHelmet` does minus the pairing: advance the
companion generation, bind the state observer, and `companionClient.connect(...)`.
No `companion.pair`, no `companion.pairDiscover`, no `companion.start`, and no
new protocol event.

### Why the socket does not linger

`closePairOnlySocketIfIdle` (`RDKCompanionClient.swift`) already closes a socket
that has no desired ride and no outstanding action once the transport reaches
`paired`. A sync connect satisfies all three conditions the moment the relay's
status lands, so the socket closes itself.

This is the existing pair-only socket lifecycle reached through a different
door. The companion socket stays ride-scoped; nothing about that changes.

### Deliberately out of scope

- **No `.failed` re-sync.** `.failed` means the relay _was_ heard and the
  transport broke. `开始 Helmet Ride` is already a working retry there. Re-syncing
  on every appearance would also let a rider bouncing in and out of settings
  reconnect repeatedly against a dead relay.
- **No persisted pairing state.** Caching the binding on the phone creates a
  second thing that can be wrong, and the failure it would mask is exactly the
  one being fixed. The relay remains the single source of truth.
- **No change to `performPairHelmet`'s connect-before-validate.** This fix removes
  the _need_ for the wrong-code trick; changing that ordering is unrelated risk.
- **No new UI.** The screen already has the right controls; they were merely
  reflecting a state the app had no business believing.

## Error handling and edge cases

- **Relay unreachable** — lands in `.failed(code: "connection")` →
  `RDK 头盔连接失败，请重试`, with `开始 Helmet Ride` enabled as a genuine retry.
- **Dead account session** — `.failed(code: "auth")` →
  `账号会话已失效，请重新登录`, which is the truthful instruction.
- **Not signed in** — no sync; `请先登录账号` already says the right thing.
- **Already paired / ready / sharing** — no sync; the state came from the relay.
- **Repeated appearances** — a sync must not stack sockets. The connect runs only
  from `.signedOut`, and `connect()` cancels any existing socket, so at most one
  is live.
- **Relay says unpaired** — the app lands in `.unpaired`, the board resumes
  broadcasting, and normal discovery pairing works. That is the correct outcome,
  not an error.
- **A ride or unpair transaction in flight** — the same guards
  `performPairHelmet` uses apply; the sync must never interrupt one.

## Testing

`ios/MaxHelmetTests/CompanionViewModelTests.swift`, using the existing `Harness`:

- signed in and `.signedOut`, `syncCompanionStateIfNeeded()` → exactly one `companion.connect:`
  event, and **no** `companion.pair` / `companion.pairDiscover` / `companion.start`
- a relay `paired` push after that connect → `showsUnpair` true and
  `isPrimaryActionEnabled` true (the deadlock's two dead controls come back)
- called in `.paired`, `.ready`, `.sharing`, or `.failed` → no connect
- not signed in → no connect
- called twice in a row → still one live socket, no stacking
- a failed sync → `.failed(code: "connection")`, with Start still enabled

`ios/MaxHelmetTests/CompanionSettingsTests.swift` already covers the presentation
mapping; no change needed there.

## Out of scope

- Anything on the relay or the board. This is an iOS-only change.
- The `pairHelmet()` connect-before-validate ordering.
- Persisting companion state across launches.
- Android, which has no companion pairing UI.
