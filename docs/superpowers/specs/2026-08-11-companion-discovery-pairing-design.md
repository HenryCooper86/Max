# Companion Discovery Pairing (Zero-Typing Pair Flow)

## Summary

Replace "read a code off a screen you don't have" with radio discovery plus a
spoken confirmation. An unpaired helmet broadcasts a rotating, secret-free
_discovery token_ over mDNS and BLE. The signed-in Max app scans, shows
附近的头盔, and on a tap asks the relay to pair with that token. The relay makes
the helmet ask aloud 检测到配对请求，请说"确认"; the rider's spoken 确认 at the
helmet microphone completes the binding through the existing companion bind
path. Possession is proven by voice at the helmet, not by reading a bench HUD.

The existing six-digit pairing-code flow is untouched and remains the fallback
(bench work, noisy environments, radios unavailable). Nothing changes on the
board's hardened HTTP surfaces, and the relay remains the only trust anchor:
the radios carry no secret, no stable identifier, and make no decisions.

## Context

Today the pairing code is deliberately visible only from the board itself — the
HDMI kiosk or an SSH local forward to `127.0.0.1:8080` — because HUD redaction
keys off the peer address (`remoteHudSnapshot` in `rdk/agent/src/hud/server.ts`).
That is a developer posture: a real rider has no monitor and no SSH client. The
2026-08-09 companion spec calls the code "bootstrap proof, not authentication" —
its job is to prove physical access to the helmet. This design keeps that bar
(and arguably raises it) while removing every developer-shaped step.

Machinery this design reuses rather than builds:

- `server/companion-registry.ts`: code lifecycle, reuse-across-reconnect
  semantics (the 2026-08-10 fixes), single-use binding, displacement
  notifications, per-account and per-address rate limits, `pair.helmetOffline`.
- Relay-composed speech to the helmet: `speakNavLine` / transcript deliveries
  (one fresh `createTranscriptDelivery` per spoken line, as pinned by
  `tests/doubao-nav-speech.test.ts`).
- The embedded utterance grammar in `server/device-actions.ts`
  (开启环境观察-style regex matching over rider transcripts).
- The generated protocol (`shared/generated/agent-protocol.ts` and its Swift
  and Kotlin mirrors) so all platforms stay in lockstep.

Board hardware verified 2026-08-11 on the X5: `hci0` is UP with bluetoothd
running, so BLE advertising is available; Wi-Fi is managed-mode; avahi is
installed but inactive and stays that way (we do not adopt system avahi).

## Pairing flow

