# Repository review — 2026-09-24

This review covered the web client, relay, shared TypeScript, RDK vision tests, Android unit tests and lint, and the iOS simulator suite. It also compared active setup documentation with current code. Historical specs and plans remain dated records, so they were not rewritten.

## Fixed

1. A relay token accepted from `?token=` stayed in the browser URL when local storage threw. Token persistence and URL cleanup now run independently, with an in-memory fallback for the current page. A regression test covers unavailable storage.
2. iOS Debug and Release requested location access with different rider-facing explanations. Both now use one description that names explicit navigation and Helmet Ride behavior. Debug also declares the motion-sensor purpose used by crash detection, matching Release. The plist test now checks motion-purpose parity.
3. The main README and mobile READMEs contained superseded instructions for hidden settings, old web source paths, Android maps, first-fix timing, and already implemented follow-ups. The active instructions now match the current UI and code. A Chinese main README was added.

## Verified here

| Check                                                    | Result                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm run check` after edits                              | Passed: 1,722 Vitest tests, 24 fault-matrix cases, protocol, formatting, lint, dead-code, RDK TypeScript, build |
| RDK vision (`uv` with `rdk/vision/requirements-dev.txt`) | 478 passed, hardware tests excluded                                                                             |
| Android `testDebugUnitTest lintDebug`                    | 154 tests passed, 0 failures; lint passed with local Android SDK and Android Studio JBR                         |
| iOS full simulator suite                                 | 534 passed, 1 hardware-only test skipped after correcting the plist copy and Debug motion-purpose key           |

## Remaining gaps and acceptance work

- The RDK live Ark vision path still needs a working credential and on-device quality checks. Its keyless path is deterministic demonstration output.
- Real ADAS sensor detection, false-alarm tuning, and road acceptance are still outstanding; current hazard injection is simulated.
- Android Bluetooth routing, speaker echo, crash-sensor calibration, emergency delivery, and signed-build AMap tile authorization need physical-device checks. The implementation and unit tests are present.
- Navigation uses AMap car routes. Motorcycle restrictions are not represented in route decisions.
- The shared test relay still uses a self-signed certificate; release apps require a trusted domain and certificate.

See [mobile parity](mobile-parity.md), [RDK acceptance](rdk-ios-companion-acceptance.md), and the prior [navigation review](code-audit-2026-09-15.md) for detailed acceptance evidence.
