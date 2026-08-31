# Navigation first-fix retry (正在定位)

Status: implemented 2026-08-16 (relay, iOS, Android, web)
Date: 2026-08-16

## Problem

Asking for a route indoors fails with 路线规划失败 and no explanation.

Observed on `h2o` (iPhone 17 Pro Max) against the live relay, 2026-08-16:

- 12:36 local — `nav.request` sent, route returned. Navigation worked.
- 13:02 and 13:03 local — a device command dispatched and answered within
  ~1 s, **no `nav.request` at all**, and the rider heard 路线规划失败.

`route.unavailable` has exactly two sources in `NavigationController.start()`:
no first fix, or no route from the relay. The relay logged no `nav.request`,
so the search was never reached — the first fix timed out. The bound is 3 s
(`ios/.../NavigationController.swift:79`, `android/.../NavigationController.kt:83`).

A cold GPS fix indoors routinely takes far longer than 3 s, so navigation
fails before it ever asks for a route, and blames route planning for a
location problem. This was predicted during nav live-QA review — "cold-GPS
first fix vs the 3 s bound (garages/urban canyons → route.unavailable;
consider a 正在定位 retry)" — and is now confirmed on hardware.

Web fails the same way with a worse diagnosis: `handleNavigationStart`
(`src/lib/navigation.ts:120`) denies immediately with `permission.location`
when `lastFix` is null, reporting a permission fault even when permission is
granted and only the fix is missing.

## Timing budget

| Stage                                       | Now  | After    |
| ------------------------------------------- | ---- | -------- |
| Relay waits for a `navigation.start` result | 12 s | **18 s** |
| Device: first fix                           | 3 s  | **8 s**  |
| Device: route search over the relay         | 7 s  | 7 s      |
| Device worst case                           | 10 s | **15 s** |

The relay deadline is a safety net: it is what lets Max speak when a device
goes silent. 18 s keeps 3 s of margin over the device's worst case without
padding for nothing. The search's 7 s carries a stale comment ("under the
relay's 8 s device backstop") — navigation has always had its own longer
deadline, so that headroom was never claimed. Leave 7 s alone; this design
spends the new budget on the fix, which is where the failure is.

## Decisions

1. **Announce, then keep waiting.** At 1.5 s without a fix the device speaks
   正在定位…; it keeps waiting until 8 s.
2. **The device speaks the interim line locally**, as iOS already does for
   已停止导航. Only the device knows the fix is slow, and routing an "I am
   still working" message through the relay would add latency to the one
   message whose whole purpose is latency.
3. **The failure line travels as `result.detail`.** Reconciliation prefers
   `result.detail` over the `FAILURE_SPEECH` map, so the actionable copy needs
   no new server reason code and stays single-sourced per platform result.
4. **No location warm-up at session start.** Starting the location stream when
   hands-free begins would make the common case instant, but location today is
   a best-effort one-shot for weather and Helmet Ride is deliberately a
   separate opt-in flow. Continuous location for every voice session is a
   privacy change, not a timing fix. Out of scope; raise separately.
5. **`route.unavailable` keeps two voices.** The reason code covers both "no
   fix" and "no route from the relay". Only the no-fix path carries the new
   detail; a search failure still speaks 路线规划失败。 Attaching the location
   copy to both would tell a rider to go outside when the relay simply could
   not find a route.

## Speech

| Moment                     | Text                                 | Spoken by                    |
| -------------------------- | ------------------------------------ | ---------------------------- |
| 1.5 s, no fix yet          | 正在定位…                            | device, locally              |
| 8 s, still no fix          | 还没定位到，到室外或空旷处再说一次。 | relay, from `result.detail`  |
| Permission actually denied | unchanged (`permission.location`)    | relay, from `FAILURE_SPEECH` |

The failure line is actionable where 路线规划失败 was not: it names the cause
and tells the rider what to change. Permission denial keeps its own distinct
line, so "you said no" and "the sky is blocked" stop sharing a symptom.

## Per-platform design

### iOS — `NavigationController.start()`

`awaitFirstFix(generation:)` gains a second timer beside its existing
watchdog. Both are cancelled in `resolveFirstFix`, which is already the single
place a pending first-fix wait is torn down.

- `firstFixAnnounceSeconds: TimeInterval = 1.5` (injectable, like
  `firstFixTimeoutSeconds`)
- `firstFixTimeoutSeconds` 3 → 8
- The announce timer calls `speak("正在定位…")` only when
  `generation == navigationGeneration` **and** `firstFixContinuation != nil`
- On timeout, `startFailureResult` reports `route.unavailable` with the new
  detail — only when this generation is still current, so a superseded attempt
  keeps returning `navigation.cancelled` unchanged

### Android — `NavigationController.kt`

Mirrors iOS exactly: `firstFixAnnounceMillis = 1_500`,
`firstFixTimeoutMillis` 3_000 → 8_000, the announce job cancelled wherever
`firstFixWatchdog` is. The port already carries the hardened
deferred-identity guard; the announce job must use the same identity check
(`firstFixContinuation !== deferred`) rather than generation alone.

### Web — `src/lib/navigation.ts`

Web has no first-fix wait at all, and its geolocation watch is weather-tuned
(`enableHighAccuracy: false, maximumAge: 30_000`). Replace the instant deny:

- If permission is genuinely denied → `denied("permission.location")` (unchanged)
- Otherwise request a high-accuracy one-shot fix, announce at 1.5 s, fail at
  8 s with the same detail

This also fixes web's misdiagnosis, which is the more serious of the two bugs
because it tells a rider to check a permission that is already granted.

### Relay — `server/device-actions.ts`

`NAVIGATION_RESULT_TIMEOUT_MS` 12_000 → 18_000, with a comment tying the value
to the device's 8 + 7 worst case so the two cannot drift silently.

## Suppression: the race that must not fire

A rider must never hear 正在定位 after guidance has already begun. The
announce timer is cancelled when any of these happen first:

- the fix arrives (`resolveFirstFix`)
- an explicit stop bumps the generation (`stopGuidance`)
- a newer start supersedes this one
- the session ends

A fix landing at 1.49 s is the sharp case: the timer must be cancelled by the
resolution path, not merely guarded at fire time, because on iOS the speak
would already be queued behind the resolution on the main actor.

## Testing

Pure, clock-injected controller tests on each platform — no device required:

- fix at 1.0 s → **no** announcement, route requested
- fix at 4.0 s → announcement at 1.5 s, route requested, start succeeds
  (this is the case that fails today)
- no fix → announcement once, failure at 8 s with the actionable detail
- fix at 1.49 s → no announcement, and none arrives late
- stop at 1.0 s → no announcement, result stays `navigation.cancelled`
- superseding start at 1.0 s → the superseded attempt announces nothing

Server: a guard test asserting `NAVIGATION_RESULT_TIMEOUT_MS` exceeds the
documented device worst case, so raising a device bound without raising the
deadline fails loudly rather than in the field.

## Out of scope

- Location warm-up at session start (decision 4)
- Web's weather-tuned watch accuracy during guidance — a known separate gap
- Any change to the 7 s search bound

## Open question for review

8 s is chosen to cover a warm-ish fix while staying inside a deadline the
rider will tolerate. It will still fail deep indoors, where a cold fix can
take 30 s or more; the design's answer there is the actionable failure line
rather than a longer wait. If riders should instead be able to wait
indefinitely until they cancel, that is a different contract — the relay's
"exactly one device.result per command" rule would need an explicit
still-working signal — and should be decided now rather than retrofitted.
