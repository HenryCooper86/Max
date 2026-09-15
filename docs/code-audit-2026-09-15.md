# Code and AMap review — 2026-09-15

Base commit: `b1fd20fae8f6`. This report covers the navigation and AMap validation fixes.

## Fixed

1. **Navigation could start after cancellation during the location prompt.** The attempt now owns its generation before requesting permission. Stop, teardown, and newer attempts invalidate it before a late grant can start GPS or route search. Regression tests cover stop and teardown.
2. **Overlapping location permission requests could orphan a continuation.** The system stream shares one prompt across all waiters, ignores the initial undetermined delegate callback, and immediately returns an already settled authorization result. Tests cover concurrent requests, repeated callbacks, and settled permissions.
3. **Cached or invalid GPS fixes could drive navigation.** The system stream rejects invalid coordinates, negative/non-finite accuracy, fixes older than 15 seconds, and timestamps over five seconds in the future. A valid recent measurement earlier in a batch remains usable when the final measurement is invalid.
4. **Clearing a relay route did not invalidate pending provider requests.** Clearing now increments the request generation, preventing a late start or reroute from restoring the route or speaking a stale confirmation. Both cases reproduced before the fix and pass afterward.
5. **Malformed AMap responses were accepted as usable routes.** Blank/out-of-range coordinates, invalid numeric types, blank/negative durations and distances, null steps, and routes without traversable geometry are rejected. Thirteen added upstream-response cases failed before the fix and pass afterward.
6. **Navigation construction crossed main-actor boundaries.** The location protocol, navigation construction, and device-router ownership now use explicit main-actor isolation. The asynchronous relay search uses scoped locking for its cached destination name.
7. **Dead code and responsibilities.** Removed the unused relay-search clock dependency, unreachable AMap response checks, and redundant crash-ack string fallbacks. Extracted Core Location plumbing into `SystemLocationStream.swift` so permission handling can be tested independently of navigation orchestration.

## Verification

| Check                                                                              | Result                                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Web, relay, shared logic and RDK TypeScript tests                                  | 1,611 passed across 114 files                                  |
| Protocol generation, formatting, ESLint, Knip, RDK typecheck, production web build | Passed                                                         |
| Release fault matrix                                                               | 24 cases matched expectations                                  |
| Final routing-focused rerun after dead-branch cleanup                              | 61 passed; production build passed                             |
| iOS simulator full suite                                                           | 491 executed: 490 passed, 1 physical-only test skipped         |
| Physical iPhone navigation, permission and AMap suite                              | 43 passed, including real SDK map loading and snapshot capture |
| Android unit tests                                                                 | 88 passed                                                      |
| Android lint                                                                       | Completed with zero errors and 42 warnings                     |
| Helmet vision Python tests (hardware excluded)                                     | 478 passed                                                     |

Android warnings are principally dependency updates and Kotlin style suggestions. The reviewed TLS exceptions are explicitly Debug-only, and the process-wide session holder receives application context. These warnings were not blanket-suppressed. Other iOS modules still emit Swift 6 migration/deprecation warnings; this change does not upgrade the app's Swift language mode.

## AMap device and service checks

- Installed native SDK: `AMap3DMap-NO-IDFA 11.2.100`, foundation `1.9.1`.
- Confirmed the iOS key is present without exposing its value.
- The user accepted the disclosure and confirmed the map and fixture route are visible on the iPhone 17 Pro Max.
- The physical-device test verified successful SDK loading, one route overlay, one rider annotation, disabled map gestures, visible attribution, a valid camera region, and a completed map snapshot.
- Initialization configures privacy before creating the map view, matching [AMap's documented initialization order](https://a.amap.com/lbs/static/unzip/iOS_Map_Doc/AMap_iOS_API_Doc_3D/interface_m_a_map_view.html).
- Live REST destination lookup failed from both the Mac and the configured relay with `10005`. AMap defines this as an [IP allowlist error](https://developer.amap.com/api/web-service/tools/info). The relay's observed public egress address is `3.35.135.136`. The user is adding it to the Web Service key allowlist while the remaining checks finish.

**Map rendering is verified; live destination search and driving routes require the allowlist update and a successful REST recheck.** The displayed device route is a deterministic test fixture. These checks do not replace a moving-device route, background/lock-screen, or network-loss acceptance test.

## Delivery

The final Debug app was installed on the iPhone and is built with `HORIZON_GIT_COMMIT=b1fd20fae8f6-dirty` to distinguish these uncommitted fixes from the base commit. No production relay deployment or dependency upgrades were performed.