1. **Token issue.** When a helmet with no persisted binding connects to
   `/agent`, the relay issues a discovery token: 16 random bytes, hex-encoded,
   five-minute lifetime, delivered in a new `companion.discovery` agent event.
   The pairing-code reuse rule applies identically: an unpaired helmet
   reconnecting inside the window receives the _same_ token, so relay-socket
   flapping (the known no-pong churn) does not churn the beacon. Unlike pairing
   codes, discovery tokens are refreshed proactively: the relay pushes a fresh
   token one minute before expiry while the helmet stays connected and
   unpaired, because a beacon must never broadcast a dead token. The token's
   canonical form in protocol messages and mDNS TXT is the 32-character hex
   string; the BLE advertisement carries the 16 raw bytes (a hex string does
   not fit a legacy advertisement's service-data budget). A paired helmet gets
   `companion.discovery { token: null }` and goes radio-silent. Unpairing
   (existing `markHelmetUnpaired` path) issues a fresh token alongside the
   fresh pairing code.
2. **Broadcast.** The board advertises the current token on two transports:
   an mDNS service (`_maxhelmet._tcp`, TXT `dt=<token>`, `v=1`) and a BLE
   legacy advertisement carrying the token as service data under the project's
   service UUID. Broadcast only — no GATT server, no listener behind the mDNS
   port. Token null tears both down.
3. **Scan and tap.** The app, on the pairing screen only, scans Bonjour and
   BLE, merges and dedupes results by token, and lists 附近的头盔. Tapping
   Pair sends `companion.pairDiscover { token }` over the authenticated
   `/companion` socket.
4. **Voice confirm.** The relay validates the token (known, unexpired, helmet
   currently connected — otherwise the existing `pair.helmetOffline` shape),
   takes the device's single pending-confirm slot for this account, and speaks
   through the helmet: 检测到配对请求，请说"确认"。 The rider's next matching
   utterance resolves it: 确认 accepts, 取消 declines, 30 seconds of neither
   times out.
5. **Bind.** Acceptance runs the exact existing bind path: persistent store
   write, displacement notification to any displaced phone, `companion.status
ready` to the pairing phone, `companion.pairing { paired: true }` to the
   helmet, a spoken 已配对。, and `companion.discovery { token: null }` to stop
   the beacon. Decline and timeout send `pair.declined` / `pair.timeout` to the
   phone, speak nothing further, and leave the beacon up.
6. **Fallback.** The six-digit code flow is byte-for-byte untouched. The bench
   HUD, SSH-forward route, and code redaction rules all stay as shipped.

## Protocol additions

All three additions go through the generated protocol so Swift and Kotlin
mirrors regenerate together:

- Agent event `companion.discovery { token: string | null, expiresAt?: number }`
  — `expiresAt` present exactly when `token` is non-null.
- Companion client message `companion.pairDiscover { token: string }`.
- New `companion.error` codes: `pair.busy` (another account's confirm is
  pending on that helmet), `pair.declined`, `pair.timeout`. Invalid or expired
  tokens reuse the existing `pair.code` error; offline helmets reuse
  `pair.helmetOffline`. `companion.pairDiscover` shares the existing pairing
  attempt rate limits (per account and per network address).

## Relay design (`server/companion-registry.ts` + session wiring)

The registry owns the entire state machine and stays speech-ignorant:

- **Token table** mirroring the pair-code table: `discoveryTokens` keyed by
  token with `{ deviceId, helmet, expiresAt }`, a per-device index, expiry
  sweep, reuse-when-unexpired on unpaired reconnect, rotation timer for the
  pre-expiry refresh (injected `setTimer`, as the stale-timer already does).
- **Confirm slot**: at most one pending confirm per device,
  `{ accountId, expiresAt }`, 30-second lifetime on the injected clock. A
  `pairDiscover` from a _different_ account while occupied answers
  `pair.busy` — a spoken 确认 cannot disambiguate two candidates, so two are
  never allowed. A re-tap from the _same_ account is idempotent: the slot and
  its deadline are unchanged and the helmet re-speaks the prompt. The slot
  clears on resolve, timeout, helmet detach, or phone disconnect.
- **Narrow session-layer interface.** The session layer provides
  `speakLine(deviceId, text)` (relay speech via a fresh transcript delivery
  per line) as a registry option, and calls
  `registry.resolveConfirm(deviceId, accepted)` when the embedded grammar
  matches 确认 / 取消 on a rider transcript while that device has a pending
  confirm. The grammar additions live in `server/device-actions.ts` beside the
  环境观察 patterns and match only when a confirm is pending, so bare 确认 in
  normal conversation never reaches the registry.

Helmet detach while a confirm is pending resolves it as declined with
`pair.helmetOffline` to the phone. Tokens are never logged raw — they are
public on the air, but log discipline treats them like codes.

## Board design (`rdk/agent/src/discovery/`)

A small advertiser module driven only by `companion.discovery` events:

- `advertiser.ts` — owns lifecycle: token present → ensure both transports
  advertise it; token null, relay connection lost, or SIGTERM → tear down.
  Teardown follows the recent rdk-vision convention: from wherever a stop
  interrupts startup.
- `mdns.ts` — pure-JS `multicast-dns` responder answering `_maxhelmet._tcp`
  queries with a TXT record (`dt`, `v`). No avahi, no system configuration.
  The advertised port is the HUD port but nothing pairing-related listens
  there; the TXT record is the entire payload.
- `ble.ts` — bluez advertising object registered over D-Bus (`dbus-next`)
  with `LEAdvertisingManager1`. Broadcast-only peripheral; no GATT services.

A transport that fails to start (Bluetooth off, D-Bus error, socket failure)
logs loudly and the other transport carries on. The HUD state gains a
non-secret `discovery` field (`"mdns+ble" | "mdns" | "ble" | "off"`) shown as a
status line; the token itself is not displayed anywhere (it adds nothing) but
needs no redaction if surfaced in future — it is broadcast by design.

## iOS design

- `Companion/Discovery/`: a `HelmetDiscovery` interface published as a deduped
  list of `{ token, transport }`, with `BonjourHelmetDiscovery` (`NWBrowser`
  over `_maxhelmet._tcp`, TXT parse) and `BleHelmetDiscovery`
  (`CBCentralManager` scanning for the service UUID, service-data parse).
  Scanning starts when the pairing screen appears and stops when it
  disappears; there is no background radio use.
- `AgentSettingsPanel` pairing section: a 附近的头盔 list with a Pair button
  per discovered helmet, a 等待头盔确认… state while the confirm is pending,
  and the existing code field demoted below as 手动输入配对码. New error codes
  map to user-readable strings (对方已取消 / 确认超时 / 头盔正忙).
- `RDKCompanionClient`: sends `companion.pairDiscover`, handles the three new
  error codes; the ready/displacement handling is unchanged.
- Info.plist: `NSBonjourServices` (`_maxhelmet._tcp`),
  `NSLocalNetworkUsageDescription`, `NSBluetoothAlwaysUsageDescription`.

## Security and privacy

- The beacon carries a rotating random token and nothing else: no device ID,
  no serial, no stable name. Paired helmets are radio-silent. A parked helmet
  cannot be tracked across sessions by its beacon.
- Knowing the token grants an _authenticated, rate-limited_ account exactly one
  ability: triggering a confirm prompt on a helmet within earshot. The binding
  requires the rider's voice at the helmet microphone — a stronger possession
  proof than reading the bench screen, and identical in kind to the spec's
  original "physical access" bar.
- The confirm prompt names nothing sensitive; the pending slot is
  single-occupancy; decline and timeout are safe defaults.
- No new board HTTP surface, no change to `MAX_VISION_TOKEN` gating, HUD
  redaction, or the loopback-only code display.
- Discovery tokens follow pairing-code log discipline: never logged raw by
  relay or board.

## Error handling and edge cases

| Case                                               | Behavior                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Two phones tap the same helmet                     | First holds the confirm slot; second gets `pair.busy`.                                          |
| Helmet detaches mid-confirm                        | Slot cleared; phone gets `pair.helmetOffline`.                                                  |
| Rider says 取消 / says nothing for 30 s            | `pair.declined` / `pair.timeout`; beacon stays up; rider can re-tap.                            |
| Token expires between scan and tap                 | `pair.code` error; app rescans (fresh token is already on the air from the pre-expiry refresh). |
| Relay socket flaps mid-window                      | Same token re-issued (reuse rule); beacon stable.                                               |
| Bluetooth dead on board                            | mDNS carries on; HUD shows `discovery: mdns`; loud log.                                         |
| Phone and helmet on different networks with BT off | Discovery finds nothing; manual code fallback.                                                  |
| Paired helmet                                      | No token, no beacon, `pairDiscover` for any stale token fails as `pair.code`.                   |

## Testing

- **Relay unit** (`tests/companion-registry.test.ts` pattern): token issue,
  reuse-across-reconnect, pre-expiry rotation, expiry sweep, happy-path
  discover→confirm→bind, busy, offline, decline, timeout, detach-mid-confirm,
  displacement on discovery pairing, rate limiting, and grammar gating (确认
  with no pending confirm does nothing).
- **Protocol**: generated-protocol tests on web, iOS, Android stay green after
  regeneration.
- **Board unit**: advertiser lifecycle against fake transports — start, token
  rotation, null teardown, relay-loss teardown, SIGTERM-during-startup
  teardown, one-transport-failed continuation.
- **iOS unit**: discovery dedupe across transports, scan lifecycle bound to
  screen appearance, view-model states for waiting/declined/timeout/busy,
  `pairDiscover` client flow mirroring the existing companion tests.
- **E2E**: a discovery arm in `tests/rdk-companion-navigation-e2e.test.ts`
  proving discover → voice confirm → bind → nav route flow.
- **Live bench**: `dns-sd -B _maxhelmet._tcp` on the dev Mac sees the beacon;
  a BLE scanner app sees the advertisement; a real spoken 确认 on the board
  completes a pairing; beacon stops once paired.

## Phasing

1. **Phase 1 — LAN + voice confirm end-to-end**: protocol, relay state
   machine, board mDNS advertiser, iOS Bonjour scanning and UI. Fully usable
   on the bench and for phone-hotspot rides.
2. **Phase 2 — BLE**: board bluez advertiser + iOS CBCentralManager scanning.
   Covers different-network field cases.
3. **Phase 3 — Android**: blocked on an Android companion client existing at
   all (today Android has only generated protocol constants). Out of scope.

## Out of scope

- Any change to the six-digit code flow, HUD redaction, or bench token gating.
- BLE GATT services, background scanning, or app-to-board direct data paths.
- Android companion client.
- QR codes or other camera-based pairing.
