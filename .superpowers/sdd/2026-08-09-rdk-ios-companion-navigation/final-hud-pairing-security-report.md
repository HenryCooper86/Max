# RDK HUD pairing-secret transport security fix

## Outcome

`fixed`

Base revision: `5e330e73fcaa43bcd752aa03eb03155e35ea0f5a`

The vulnerable path was revalidated before editing: `createRelayClient.onEvent` forwards a
`companion.pairing` event to `Main.publishHud`; `reduceHud` retains the six-digit code and expiry in
`HudState`; `createHudServer.publish` then serialized that same full state to every unauthenticated
WebSocket accepted by the HUD's all-interface HTTP server. A non-loopback LAN TCP peer needed no
credential beyond network reachability to read and redeem the live code.

The enforced invariant is that `companion.pairingCode` and `companion.pairingExpiresAt` may cross
the HUD WebSocket only when the accepted TCP peer is IPv4 loopback (`127.0.0.0/8`), IPv6 loopback
(`::1`), or IPv4-mapped loopback. Direct non-loopback peers continue to receive the ordinary bench
HUD state. The board-local Chromium/HDMI HUD and an authenticated SSH local forward retain the full
pairing state.

## Patch strategy

The fix is confined to the serialization boundary in `rdk/agent/src/hud/server.ts`:

- classify each accepted socket once from `request.socket.remoteAddress`, using Node's native IP
  parser and `BlockList` representation of `127.0.0.0/8` plus `::1`;
- never consult `Origin`, `Host`, forwarded headers, URL/query values, or client messages;
- remember that per-socket decision and choose a full or redacted payload independently for both
  initial replay and every later broadcast;
- build the non-loopback payload from a copied `companion` object with both secret fields removed,
  leaving the caller's source state unchanged.

This is the narrowest repository-native enforcement point that covers every HUD WebSocket sink
without binding the legitimate non-secret LAN HUD to loopback or adding another secret to the same
unauthenticated page.

## Regression proof

Added `tests/rdk-hud-server-security.test.ts`, which uses the real HTTP/WebSocket server and actual
TCP interfaces rather than a mocked sender. It covers:

- a non-loopback initial replay and subsequent broadcast;
- simultaneous ordinary transcript, navigation, connection, latency, and companion status fields;
- spoofed loopback `Origin`, `Host`, `Forwarded`, `X-Forwarded-For`, `X-Real-IP`, query values, and
  a client message before broadcast;
- actual IPv4, IPv6, and IPv4-mapped loopback clients;
- caller-state nonmutation followed by a full local replay;
- unpaired/live, paired/expired, and no-secret companion states;
- listener shutdown after connected clients leave.

Before the production edit:

```text
npx vitest run tests/rdk-hud-server-security.test.ts
Test Files  1 failed (1)
Tests       1 failed | 2 passed (3)
```

The failing real non-loopback initial frame contained exact `pairingCode: "314159"` and
`pairingExpiresAt: 2000000000000`; the expected payload omitted both. That was the original issue,
not a setup, import, timeout, or mock failure.

After the edit, the same boundary check completed with three passing tests. Removing the remote
snapshot selection or sending the full state in either the connection handler or publish loop makes
the corresponding initial/broadcast assertion fail.

## Verification evidence

### Applicability and buildability

- `npx prettier --check rdk/agent/src/hud/server.ts tests/rdk-hud-server-security.test.ts rdk/README.md docs/rdk-ios-companion-acceptance.md` — PASS.
- `npx tsc -p rdk/agent/tsconfig.json` — PASS.
- `git diff --check` — PASS.

### Security closure and bypass review

- `npx vitest run tests/rdk-hud-server-security.test.ts` — PASS, 1 file / 3 tests.
- Retraced source to sink after the patch: the full source remains in `HudState`, but a
  non-loopback accepted socket can reach only `remoteHudSnapshot` in both send sites.
- Alternate malicious metadata is covered in the real handshake and has no influence on trust.
- Undefined, malformed, non-loopback IPv4/IPv6, and mapped non-loopback addresses fail closed
  through `isIP` plus the loopback-only `BlockList`.

The original issue no longer reproduces: the same real non-loopback connection now receives no
pairing code or expiry in its initial or broadcast JSON payload, including paired/expired state.

### Preserved behavior

- The real IPv4, IPv6, and IPv4-mapped loopback controls receive the complete code and expiry on
  initial replay and broadcasts.
- The real non-loopback control retains transcript, navigation, connection, latency, accuracy, and
  fix-age state.
- The source `HudState` remains full and unchanged, and a local client connected after a remote send
  receives that full state.
- Existing two-argument `createHudServer(port, previewPort)`, publish, and close behavior is
  unchanged.

### Repository and platform gates

- `npm run check` — PASS: protocol generation check, formatting, ESLint, Knip, 103 Vitest files /
  1,305 tests, 24-case fault matrix, TypeScript build, and Vite build.
- `npm run check:protocol` — PASS independently.
- Full iOS command from `ios/` with Xcode developer directory and the named iPhone 17 simulator —
  PASS, 397 tests / 0 failures (`** TEST SUCCEEDED **`).
- `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew test lintDebug assembleDebug`
  from `android/` — PASS (`BUILD SUCCESSFUL`; 53 tasks, unchanged tasks were up-to-date).

### Privacy searches

- `rg -n "lat|lon|course|speed" server/companion-store.ts` found only the substring `lon` inside
  existing `cloneBinding` / `cloneMaps` identifiers; it found no raw-location storage field.
- `rg -n "companion.location|phone.location" server` found only the expected protocol routing
  sites in `server/companion-registry.ts`; inspection found no payload logging.
- The pairing-field search finds the local renderer/state source and the two explicit deletes at
  the transport boundary; the full-payload send is guarded by the accepted socket's loopback
  classification.

## Files changed

- `rdk/agent/src/hud/server.ts`
- `tests/rdk-hud-server-security.test.ts`
- `rdk/README.md`
- `docs/rdk-ios-companion-acceptance.md`
- `.superpowers/sdd/2026-08-09-rdk-ios-companion-navigation/final-hud-pairing-security-report.md`

## Remaining operational acceptance

The automated proof exercises the real server across this host's real non-loopback and loopback
TCP interfaces. The documented physical RDK row—direct LAN payload contains neither secret while
the HDMI/local HUD still displays them—remains `PENDING` until the reviewed commit is deployed to
the board. No merge, push, deployment, pairing, or physical acceptance was performed by this fix.
