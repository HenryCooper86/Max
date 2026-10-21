# Changelog

### Added

- **iPhone companion navigation for the RDK helmet** — an authenticated iOS account can pair to a
  durable RDK device with a six-digit single-use code and explicitly start/stop Helmet Ride. The
  phone forwards precise current fixes over the independent `/companion` socket while locked; the
  RDK owns Amap route requests, far/near/now prompts, rerouting, stale-location pause/resume,
  arrival, HUD state, and ranked playback so armed ADAS alerts retain priority. Pairing and ride
  state do not auto-start on login or relaunch; unpair/logout/force-quit stop forwarding. Binding
  persistence contains only account/device metadata at owner-only permissions, companion metrics
  are aggregate-only, and neither relay nor iOS persists fixes. Added deterministic real-component
  end-to-end/privacy coverage plus a PENDING-until-observed physical/deployment evidence template.

- **Companion discovery pairing (iOS, Phase 1)** — unpaired boards broadcast a
  rotating, secret-free discovery token via mDNS under `_maxhelmet._tcp`
  (TXT record `dt=<token>`). The iOS app scans Bonjour on the pairing screen,
  lists nearby helmets by discovery beacon, and pairing completes with a spoken
  prompt ("检测到配对请求，请说"确认"。" — rider confirms by saying 确认). The HUD's
  配对广播 status line shows discovery transport liveness; `discovery: off` while
  unpaired means both transports failed — check journal for `[discovery]` lines.
  The six-digit code path (HDMI HUD / SSH forward) remains unchanged as fallback,
  useful when Bonjour is blocked or after network loss. Phase 2 (BLE) and Phase 3
  (Android) are separate.

- **Crash detection & emergency escalation (iOS)** — during a hands-free session
  the phone's IMU watches for a crash signature (≥4.5 g sustained pulse or ≥6 rad/s
  tumble, then stillness; speed-gated below 10 km/h). A pure, trace-tested
  `CrashEngine` (`ios/MaxHelmet/Crash/`) drives the flow: 15 s spoken check-in
  ("你还好吗？", cancel by tap or "我没事") → 30 s full-screen alarm with siren and
  GPS coordinates → one `crash.alert` to the relay. New protocol events
  `crash.alert` / `crash.cancel` / `crash.ack` / `crash.simulate`
  (`protocol/agent-events.schema.json`); relay module `server/crash-escalation.ts`
  with a pluggable notifier — log-only by default (`CRASH_NOTIFIER=log`), so the
  ack honestly reports `unconfigured` and Max tells the rider to dial by hand.
  Post-escalation cancel sends a 误报 follow-up. Alarm survives session death;
  un-acked alerts resend on reconnect; 10 s without an ack shows
  "服务器未确认 — 请手动拨打". Settings add an emergency contact (Keychain,
  name-or-number via the contacts resolver), a relay opt-in (default **off** — the
  one carve-out to "contact numbers never leave the device"), the alarm call
  target (120 / contact), and a 仅记录 mode to harvest real-ride traces before
  arming. New 事故 mock scenario rehearses the whole flow without hardware; web
  and Android ignore the new events. Honest limits: voice cancel needs the
  network (ASR is server-side), and iOS cannot place calls itself — the call
  button needs a human tap.

## 2026-10-20 — Separate Testing and Administration

- Split the web workspace into dedicated Testing and Administration entries,
  routes and navigation. Testers stay in Testing; reviewer/admin permissions
  remain enforced independently by the server.
- Added a concise testing overview and read-only assigned test plans with
  readable names, instructions, device guidance and scoped progress. Browser
  task setup respects draft departure guards and supports blocked-run recovery.
- Removed raw IDs, build hashes, diagnostic tables and raw check details from
  Testing. Conversations provide plain-language results and feedback; mobile
  detail hides list filters. Technical diagnostics and management stay in Admin.
- Separated incomplete recordings from passing results and added current-catalog
  validity filtering before result totals/pagination. Missing response timing is
  explained without falsely reporting slow responses; hidden build filters do
  not carry into Testing.
- Preserved account/role-scoped drafts across panel switches and reload, and
  kept browser Back/Forward navigation between the voice app and workspaces.

## 2026-10-20 — Web admin operations workspace

- Replaced the dark-green, densely stacked admin layout with neutral charcoal
  surfaces, consistent controls, action-first overview, compact mobile navigation
  and a profile menu for account utilities and language.
- Added shareable admin section, release, session and filter URLs with refresh
  and browser-history support. Missing run/session links no longer select
  unrelated actionable records.
- Reorganized evidence into a session list and Conversation/Diagnostics/Review
  detail views; moved test setup and aggregate diagnostics into disclosures.
  Added server-side transcript search across unloaded pages and composable
  tester, build, platform, quality and independent-review-status filters.
- Preserved account/role-scoped evidence drafts across triage and reload, with
  explicit discard cleanup and protections against stale search/save responses.
  Empty, collecting, invalid and missing-measurement states no longer imply PASS.
- Grouped release coverage by case/platform, capped progress per requirement,
  added actionable blockers and a separate confirmed administrator approval.
  Late creation requests cannot replace a newer release selection.
- Added complete policy threshold comparisons, inline validation and reviewed
  publication; external policy changes preserve dirty drafts and block stale
  publication. Audit entries use readable labels, linked records, filters and
  expandable technical details. Account/invite groups retain destructive
  safeguards and clipboard fallback; admin copy is localized in English/Chinese.

## 2026-10-15 — Browser navigation session isolation

- Reset browser navigation when a settings change replaces the relay session.
  Pending location/route work and active guidance are retired before reconnecting,
  so old command results and route prompts cannot leak onto the replacement socket.
  Regression coverage exercises pending location, route lookup, active guidance,
  stale route responses, and successful navigation in the new session.

## 2026-08-11 — Helmet board: a review pass over `rdk/`

A read of the whole embedded client, agent and sidecar, and the eleven things
it turned up. Everything here is bench-verified by test only; none of it has
been on the board yet, and the standing live checks in rdk/README.md still
apply — in particular a conversation with barge-in, because the alert audio
path changed.

**Security — the bench surface now authenticates.** Ports 8080 (HUD) and 8081
(sidecar) both bind `0.0.0.0`, the sidecar runs as root, and neither was
authenticated: any peer on the network could stream the helmet cameras, list
and download every recorded clip, read the rider's live transcript and
destination, and destroy a capture with a plain cross-origin `POST` that needed
no token, no header, and no readable reply. Both ports now require
`MAX_VISION_TOKEN` from any peer that is not the board itself, fail closed when
it is unset, and say so on start. The HUD is gated alongside the sidecar
deliberately — it carries the token so the browser's own fetches work, so
serving that page to a stranger would have handed them the key. Holding the
token is admission, not locality: pairing-code redaction still keys off the
peer address, so a token-bearing LAN browser still never sees the code.
`/preview/*` also obeys the `MAX_VISION_SHARE` consent gate now, which it had
always been exempt from — the larger of the two frame leaks, not the smaller.
**The HUD's camera panels therefore need `MAX_VISION_SHARE=1`.**

**A slow control client could stall hazard detection.** Broadcasts wrote
straight to the connection's socket under a lock, with no timeout, from the
ADAS threads. A client that stopped reading blocked detection itself — an alert
could not be reported because a watch frame queued seconds earlier was still
being written. Each connection now has a bounded outbox and one writer thread:
a reading client still loses nothing, and a wedged one costs one bounded wait
before it is dropped from the event registry.

**Two captures could become one file.** Gallery ids carried a per-process
counter, not the per-second one the docstring claimed, so the first capture
after a restart took the bare timestamp back. Reusing that directory overwrote
a photo — or, since segments open with `"ab"`, appended a new clip onto the old
one under a manifest describing only the new. The board has no RTC, so every
pre-NTP boot stamps from the same fake epoch, which is exactly when two runs
report the same second. Ids are now checked against the disk as well as the
current second.

**Rerouting could wedge for the rest of a session.** A reroute request had no
timeout, unlike the start path, so a reply that never arrived left the record
set forever: no further attempt, and the HUD stuck on `rerouting`. It now
expires and returns to `guiding` on the route the rider is already following —
a missing reply is not evidence that no route exists.

Also: the HUD transcript is capped (it grew for the life of the process and was
recopied on every streaming caption); the alert WAV parser walks the chunk list
instead of trusting fixed offsets, where a metadata chunk turned 480 samples of
speech into 516 samples of chunk header played as a collision warning; a
`shutdown` that cannot start is logged instead of taking the agent down as an
unhandled `error` event; a recording start/stop race could leak a writer thread
spinning for the life of the process; `start_adas` moved out of `service.py`,
which is run as `__main__` and so was being loaded a second time as a duplicate
module; and the relay's socket factory is handed the same options the real
constructor gets.

Repo hygiene, both found while checking the above: the RDK agent's TypeScript
was type-checked by nothing (`rdk/agent/tsconfig.json` was referenced by no
script or CI job) and is now part of `npm run check`; and a stale git worktree
under `.claude/` was supplying 923 of the 2231 test cases a local `npm test`
collected, so 41% of every run re-tested an abandoned branch.

## 2026-08-01 — Helmet board: dual cameras that tell the truth

RDK X5 embedded client (`rdk/` — the day-by-day record lives in
rdk/README.md's bench findings):

- Gave each camera its own ROS topic and node name. The vendor `mipi_cam`
  hardcodes `/image_raw`, so two cameras interleaved both sensors into every
  subscriber — visible as preview/recording flicker, and it blinded the
  frame-staleness watchdog. Verified live: one publisher per topic, ~30 fps
  each, and killing a camera node now self-heals in ~20 s.
- The vision sidecar exits for systemd retry when a camera that i2c detected
  fails to open (the OV5647's documented boot-time ISP stall) — a half-blind
  boot no longer needs a human restart.
- Recordings are honest about time: the manifest stamps the achieved write
  rate alongside the wall-clock duration, playback paces from it (1× is real
  time; ½×/2× multiply the clip's own rate), and the parallel per-side encode
  lifts dual-camera recording from 4–7 fps to a measured 9.8.
- Hazard alerts preempt by severity: a critical clip cuts a caution clip's
  tail instead of queueing behind it; equal severity still queues and rider
  speech still never cancels an alert. Inert until alert audio is armed.
- Fixed the relay client's intentional-disconnect path (the close event was
  swallowed by its own stale-socket guard) and made ride scoring name records
  a corrupted shadow log leaves unscored instead of dropping them silently.
- The gallery no longer trusts the boot clock: the board has no RTC, so a
  capture started seconds after power-on carries a pre-NTP `pair-20000101-…`
  id and used to file itself at the bottom of the grid dated 01-01. Listing
  order and the capture-time label now follow the manifest's mtime whenever
  the id's stamp predates the project.
- Closed the review-parked ADAS micro-issues: `clip.py` refuses an alert's
  empty-segment sentinel with its meaning instead of handing ffmpeg a
  directory, and two previously untested claims — legacy no-fingerprint
  records scoring under the ride's first header, and replay driving the ego
  estimator with the same verdicts as a forced gate — are pinned by tests.

## 2026-07-19 — Reliable per-user recall

- Expanded authenticated recall from the last 8 turns to the full bounded
  24-turn window and added direct, injection-resistant instructions for
  answering follow-up questions from earlier conversations without invention.
- Added up to 12 account-scoped facts that riders explicitly ask Max to
  remember in Chinese or English; pinned facts persist beyond the rolling
  dialogue window and are removed by the existing forget action.
- Refreshed the account memory badge during active use so newly saved turns and
  pinned facts no longer appear stuck at the login-time count.

## 2026-07-19 — Cross-account privacy and production delivery guardrails

- Migrated username-keyed legacy memory by discarding only the ambiguous
  records instead of treating an otherwise healthy memory store as corrupt.
- Scoped web, Android, and iOS transcript caches by immutable account UUID and
  discarded ambiguous device-global legacy caches, preventing a second login
  on a shared device from seeing the previous rider's local conversation.
- Bounded reassembled WebSocket messages to 64 KiB, disabled per-message
  compression, added slow-client HTTP timeouts, and gave hashed client assets
  immutable caching while keeping the HTML shell revalidated.
- Extended readiness to fail when account or durable user-memory storage is
  corrupt/unwritable, and made build identity read the package version plus
  deploy timestamp instead of relying on npm lifecycle environment variables.
- Hardened deployment provenance: production deploys require a clean `main`
  checkout matching `origin/main`, stage dependencies before an atomic directory
  activation, automatically roll back failures, then poll health and readiness
  for the exact build SHA. The default MR template captures risk, local
  verification, review, and delivery checks.
- Removed the inactive GitLab CI configuration while the project has no runner;
  full local checks and dependency auditing remain mandatory in every MR.
- Required the manual live release gate to match an administrator-approved
  build; passing metrics alone can no longer authorize deployment.

## 2026-07-19 — Per-user memory and relay protocol hardening

- Added private, server-owned conversation memory for authenticated users:
  the latest validated session snapshot and a bounded 24-turn history survive
  reconnects, devices, and relay restarts. Only 8 recent turns enter the live
  prompt, explicitly marked as untrusted transcript context.
- Added authenticated memory metadata/forget endpoints and a two-step account
  bar control. Deleted accounts also lose their saved memory; anonymous and
  operator-token sessions never share a memory identity.
- Serialized client WebSocket messages in wire order and reject pre-start
  audio/control traffic plus duplicate `session.start` events, closing races
  that could initialize providers and QA evidence out of order.
- Made mocked Doubao tests credential-independent through Vitest-only setup,
  added memory/persistence/isolation/prompt and protocol-order regressions,
  and added `npm run check` as the single local/GitLab verification command.

## 2026-07-15 — Live-agent QA control plane and release governance

- Moved private tester evidence out of the public `/health` poll into
  authenticated summary, cursor-paginated session, replay, run, review,
  policy, and audit APIs. Testers are self-scoped; the new reviewer role can
  operate QA without receiving account/policy/destructive admin privileges.
- Added a SQLite operations/evidence index alongside the append-oriented JSONL
  recovery archive: risk-weighted release runs, cross-platform assignments,
  durable issue triage, reviewer notes, immutable policy history, audit events,
  and an explicit approved regression baseline now survive deployments.
- Evidence startup now repairs older permissive filesystem modes: the default
  storage directory is `0700`, while SQLite, its journals, and JSONL archives
  are `0600` because they may contain tester identities and transcripts.
- Added SHA-256 integrity verification over captured evidence. Reviewer notes
  and current-policy replays remain mutable without changing the capture hash;
  mismatched evidence is excluded from release and regression decisions.
- Strengthened decisions with per-case sample minimums, required web/iOS/
  Android cohorts, matched case/platform/network/language regression, strict
  assignment credit, and admin-only approval blocked by incomplete coverage,
  open reviews, gate failure, or baseline regression.
- Expanded the admin UI with release-run planning, coverage assignments,
  durable issue ownership/disposition, policy versions, audit history,
  paginated evidence, captured-vs-current evaluation drift, audio quality, and
  role management. The old browser-local failure watermark is replaced by the
  shared review queue.
- Web sessions now report aggregate frame rate, drops, jitter, clipping, and
  silence. Native clients accept run/assignment/test-case attribution and no
  longer send fake `ios-local`/`android-local` commits; Android resolves git at
  build time and iOS accepts `HORIZON_GIT_COMMIT` as a build setting.
- Added a 24-case deterministic fault matrix, a live release-gate report CLI,
  and GitLab jobs that retain build and release-decision artifacts.

## 2026-07-15 — Security, QA evidence, and session-lifecycle hardening

- Closed a remaining registration bypass on token-protected relays: an
  arbitrary string in `inviteCode` no longer satisfies the HTTP guard when no
  relay token was presented. The account layer now independently requires and
  revalidates a real single-use invite before and after password hashing.
- Retained JSONL sessions are re-evaluated with the current deterministic
  policy on load. Persisted `quality`, `validity`, and check results are treated
  as derived snapshots, so an old false pass cannot keep feeding today's
  release gate after the evaluator changes.
- Regression comparison now skips previous builds that contain only invalid
  evidence and selects the latest previous build with at least one valid run.
- Wake-word evaluation now mirrors the live bounded follow-up window instead
  of leaving the gate open forever after the first "Max". Emergency cases
  require actionable guidance, and ADAS cases require both a hazard cue and a
  direction or safe response rather than passing on a generic direction word.
- Temporary `/auth/me` network or 5xx failures no longer sign an active tester
  out; only an explicit 401 invalidates the stored session. Failed microphone
  or AudioWorklet setup now releases every media resource and closes the
  just-opened upstream voice session instead of holding a mic/provider slot.
- Relay event validation clamps negative counters/timers and out-of-range HUD
  values. Updated `tsx`/`esbuild` in the lockfile to remove the remaining
  low-severity development dependency advisory.

## 2026-07-05 — iOS & Android: tester turn feedback reaches parity with the web HUD

Both native apps can now flag a bad turn from the captions overlay (字幕):
tap "有问题?" on any final turn of the live session and pick a preset reason
(听错了 / 回答不对 / 太慢 / 不安全). The same `turn.feedback` event the web
client sends carries it to the relay, so flags land in the admin session
replay and downgrade the evaluation to watch identically across platforms.
Mirrors the web's safety rule: only current-session turns are flaggable
(feedback floor set at socket open, connection-gated), so a restored
transcript can't tag the wrong relay-side turn. Flags persist locally with
the conversation log on both platforms. Android compile green; Swift parse
clean (no Xcode on this machine — simulator walkthrough pending).

## 2026-07-05 — Testing platform: turn feedback, build tagging, fail alerting

Three additions aimed at the tester and admin experience. 187 tests green (6
new), tsc/eslint clean, verified end-to-end against a live relay (WS drive
script + real browser walkthrough of the admin panel).

### Release gate, regression comparison, and invalid evidence

- `/health.testing` now exposes a release gate for the currently deployed build:
  required test-case coverage, valid/invalid evidence counts, fail/watch
  blockers, p95 latency, and per-case status.
- The retained-session snapshot now compares the current build against the most
  recent previous build with valid evidence, reporting p95, score, fail-rate,
  and TTS fallback-rate drift.
- Completed sessions now carry a validity classification. Too-short runs,
  missing transcripts, missing required rider/agent turns, and missing required
  mic audio are marked invalid evidence and excluded from release/regression
  scoring instead of polluting pass/fail rates.
- The admin testing panel now surfaces release gate details, regression findings,
  and invalid evidence counts above the tester/session drilldowns.

### Stronger deterministic QA scoring

- Test cases can now declare expected rider/agent exchange shape, a transcript
  response-order budget, and case-specific agent evidence signals.
- The evaluator now fails rider-only sessions, fails non-ADAS sessions where
  Max speaks before the rider prompt, downgrades overly slow transcript
  responses to **watch**, and requires wind/noise plus degraded-network cases
  to contain relevant scenario evidence instead of passing on generic replies.
- Golden replay coverage now includes wind/noise safe-repeat and degraded
  network recovery fixtures.

### Tester turn feedback (web HUD → relay → admin replay)

- Testers can flag any turn of the live session in the HUD transcript
  ("有问题?" → one-tap preset reasons: 听错了 / 回答不对 / 太慢 / 不安全). A new
  `turn.feedback` client event carries it to the relay, which attaches the
  reason to the matching transcript turn (speaker + text match, latest-final
  fallback) and mirrors it into the tester's rolling conversation history.
- The evaluator gained a `tester-feedback` check: any flagged turn downgrades
  the session to **watch**; with no feedback the check is **skipped**, not
  passed — silence must not inflate the score.
- Flags survive history persistence and show as red ⚑ chips in both admin
  replay views. Only current-session turns are flaggable client-side (a
  restored turn could otherwise tag the wrong server-side turn).

### Build tagging for release comparison

- `deploy-lightsail.command` stamps `build-info.json` (short SHA + deploy
  time) before rsync; the vite build and the relay read it (env `GIT_COMMIT`
  → stamp file → local git → "local"), so web sessions and `/health` now
  carry the real deployed commit instead of hardcoded `"local"`/`"unknown"`.
- The admin panel shows the relay build in the 测试统计 header (构建 abc1234)
  and each session replay gets a Build cell (`appVersion · gitCommit`) — a
  latency regression can now be pinned to the deploy that introduced it.

### Fail alerting in the admin panel

- New failures are impossible to miss: a red "N 个新失败" pill in the stats
  header counts fail sessions this admin hasn't reviewed (watermark in
  localStorage), ignoring the current tester/quality filters. Clicking it
  jumps straight to the newest failing session with the Fail filter applied.

## 2026-07-05 — Final hardening sweep: 20+ fixes across relay, web, iOS, Android + password change

Three parallel deep reviews over the auth stack, the web auth UI, and both
native apps; every confirmed finding fixed in one pass. 181 tests green (7
new), tsc/eslint/prettier clean, Android compile + unit tests green, Swift
parse clean, key web flows re-verified in a real browser.

### Security (relay)

- **Registration on token-protected relays requires the relay token or an
  invite** — open self-registration let any stranger mint a session that
  bypassed `RELAY_AUTH_TOKEN` (and become admin on a fresh relay). The web
  client sends its stored relay token with auth POSTs; `validateConfig` now
  warns about the token+open-registration combination.
- **Invites are single-use under concurrency** — the code was validated before
  the scrypt hash and consumed after, so two concurrent registrations (or one
  racing an admin revocation) could both ride one invite. Re-validated and
  consumed post-hash; regression tests cover both races.
- **Corrupt accounts file now fails CLOSED** — a truncated `accounts.json` was
  indistinguishable from "no users yet" and silently reopened transcripts,
  clears, and the voice line. Non-ENOENT load errors now lock the gates, log
  loudly, and refuse registration (no stranger-becomes-admin over broken data).
- Login racing a user deletion no longer mints a dead token; sessions capped
  at 20 per user (oldest evicted); invite codes doubled to 128-bit and only
  logged truncated; failed logins and rate-limit hits are logged;
  `AUTH_ATTEMPTS_PER_MINUTE` is configurable and the proxy warning now covers
  the auth limiter.

### Added

- **修改密码** — `POST /auth/password` verifies the current password, swaps
  salt+hash, and revokes every OTHER session (a stolen token dies with the
  password) while keeping the caller's. Web UI on the account bar; verified
  end-to-end in the browser.

### Fixed (web)

- The login gate **booted into "register the first admin" mode for every
  anonymous visitor** on an established relay (health raced the render) and
  stuck there. The gate now waits for `/health` (4 s grace), then opens in
  login mode; the form re-derives when auth status changes.
- **Space could start a hidden mic session behind the login gate** — the
  hands-free hotkey now exists only inside the unlocked HUD.
- **Expired sessions re-lock the gate** — `/auth/me` is revalidated every
  minute; a dead session drops the identity, closes the socket, and returns to
  the login page (previously the HUD stayed unlocked with a stale identity
  forever).
- One credential precedence everywhere (`credentialToken()`): the WS used
  relay-token-first while HTTP used session-first, so a stale credential could
  shadow a valid one differently per channel; `canClear` now mirrors what is
  actually sent. Health responses are monotonic (no post-login flash of the
  locked-stats banner); the two-step clear confirms carry their target id (a
  poll reshuffle can no longer retarget an armed delete); the admin overview
  refreshes every 30 s and shows a real error instead of eternal "loading";
  restored sessions re-tie the tester id to the account; empty testing
  catalogs can't crash the panel.

### Fixed (iOS + Android)

- **A refused upgrade (401) left a zombie hands-free session** — mic
  capturing, audio route claimed, no reconnect — and the next helmet tap
  stopped the zombie instead of retrying, so login "didn't work" without a
  second tap. The rejection now ends hands-free like the idle-close path, and
  a successful login **auto-restarts the session**.
- **Stale-identity recovery**: a 401 while "logged in" (expired/revoked
  session) now drops the dead identity and opens the login form — previously
  the sheet never auto-opened and showed only the identity row.
- **The login session token is stored separately** from the manual 认证令牌
  field, so signing in/out no longer destroys a pasted operator relay token;
  the socket presents session-first with manual fallback.
- Android: the settings sheet no longer re-opens on rotation while a 401 is
  outstanding (the flag is consumed when handled); transcript ids are computed
  outside the retryable state update. iOS: URLSessions are invalidated when
  replaced (delegate retain leak). Both: `?token=` is replaced, not
  duplicated, when the relay URL already carries one; the password field is no
  longer cleared before a failed login's result.

## 2026-07-04 — Fix: cumulative ASR partials no longer concatenate into garbage transcripts

Doubao streams cumulative whole-utterance hypotheses within a rider turn
("我", "我也", "我也看到"…), but the relay APPENDED each one to the turn text.
Live captions looked fine (clients replace non-final items in place), but the
final rider transcript introduced in the review sweep flushed the whole
concatenated pile — the 上一指令 card and the tester chat drilldown showed
"我 我也 我也看到 我也看到你的 …" walls of text. The newest hypothesis now
REPLACES the turn text (`server/providers/doubao.ts`), matching the
replacement semantics clients and the stats merge already use; the wake
window latches once opened, so gating is unaffected. New end-to-end
regression test streams three cumulative hypotheses and asserts the final
turn is exactly the last one.

Note: previously recorded sessions keep their garbled rider text in the
testing history — clear the affected tester (or session) from the admin
panel to drop them.

## 2026-07-04 — Web visor: sound-wave visualizer replaces the LED segment strip

The nine chunky "LED teeth" on the helmet visor are now a 27-bar waveform
(`src/components/HelmetVisual.tsx`): thin bars whose amplitudes follow a bell
envelope with a deterministic ripple. While **Max replies**, a CSS travelling
wave rolls through the bars (one shared keyframe phase-shifted per bar with
negative delays, each bar peaking at its own `--amp`); while the **rider
talks**, the bars are driven live by the mic level as before; while Max
**thinks**, the same phase trick at low amplitude reads as a scanning shimmer;
at rest it settles into a faint flat line. `prefers-reduced-motion` holds a
steady mid-height instead of animating. All four states verified in a real
browser (screenshots of travelling crest at two phases, shimmer, and idle).

## 2026-07-04 — Native in-app login for iOS and Android

Riders sign in with the same username/password as the web platform, right in
the apps — no more copying session tokens between devices. Verified:
`swiftc -parse` clean on all four changed Swift files, Android
`compileDebugKotlin` + unit tests green.

### Added

- **AuthClient** (`ios/.../Agent/AuthClient.swift`,
  `android/.../agent/AuthClient.kt`) — POSTs `/auth/login` / `/auth/logout`
  against the relay, deriving the HTTP base from the relay WebSocket URL
  (ws→http, wss→https) and honoring the self-signed trust toggle exactly like
  the socket. Relay error messages (wrong password, rate limited) surface
  verbatim.
- **设置 → 账号 section** on both platforms — logged out: username/password
  inline form; logged in: identity row (显示名 · @username · 管理员/测试员)
  with 退出登录. On success the session token lands in the existing
  `authToken` setting, so the WebSocket connect, reconnects, and
  settings-change restarts all just work; the manual 认证令牌 field stays as
  the operator fallback. Logging out stops an active hands-free session (its
  authorization just ended) and invalidates the relay session best-effort.
- **401 auto-recovery** — the session state grew `authRequired`; when the
  relay refuses the upgrade with 401 and nobody is signed in, the settings
  sheet opens automatically on the 账号 section, and the status line now says
  "需要登录：在设置的「账号」里登录" instead of pointing at the token field.

## 2026-07-04 — Native apps: clear 401 guidance now that the relay requires login

The site-wide login gate broke anonymous native-app connections by design
(the relay refuses `/agent` without a token once accounts exist), but both
apps handled the rejection badly. iOS showed "中继拒绝连接（HTTP 401），请检查
中继地址" — pointing at the address when the fix is a token; Android ignored
the HTTP response entirely and burned six reconnect attempts against a hard
401 before a generic failure line.

- **iOS** (`AgentSession.swift`): a 401 upgrade rejection now shows
  step-by-step guidance — log in on the web HUD, tap 复制令牌（App 用）,
  long-press the Max logo, paste into 认证令牌 — and does not retry.
- **Android** (`AgentSession.kt`): `onFailure` now passes the HTTP response
  code through; any non-101 upgrade rejection stops the retry loop and shows
  the same 401 guidance / generic status message as iOS.
- Both settings sheets relabel 认证令牌 from "可选" to "网页「复制令牌」获取",
  and the README troubleshooting table gains the 401 row.

Verified: `swiftc -parse` clean, Android `compileDebugKotlin` green. (No
Xcode on this Mac — iOS build/UI verification happens on the dev machine.)

## 2026-07-04 — Invites, admin account management, App token copy, futuristic login

174 tests green (3 new), tsc/eslint/prettier clean, production build verified;
full invite round trip (create → link → invited registration → consumption →
tester deletion) verified live in a real browser.

### Added

- **Single-use invite links** — admins onboard testers while
  `AUTH_REGISTRATION=off` keeps strangers out. `POST /auth/admin/invites`
  mints a 7-day, single-use code; the tester opens `/?invite=inv_…`, the login
  gate switches to registration with an invited hint, and the code is consumed
  by the registration it admitted (expired/revoked codes are refused).
- **账号管理 admin block** on the testing panel — lists all accounts (role,
  last login), generates/copies/revokes invites, and deletes tester accounts
  with the two-step confirm (sessions die with the account; admins can never
  be deleted, so the relay can't end up administered by nobody).
- **复制令牌（App 用）** on the account bar — copies the login session token
  for pasting into the iOS/Android 认证令牌 field, so native apps connect with
  a personal session instead of a shared operator secret.
- **Futuristic login page** — drifting aurora orbs, panning perspective grid,
  pulsing horizon line, breathing helmet logo, glowing card border with a
  periodic scanline sweep, animated status dot, and glow focus states. All
  pure CSS, fully disabled under `prefers-reduced-motion`.

## 2026-07-04 — Site-wide login gate: the whole HUD (and the voice line) now requires an account

**Follow-up (same day):** the login page now ALWAYS comes first, like a normal
website — on a fresh relay (zero accounts) it shows first-run admin
registration ("首次使用：注册第一个账号，该账号将成为管理员") instead of booting
into the open HUD with the register form buried in the testing panel, which
proved unfindable in practice. The relay-side open mode (WS, stats) with zero
accounts is unchanged.

171 tests green (1 new), tsc/eslint/prettier clean, production build verified,
full register → logout → gate → login round trip verified in a real browser.

### Added

- **Full-screen login page** (`src/components/LoginGate.tsx`) — once any
  account exists on the relay, unauthenticated visitors see a branded login
  card instead of the HUD, like a normal authenticated website. Registration
  is offered on the same card while `AUTH_REGISTRATION=on`. Auth state now
  lives in `App` (shared by the gate and the testing panel); the login/register
  form is one component (`AccountForm`) reused by both the gate and the
  panel's bootstrap register bar.
- **The gate is enforcement, not decoration** (`server/auth.ts`) — the
  `/agent` WebSocket now refuses anonymous connections as soon as the first
  account exists (previously it only required a token when `RELAY_AUTH_TOKEN`
  was set), so hiding the UI can't be bypassed by talking to the relay
  directly. Session tokens and the relay token both satisfy the gate; with
  zero accounts and no relay token the relay stays plug-and-play open.

### Changed

- Logging out stops the mic and closes the relay socket (the session that
  authorized it just ended) before dropping back to the gate; `disconnect` is
  now part of the agent hook's public surface.

## 2026-07-04 — User accounts: registration, login, roles, and gated admin actions

170 tests green (9 new), tsc/eslint/prettier clean, production build verified.

### Added

- **User accounts, dependency-free** (`server/accounts.ts`) — register/login
  with scrypt password hashing (node:crypto, per-user salt, timing-safe
  compares), opaque `sess_…` tokens with a configurable lifetime
  (`AUTH_SESSION_DAYS`, default 30), persisted to
  `~/.horizon-helmet-testing/accounts.json` with atomic write-then-rename on a
  serialized queue (mode 0600). The **first** registered account becomes the
  admin; later accounts are testers. Login failures return one uniform message
  so responses don't reveal which usernames exist, and unknown-user logins
  still run a dummy scrypt so timing doesn't either.
- **Endpoints** (`server/index.ts`) — `POST /auth/register`,
  `POST /auth/login` (both rate-limited to 10 attempts/min per client IP,
  independent of the upgrade limiter), `POST /auth/logout`, `GET /auth/me`.
  `AUTH_REGISTRATION=off` closes self-registration after onboarding.
- **Auth-aware gates** (`server/auth.ts`) — registering the first user turns
  authentication on: the `/health` `testing` block then requires a login
  session or the relay token; `/testing/clear` requires an **admin** login
  (the relay token remains the operator master key); and on token-protected
  relays a session token satisfies the `/agent` WebSocket gate, so testers
  never need the shared secret. With zero users and no relay token, nothing
  changes — the plug-and-play internal mode is preserved.
- **Web account bar** (`src/components/AccountBar.tsx`) — login/registration
  form on the testing panel (register-first flow when no accounts exist,
  labeled 注册第一个账号（管理员）), logged-in identity chip with role and
  logout. Logging in adopts the account name as the Tester ID so QA stats tie
  to the account, refreshes the dashboard immediately, and the session token
  automatically rides the health poll, clear requests, and the `/agent`
  WebSocket (`src/lib/auth.ts`). When stats are locked, the panel explains
  instead of showing an empty dashboard, and clear buttons disable for
  non-admins.

## 2026-07-04 — Testing admin panel: clear per tester / per session / all, dashboard extraction

161 tests green (5 new), tsc/eslint/prettier clean, production build verified,
endpoint auth smoke-tested live.

### Added

- **`POST /testing/clear`** (`server/index.ts`, `server/metrics.ts`) — the QA
  stats were append-only; conversations could be viewed and exported but never
  removed. Three scopes: `tester` (aggregates + transcript drilldown + session
  replays for one `testerKey`), `session` (one completed session, keeping the
  owning tester's lifetime traffic counters), and `all` (everything including
  the timeline buckets). Clears apply to memory and to the durable history
  file, which is rewritten atomically (write-then-rename) on the same
  serialized queue as appends so a clear can't interleave with a session
  summary landing. Access follows the same rule as viewing the stats: open on
  token-less internal relays, token-required (query or Bearer) once
  `RELAY_AUTH_TOKEN` is set. Clearing a tester with a still-open live session
  leaves the voice session running — it just stops being tracked.
- **Admin controls on the web testing panel** — 清除全部 in the panel header,
  清除此测试员 beside the conversation drilldown, 删除会话 beside the session
  replay export. All destructive buttons use a two-step arm/confirm (first
  click arms for 4 s, second executes) instead of a blocking dialog, refresh
  the dashboard immediately via the new `refreshHealth`, and surface a notice
  when the relay refuses (missing token).

### Changed

- **Testing dashboard extracted from `App.tsx`** into
  `src/components/TestingAdminPanel.tsx` (~430 lines moved). `App.tsx` drops
  from 925 to ~420 lines and now only composes panels; the tester-lookup
  helper is shared via `currentTesterSnapshot` in `src/lib/utils.ts` instead
  of duplicated. Vite dev proxy forwards `/testing` alongside `/health`.

## 2026-07-04 — Review sweep: statistics-framework hardening, wake-scoring parity, client races

Full-project review (relay, shared modules, web client) with fixes applied
together: 156 tests green (16 new), tsc/eslint/prettier clean, production
build verified.

### Security

- **Testing stats on `/health` are token-gated** — the new QA block carries
  tester IPs, regions, and full chat transcripts, and `/health` is
  unauthenticated by design. When `RELAY_AUTH_TOKEN` is set, the `testing`
  block is now included only for callers presenting the token (`?token=…` or
  `Authorization: Bearer …`, timing-safe compare in
  `server/auth.ts testingStatsAuthorized`); liveness fields stay open so the
  one-curl deployment check keeps working, and the open no-token internal mode
  is unchanged. The web HUD sends its stored token with the health poll, so
  the dashboard works on protected relays.

### Fixed

- **Tester accounting under load** (`server/metrics.ts`) — creating tester
  #51 while 50 were busy evicted the just-created record (trim ran before the
  session was marked active), which orphaned the session in the active map
  forever and dropped its completed summary. Trim now runs after activation,
  `endTesterSession` removes the session unconditionally and builds the
  summary from identity denormalized onto the session, and
  `AgentSessionController.close()` settles the stats in a `finally` so a
  provider close failure can't leave a phantom active session.
- **Durable history replay** (`server/metrics.ts`) — the loader counted the
  file's trailing newline as a line (silently losing the oldest retained
  session at the cap) and one corrupt line (partial write from a crash)
  discarded every session recorded after it. Blank lines are filtered before
  the cap slice and each line parses in its own try/catch. The append path is
  now async (serialized queue) instead of `appendFileSync` inside the
  WebSocket close handler, and a file grown past 4× the cap is compacted at
  startup via write-then-rename.
- **Wake-word scoring parity** (`server/testing-evaluator.ts`) — the
  evaluator's private regex accepted only literal "max"/"麦克斯" while the live
  gate accepts the full variant list ("mack", 马克斯, 迈克斯, …), so
  correctly-gated sessions scored as deterministic wake-word failures in the
  exact campaign built to catch regressions. It now calls
  `containsWakePhrase` from `shared/wake.ts` (which also stops counting
  false friends like 麦克斯韦). Negated safety phrasing ("don't speed up",
  不要看手机) no longer trips the unsafe-advice check.
- **Rider utterances no longer merge in the drilldown**
  (`server/providers/doubao.ts`) — rider transcripts were only ever emitted
  non-final, so two separate utterances with no agent turn between them
  (exactly the suppressed-reply case) merged and destroyed the earlier text
  in the tester chat history. `AsrEnded` now flushes the accumulated turn as
  a final rider transcript, once per turn.
- **Guided-demo hazard injector leak** (`server/providers/mock.ts`) — turning
  the guided tour off during its ADAS chapter left alerts firing every 5 s;
  the injector is now stopped and, if hands-free is still running, restarted
  at the normal per-scenario cadence.
- **Event validation gaps** (`shared/events.ts`) — `hazard.alert`
  threat/direction are validated against the canonical catalogs (new
  `ADAS_THREATS`/`ADAS_DIRECTIONS` exports); `session.started` builds a
  sanitized capabilities object instead of blind-casting the record; numeric
  Open-Meteo `is_day: 0` no longer renders night as day; `session.memory`
  destination is clamped by code point to the shared 64-char cap.
- **Session language no longer thrashes** (`shared/session.ts`) — one short
  Latin token ("OK", "yes") flipped a Chinese session's prompt and TTS voice
  to English until the next Han turn; the preference now switches to English
  only on distinctly English speech. 风格 (style) and 中风 (stroke) no longer
  classify as weather; memory-snapshot destinations truncate by code point so
  a surrogate pair can't be bisected into the prompt.
- **Web client races** (`src/`) — a second Space press/button click during
  the multi-await hands-free startup now stops the session instead of
  launching a parallel start (the old path inverted the rider's intent and
  double-sent `audio.start`); `releaseMic` during an in-flight mic setup no
  longer resurrects a live MediaStream and AudioContext nobody will stop
  (stuck mic indicator); the WebSocket message handler gained the same
  stale-socket guard as close/error so a superseded session can't play PCM
  into the new one; the playback context is created inside the user gesture
  (before the location/socket/permission awaits) so Safari doesn't mute the
  first reply; barge-in status ("已打断 Max") only shows when agent speech was
  actually cut; a frames-only metric no longer zeroes the latency readout;
  empty PCM frames can't resurrect a closed AudioContext; restored transcript
  rows re-derive a missing `language` instead of rendering Chinese as "EN";
  clearing the Tester ID field mid-edit no longer burns the tester's stats
  continuity on reload.

### Changed

- Health polling pauses while the tab is hidden and refreshes immediately on
  return; dropped-frame stats update at most once a second during reconnect
  backoff (was one render per 20 ms frame); a pending reconnect timer is
  cleared once a connection opens; the five duplicated settings-persistence
  blocks in `useHelmetAgent` collapsed into one `persistSettings()` helper.

### Tests

- New: `tests/testing-history.test.ts` (trailing-newline cap, corrupt-line
  resilience, startup compaction — fresh module import per case). Extended:
  auth (`testingStatsAuthorized`), metrics (gated `/health`, 51-concurrent-
  tester accounting), evaluator (live-gate wake variants, 麦克斯韦 false
  friend, negated advice), events (unknown threat/direction, capabilities
  sanitization, numeric `is_day`, destination clamp), session (language
  stickiness, 风格/中风).

## 2026-07-03 — Roadmap: wake-chain cap, mid-ride location, live captions, event validation

The five improvements queued by the morning's review, implemented together:
132 tests green (17 new), tsc/eslint clean.

### Added

- **Mid-ride location updates** (`location.update` client event) — the
  session-start coordinates went stale fast on a moving bike, so the "live"
  weather was for the start point. The web HUD now watches geolocation while
  hands-free is active and sends throttled updates (≥60 s apart, ≥250 m of
  movement); the relay validates them (`server/session-controller.ts`), keeps
  the periodic weather refresh pointed at the current position, and refetches
  immediately when the rider has moved ≥20 km (`approxDistanceKm` in
  `shared/ride.ts`). Native clients speak the same protocol; wiring their
  location watchers is follow-up work.
- **Live agent captions** (`server/providers/doubao.ts`) — each Doubao TTS
  sentence now streams a non-final agent `transcript` event, so captions appear
  while Max is speaking instead of all at once at reply end. All three clients
  already merge non-final items in place and the TtsEnded flush finalizes the
  entry, so no client changes were needed (native TTS gates on
  `useBrowserSpeech ?? final`, which partials never set).
- **Shared event validation** (`shared/events.ts`) — `validateAgentEvent`
  admits a relay event only when every field the clients dereference is
  present and well-typed, sanitizes optional numerics (a missing hazard TTC
  becomes 6 s instead of NaN), and ignores unknown event types so older
  clients tolerate newer relays. The web client now validates instead of
  blind-casting `JSON.parse(...) as AgentEvent`.

### Changed

- **Wake follow-up window is now capped** (`shared/wake.ts`
  `WAKE_FOLLOWUP_MAX_CHAIN_MS`) — the 12 s window still slides on every turn
  inside it, but never extends past 60 s after the last explicit "Max".
  Previously any speech that produced a turn at least every 12 s (passenger
  chatter, intercom) kept the agent answering everyone indefinitely.
- **Wake suppression is now a fast path** — once a turn is decided
  unaddressed, the reply-stream frames (chat tokens, TTS sentences, voice
  audio) are dropped before any JSON parsing. Doubao synthesizes the full
  reply regardless (the protocol exposes no cancel), but the relay does no
  work on it. Suppressed turns also end with a quiet return-to-"listening"
  status instead of the misleading "TTS 未返回音频，浏览器备用" warning, and no
  longer emit latency telemetry (both pre-existing noise).

### Tests

- New end-to-end wake-gating suite (`tests/doubao-wake.test.ts`) driving the
  provider through a mock upstream: unaddressed suppression (no audio, no
  transcript, no telemetry, clean status), addressed reply with streamed
  captions, follow-up-without-name, the 60 s chain cap, a barge-in regression
  for yesterday's fallback-timer fix, and distance-gated weather refetch on
  `location.update`. Plus validator coverage (`tests/events.test.ts`) and
  `location.update` parsing in `tests/websocket.test.ts`.

## 2026-07-03 — Bug sweep: barge-in turn state, hot-mic teardown paths, intent/wake accuracy

A four-track review (relay, web, shared logic, native clients) with every
finding verified against the code before fixing. TypeScript: 115 tests green,
tsc/eslint clean; Android compiles; the iOS edits are parse-checked (no Xcode
on this machine — needs a build + device pass).

### Fixed — relay

- **Barge-in corrupted the next turn** (`server/providers/doubao.ts`) — a new
  rider turn (`AsrInfo`) reset the latency anchors but not the pending reply:
  the previous turn's TTS-fallback timer stayed armed, fired mid-turn, spoke
  the stale reply via browser speech, and set `fallbackSpoke` — silently
  dropping ALL of the new turn's real Doubao audio. The turn reset now clears
  the timer, flushes a partially spoken reply to the transcript (without
  re-speaking), and resets the pending text/audio flags.
- **Doubao error frames were unreadable** (`parseDoubaoFrame`) — `ErrorInformation`
  (0b1111) frames use a different layout (code + payload, no session-id
  section), so parsing them with the standard layout always threw and the real
  error (auth/quota/protocol) was reduced to a cryptic status. They now parse
  into `errorCode` + payload, log at error level, count as upstream failures,
  and reach the client as a proper `error` event.
- **Duplicate StartSession after in-place reconnect** — the `ConnectionStarted`
  handler suspends on the weather fetch and then checked the shared `upstream`
  variable, so a stale continuation from a dropped socket could double-send
  `StartSession` on the replacement connection. Handlers now verify they still
  own the current socket.
- **Compressed frames now rejected up front** with a descriptive error instead
  of failing at `JSON.parse` on every frame; **client-abort during handshake**
  no longer counts as an upstream failure on `/health`; **TTS sentence dedupe**
  compares against the previous sentence instead of `includes()` over the whole
  reply (which dropped legitimately repeated text); **per-chunk status spam**
  (one "thinking"/"speaking" status per token/audio chunk) coalesced to one per
  transition; **`PORT`** is now bounded like every other numeric env var
  (`PORT=""` used to bind a random port); **mock provider** cancels its staged
  turn timeouts on `audio.stop` (they used to report "speaking/listening" up to
  2.15 s after the mic stopped).

### Fixed — web

- **Idle-close (4001) left the mic hot** (`useHelmetAgent.ts`) — the branch
  reset the UI but not `transmittingRef`/the track, so the mic kept capturing
  and every 20 ms frame burned a dropped-frame state update (~50 HUD re-renders
  per second) until the rider toggled hands-free. Both the idle-close and the
  reconnect-exhausted branches now run `stopMic()` (the exhausted branch also
  left the mic button stuck on "结束免提").
- **Double-start leaked a live mic** (`useMicCapture.ts`) — two rapid start
  triggers (double Space press / double-click) both passed the null-ref check
  and both called `getUserMedia`; the loser's MediaStream was never stopped
  (browser mic indicator stayed on) and both worklets streamed duplicate frames,
  garbling ASR. Setup is now a shared in-flight promise.
- **Duplicate agent finals restarted speech** — `speak()` begins with
  `speechSynthesis.cancel()`, so a duplicate final mid-utterance audibly
  restarted the reply; speak now applies the same 8 s dedupe the transcript
  already used. Also: malformed `hazard.alert` TTC no longer flash-dismisses
  the safety banner (`NaN` timeout fired immediately); a hazard while hands-free
  is off no longer wedges the caption at "Max 回答中"; a superseded socket's
  `error` event no longer flips the fresh session to "degraded"; the "switching
  voice…" status resolves when no session restart happens; transcript
  persistence is debounced (was a synchronous localStorage write per partial
  ASR revision).

### Fixed — shared logic

- **Emergency intent missed the most common crash phrasings** (`shared/session.ts`)
  — 摔倒/车祸/受了伤/fell/hurt/injured/accident now escalate; previously a rider
  saying 我摔倒了 got casual-mode handling.
- **Intent keywords matched inside unrelated words** — "rain" in **train**,
  "tire" in **tired**, "eta" in **details**, "wind" in **window**, 风 in 麦克风
  all misclassified; Latin keywords are now whole-word and 风 excludes 麦克风.
  Navigation now outranks weather for mixed asks.
- **Garbage destinations stuck in memory** — 到/回 are everyday verb
  complements (听到/迟到), so 我听到异响 set `目的地：异响` in the prompt for
  the rest of the ride. Destination capture now only runs on navigation-shaped
  turns, stops at fullwidth punctuation, and caps English places at the phrase
  instead of a mid-word 28-char cut.
- **Stale emergency snapshot pinned emergency verbosity** — a settings toggle
  hours after 报警 restored command-style replies while parked; restore now
  re-derives verbosity from the current ride mode only.
- **Wake word fired inside 马克思主义 (Marxism) and 麦克斯韦 (Maxwell)** — both
  false friends are excluded before matching (`shared/wake.ts`), each previously
  opened the 12 s answer-everything window.
- **Outgoing FPS was inflated by one** (`shared/audio.ts`) — the window's anchor
  frame contributes no elapsed time but was counted in the rate (a true 50 fps
  reported 51); the old test pinned the buggy value and has been corrected.

### Fixed — native clients

- **Android: malformed relay URL crashed the app** — the free-text server
  address reached `Request.Builder().url()` inside a coroutine with no handler;
  a scheme-less or blank URL now degrades with 中继地址无效 instead of killing
  the process (iOS already guarded its parse).
- **Both: ending hands-free during a settings-change restart resurrected the
  session** — the 150 ms deferred reconnect wasn't cancellable and clobbered
  `intentionalClose`, opening a zombie session (with its own reconnect loop)
  after `stop()`. The deferred reconnect is now cancelled by `stop()` and
  re-checks `handsFree`.
- **Both: idle-close (4001) left the mic, audio route, and "listening" orb
  alive indefinitely** — native clients now end hands-free entirely on 4001,
  mirroring the web fix.
- **iOS: mic frames could be delivered ahead of `session.start`** —
  URLSession queues sends while connecting, so restart-window frames violated
  the handshake order; frames are now gated on the same `socketOpen` flag
  Android uses.

### Tests

- +10 regression tests: crash-phrasing and keyword-collision intent cases,
  verb-complement destination cases, the stale-emergency restore, wake-word
  false friends, true-FPS at the real 20 ms cadence, Doubao error-frame
  parsing, and compressed-frame rejection.

## 2026-07-02 — Web: transcript fills the gap beside the status column

### Fixed

- **Huge dead space between the helmet panel and the transcript** (`src/styles.css`)
  — the auto-fit change capped the helmet panel's height, but the grid's first
  row was still as tall as the much longer status column and the transcript
  spanned full-width _below_ it, leaving up to ~1000 px of empty page between
  the start button and the conversation. The grid now uses named areas: helmet
  and transcript stack in the left column while the status column spans both
  rows, and the transcript row flexes to absorb the leftover height (message
  list scrolls inside it, cards keep natural height via `align-content: start`).
  Single-column layouts (≤900 px) stack helmet → status → transcript as before,
  with the list's height cap restored there.

## 2026-07-02 — Roadmap sweep: watchdog, upstream self-healing, memory continuity, native parity

Six improvements from the post-review roadmap, focused on making live sessions
self-maintaining (leaked slots reclaimed, dropouts healed in place, memory kept
across restarts) and on closing the remaining web ↔ native feature gaps.

### Added

- **Relay session watchdog** (`server/watchdog.ts`, `RELAY_HEARTBEAT_MS`,
  `RELAY_IDLE_TIMEOUT_MS`) — the relay now pings every `/agent` client and
  terminates half-open links that stop ponging (a phone that lost signal used to
  hold its Doubao upstream slot forever), and closes sessions with no client
  traffic for the idle window (default 10 min) so a forgotten tab releases its
  slot too. Idle closes use the new shared close code **4001**
  (`IDLE_CLOSE_CODE`); web, iOS, and Android all treat it as intentional and
  stay offline instead of auto-reconnecting (which would defeat the timeout).
- **Doubao upstream self-healing with context replay** (`server/providers/doubao.ts`)
  — when the upstream socket drops mid-session, the relay now reconnects it in
  place (3 attempts, 0.5/1/2 s backoff) and replays the full persona plus the
  live session memory with a 会话恢复 addendum telling the agent it's the same
  conversation — dropouts become a status blip instead of a lost session. Only
  after retries are exhausted does it fall back to bouncing the client socket.
  Also fixed: a failed Doubao handshake (`unexpected-response`) used to leave
  the upstream stuck in CONNECTING forever; the request is now destroyed so the
  close/retry path runs.
- **Session memory across restarts** (`shared/agent.ts` `SessionMemorySnapshot`,
  `shared/session.ts` `restoreSessionMemory`) — voice/personality/mode toggles
  restart the relay session, which used to wipe the agent's short-term memory.
  All three clients now echo the last `session.memory` event back in
  `session.start`; the relay validates the snapshot (enums, destination length)
  and re-derives the response mode from the current ride mode. Covered by
  parser and restore tests.
- **Relay metrics on `/health`** (`server/metrics.ts`) — active/total sessions,
  rejected upgrades, upstream failures and in-place reconnects, TTS-fallback
  count, and watchdog closes, so the Lightsail deploy can be checked with one
  curl. Counters reset with the process; `uptimeSec` says when that was.
- **iOS/Android: ride-intelligence panel** — the settings sheet now surfaces the
  live weather (temperature, condition, wind, risk level, advice), route phase,
  speed, battery, and the session-memory chips (language, response mode, last
  intent, destination) that both clients already parsed but never displayed —
  reaching web-HUD parity.
- **iOS/Android: guided demo ride** — both native clients can now toggle the
  mock provider's scenario tour (`demo.guided`), shown only when the relay
  reports the mock provider, and re-send it when a fresh session opens —
  matching the web behavior.

### Docs

- `.env.example` documents `RELAY_HEARTBEAT_MS` / `RELAY_IDLE_TIMEOUT_MS`; the
  README client-resilience section covers the watchdog, upstream self-healing,
  memory continuity, and the `/health` metrics object.

### Follow-up (same day)

- **`/health` trailing-window rates** (`server/metrics.ts`) — a per-minute
  snapshot ring buffer adds a `metricsWindow` object (counter deltas over the
  trailing 15 min, window shrinks gracefully right after startup), so one curl
  distinguishes "failed a lot last month" from "failing right now".
- **Android: mic survives transient capture glitches** (`MicStreamer.kt`) — a
  single `AudioRecord.read()` returning 0 used to end capture for the rest of
  the session; empty reads now back off briefly (~0.5 s budget) and error codes
  get one in-place stop/startRecording recovery before giving up.
- **Startup log duration display** — sub-minute idle timeouts printed as
  "0 min"; durations under a minute now print in seconds.
- **Live verification pass** — end-to-end WebSocket smoke test against the
  running relay (session start, memory-snapshot echo, watchdog idle close 4001
  with courtesy status, metrics counters) plus manual browser and iOS-simulator
  runs: mock conversation, ADAS banners, per-turn telemetry, memory chips
  surviving a voice-switch restart, the new iOS 骑行情报 panel with live relay
  data, and the native 巡游 guided tour advancing scenarios.
- **Android emulator pass + settings-sheet scroll fix** (`ui/AgentScreen.kt`) —
  the same live verification on the Android emulator (session against the local
  relay, ADAS banners, 骑行情报 panel, 巡游 tour advancing 通勤 → 横风, memory
  chips surviving a voice-switch restart). The pass surfaced a real bug: the
  settings bottom sheet's content column wasn't scrollable, so on short or
  landscape screens (tablets) the 巡游 row and the whole 诊断 card were simply
  unreachable — the sheet now scrolls vertically.

## 2026-07-02 — Session-resilience sweep across relay, web, iOS, and Android

A cross-platform review pass: every confirmed finding is a session-lifecycle or
audio-ordering bug rather than a feature gap — a zombie relay session after an
upstream drop, a wake lock that never came back, agent audio lost around
permission prompts, and mic audio that could outrun the session handshake.

### Fixed

- **Relay: dead Doubao upstream left a zombie session** (`server/providers/doubao.ts`)
  — when the upstream socket dropped mid-session, the relay kept the client
  connection open even though the provider can never be restarted on it
  (`start()` runs once per session): the rider's mic kept streaming into the
  pending buffer forever and nothing recovered without a page refresh. The relay
  now closes the client socket (1011) when the upstream dies, so every client's
  existing backoff reconnect rebuilds a fresh session (`session.start` +
  `audio.start`) automatically. Regression test included.
- **Web: screen wake lock was never re-acquired** (`src/hooks/useHelmetAgent.ts`)
  — the browser auto-releases the Wake Lock whenever the tab is hidden, but the
  released sentinel was kept, so the `visibilitychange` re-acquire path saw a
  "held" lock and never requested a new one; after the first backgrounding the
  screen could lock mid-ride. The sentinel now clears itself on the lock's
  `release` event, letting the re-acquire logic actually run.
- **iOS: agent audio dropped before the mic engine started** (`ios/…/PcmPlayer.swift`,
  `AgentSession.swift`) — `PcmPlayer.play()` discarded PCM while the shared
  `AVAudioEngine` wasn't running, and the engine only starts after the async
  mic-permission grant — so the agent's opening words during the first-launch
  permission dialog were silently lost. Early PCM is now held in a bounded
  (~5 s) buffer, flushed once `MicStreamer` starts the engine; barge-in and
  release clear it.
- **Android: mic frames could reach the server before `session.start`**
  (`android/…/AgentSession.kt`) — `onFrame` sent PCM without checking that the
  socket was open, and OkHttp buffers pre-open sends, so audio captured while
  the socket was still connecting was flushed _ahead of_ the `session.start` /
  `audio.start` that `onOpen` enqueues (the web client already drops such
  frames). A `@Volatile socketOpen` gate now only admits frames after the
  handshake events are queued; `webSocket` itself is also `@Volatile` for the
  mic-thread read.
- **Relay: stale pre-session mic audio replayed after mute** (`server/providers/doubao.ts`)
  — frames buffered while the upstream session was still starting were kept
  after `audio.stop`, so a later `SessionStarted` flushed audio from a mic
  stream the rider had already ended. The buffer is cleared on `stopAudio`.
  Regression test included.
- **Mock: telemetry `totalMs` grew without bound** (`server/providers/mock.ts`)
  — it reported time since `audio.start` rather than a per-turn total, so the
  HUD's 总计 reading climbed into the hundreds of seconds over a demo. Now the
  per-turn sum, matching the live path's semantics.
- **Relay: minor status/telemetry polish** (`server/providers/doubao.ts`) —
  `AsrEnded` no longer claims "豆包回复已完成" (it now reports ASR completion),
  and turns that finish via the browser-TTS fallback emit `telemetry` too.

### Docs

- README client-resilience section documents the upstream-death recovery path
  and the wake-lock re-acquire behavior.

## 2026-07-01 — Web auto-fit, weather/audio startup fix, relay limiter hardening

A review pass with three focused fixes: the web HUD always shows the start
button, the live path no longer clips the rider's opening words, and the per-IP
rate limiter behaves correctly (and safely) behind the production reverse proxy.

### Fixed

- **Web: start button always visible (auto-fit cockpit)** (`src/styles.css`) —
  the helmet panel shared a CSS grid row with the much taller status column and
  was stretched to match it, pushing the mic/start button ~1200 px down (below
  the fold on any laptop). The grid columns now top-align, and the helmet panel
  takes a viewport-relative height (`clamp` on `100dvh`) with a `minmax(0, 1fr)`
  helmet row so the helmet letterboxes/shrinks and the button stays on screen on
  load — verified across desktop, short-laptop, and mobile widths, with a
  `max-height` media query for very short viewports.
- **Live path dropped the rider's first words** (`server/providers/doubao.ts`) —
  `start()` awaited the Open-Meteo fetch (up to 4 s) _before_ opening the Doubao
  connection, so the ~5 s pre-session window outlasted the 3 s pending-audio
  buffer and the opening utterance was clipped. The weather fetch now runs
  **concurrently** with the connection handshake and only gates `StartSession`
  (so live weather still lands in `system_role`), and the pending-audio buffer is
  sized to 5 s. Net: ~5 s → ~4 s startup with the buffered audio fully retained.
- **Rate limiter collapsed / was spoofable behind the proxy** (`server/auth.ts`,
  `server/config.ts`) — two problems in the documented Caddy/Lightsail topology:
  (1) with `RELAY_TRUST_PROXY=off` every client counted as the proxy's socket
  address, turning the per-IP limit into a single global bucket that could lock
  all riders out at once; (2) even with trust on, `clientAddress` read the
  _leftmost_ `X-Forwarded-For` entry, which the client can forge. The relay now
  reads the real client IP `RELAY_TRUSTED_PROXY_HOPS` entries from the **right**
  (default 1 = single Caddy), warns at startup when the Doubao backend runs with
  the limiter on but proxy trust off, and prints the resolved proxy-trust state.
- **Rate limiter is now a true sliding window** (`server/auth.ts`) — it had reset
  fully every 60 s (a fixed window allowing a ~2× burst across the boundary)
  despite every doc calling it "sliding." Replaced with a sliding 60 s timestamp
  log, so the implementation finally matches the documentation.

### Added

- **First `createDoubaoProvider` session tests** (`tests/doubao-session.test.ts`)
  — cover the previously-untested live path with a mock upstream socket and a
  gated weather fetch: the connection opens concurrently with the fetch,
  `StartSession` waits for and folds in the weather, and mic frames buffered
  during startup are flushed rather than dropped.
- **Relay proxy/limiter tests** (`tests/auth.test.ts`) — right-anchored
  `X-Forwarded-For` parsing (including spoofed-leftmost and multi-hop), trust-off
  ignoring the header, and sliding-window partial-expiry behaviour.
- **`RELAY_TRUSTED_PROXY_HOPS`** — number of trusted reverse-proxy hops (default
  1); only consulted when `RELAY_TRUST_PROXY=on`.

### Docs

- `.env.example` and the README relay-security section document
  `RELAY_TRUST_PROXY` / `RELAY_TRUSTED_PROXY_HOPS`, the proxy-collapse caveat, and
  the sliding window; the README weather and client-resilience notes now cover the
  concurrent startup fetch and the auto-fit HUD.

## 2026-06-10 — Hardening & roadmap sweep

One pass over the improvement backlog: relay security, fresher ride context,
debuggable server, and quality-of-life features across all three clients.

### Added

- **Relay security** (`server/auth.ts`) — the `/agent` WebSocket upgrade can now
  require a shared token (`RELAY_AUTH_TOKEN`, sent as `?token=…`; constant-time
  compare), enforce a browser Origin allowlist (`RELAY_ALLOWED_ORIGINS`), and
  rate-limit upgrade attempts per client IP (`RELAY_CONN_PER_MINUTE`, sliding
  window). All three layers are optional so the local demo stays plug-and-play;
  running `VOICE_PROVIDER=doubao` without a token logs a startup warning. The web
  HUD picks the token up once from `?token=…` in the page URL and remembers it;
  iOS/Android get a 认证令牌 field in Settings.
- **Mid-ride weather refresh** — live sessions re-fetch Open-Meteo on an interval
  (`WEATHER_REFRESH_MS`, default 10 min) and push the update to the HUD, so a long
  ride no longer shows the session-start snapshot. (The Doubao system prompt is
  fixed per session; the agent's own context freshens on the next session.)
- **Structured per-session server logging** (`server/logger.ts`) — timestamped,
  level-filtered (`LOG_LEVEL`) lines tagged with a short session id cover the
  whole relay lifecycle: connects/rejections, Doubao session state, turn
  telemetry, TTS fallbacks, weather refreshes, errors.
- **Guided demo ride** — a `demo.guided` client event makes the mock provider
  tour every scenario automatically (commute → wind → fuel → group → ADAS →
  emergency, ~14 s per chapter) with HUD context, weather, and hazards following
  along; the web HUD gets a ▶ 巡游 toggle next to the scenario strip (mock
  provider only).
- **Transcript persistence** — web (localStorage), iOS (UserDefaults), and
  Android (SharedPreferences) keep the most recent 200 conversation turns across
  restarts, with a 清空 (clear) action.

### Changed

- **Helmet visual reflects fused hazard** — the helmet ring/glow on all three
  clients now fuses ride-mode hazard, weather risk, and active ADAS alerts:
  amber for caution, red with an urgent ring pulse for critical, overriding the
  turn-state palette; the caption calls the danger out first.
- **Adaptive TTS-fallback timeout** — the wait for Doubao audio before the
  browser-speech fallback starts from `TTS_FALLBACK_MS` (default 1800 ms) and
  adapts upward to 1.5× the previous turn's measured first-audio latency, so
  slow links stop triggering spurious fallbacks.
- **Wake word handles CJK edge cases** (`shared/wake.ts`) — NFKC folding
  (fullwidth `Ｍａｘ`), Han↔Latin boundary splitting (`max今天路况`), and the
  Chinese name variants now match inside unspaced Han runs
  (`麦克斯今天天气怎么样`); new unit tests cover all three classes.
- **Web client refactor** — the 1,500-line `src/main.tsx` is split into focused
  modules with no behavior change: `hooks/useHelmetAgent` (session brain),
  `hooks/useAudioPlayback`, `hooks/useMicCapture`, `lib/constants`, `lib/speech`,
  `lib/utils`, `lib/persistence`, `types.ts`, and `App.tsx`; `main.tsx` is now
  just the bootstrap.

### Docs

- `.env.example` documents the new relay-security and session-behaviour knobs;
  the README Next Steps list drops everything shipped here (including the stale
  "add a wake word" item — it already shipped earlier).

## 2026-06-10 — Helmet centerpiece & unified settings

Follow-up to voice mode: the centerpiece is now the **brand helmet** instead of
the abstract orb, and every setting lives in one place again.

### Changed

- **Android: control icons match iOS** — the start / mute / end buttons now use
  Material vector icons (`Mic` / `MicOff` / `Close`, via `material-icons-extended`)
  instead of emoji glyphs, so the microphone matches iOS's SF Symbol `mic.fill`.

- **iOS & Android: helmet centerpiece** — the glowing orb is replaced by the
  brand helmet (shell + chin + visor + status dots), ported from the web
  `HelmetVisual` SVG and drawn natively (a small SVG-path parser feeds SwiftUI
  `Path` / Compose `Path`). The state-tinted halo still breathes with the turn
  state and ripples with the rider's voice, and the visor glows while Max listens
  or speaks. Tapping the helmet toggles hands-free.
- **Unified 设置 (Settings) sheet** — the gear now opens a single settings sheet
  with everything that briefly went missing: **语音** (声音 / 语气 / 模式),
  **连接** (语音中继地址 server address + 信任自签名证书 trust toggle),
  **演示场景** (demo scenarios), and **诊断** (延迟 latency, telemetry, 导出日志
  export, raw status). The separate developer-panel long-press gesture is gone —
  nothing is hidden anymore.

### Fixed

- **Helmet glow no longer clips** — the reactive halo is clamped to the canvas so
  its radial gradient fades fully to transparent before the edge; growing the glow
  no longer shows hard rectangular cuts at the top and bottom.
- **Transcript export is shareable from Settings** — on iOS the 导出日志 share
  sheet is now presented from the settings sheet (it was attached to the main
  screen, so it couldn't open while Settings was up). The JSON transcript can be
  AirDropped / saved / mailed for review from both clients.

### Docs

- **Refreshed screenshots** — the iOS and Android README galleries now show the
  voice-mode helmet (idle, live session, captions, and the unified 设置 sheet)
  instead of the old data-dense HUD; stale ring/HUD wording updated to match.

## 2026-06-10 — Voice mode

A ground-up redesign of the iOS and Android main screens into a "pure voice
mode" in the spirit of ChatGPT's voice mode: a dark, state-tinted glow with one
big animated orb at the center, a single status caption, and minimal controls.

### Changed

- **iOS & Android: pure voice-mode screen** — the data-dense HUD is replaced by a
  glowing **voice orb** that breathes with the turn state (faster while thinking),
  swells with the rider's voice level, and shows a rotating shimmer while Max
  thinks. Tapping the orb toggles hands-free. Below it sits one status caption and
  a minimal control row: a single **开始** mic button when idle, or **静音 / 结束**
  while live. (`ios/.../UI/AgentScreen.swift`, `android/.../ui/AgentScreen.kt`)
- **Optional captions (字幕)** — the conversation transcript is hidden by default
  for the clean look and revealed on demand as a rolling overlay under the orb,
  matching ChatGPT's optional captions.
- **Settings as sheets** — rider preferences (gear) and the developer panel
  (wrench, shown only in developer mode) now open as bottom sheets / detents
  instead of inline cards, keeping the main screen empty. Developer mode is still
  toggled by long-pressing the top status pill. The ADAS hazard banner still pins
  to the top on every screen.
- **New: mid-session mic mute** — a real mute that withholds rider audio while
  keeping the relay open so Max can keep speaking (`AgentSession.toggleMute()` on
  both clients).

## 2026-06-10

Relay hardening, web HUD accessibility/design polish, an iOS mic-tap fix, and a
production-clean redesign of the iOS and Android main screens.

### Changed

- **iOS & Android: production-clean main screen** — the HUD now shows only what a
  rider needs: brand header with connection dot, ADAS hazard banner, a larger hero
  ring (210 dp), a glance strip (速度 · 风险 · 天气 · 电量 with risk/weather advice
  when elevated), a chat-bubble conversation view, and a pill hands-free button.
  Rider preferences (声音 / 语气 / 模式) moved behind a gear button.
  (`ios/.../UI/AgentScreen.swift`, `android/.../ui/AgentScreen.kt`)
- **iOS & Android: test settings hidden behind a developer panel** — relay URL,
  the self-signed trust toggle, demo scenarios, latency telemetry, raw status
  text, and transcript export now live in a `开发者模式` panel revealed by
  **long-pressing the Max logo** (persisted across launches, with haptic
  feedback; the header subtitle shows `· 开发者模式` while enabled). Production
  builds look clean by default but every demo control is still reachable on any
  build. (`MainViewModel.swift` / `MainViewModel.kt` hold the persisted flag.)
- **iOS & Android theme refresh** — borderless 16 dp-radius cards on a soft
  elevated surface, capsule chips, rounded brand type (iOS), and the same
  `--muted` legibility bump as the web (`#99AAA8 → #A7B8B6`).
  (`HudTheme.swift`, `theme/Theme.kt`)

### Fixed

- **iOS mic tap leak on engine start failure** — in `MicStreamer.start()`, if
  `engine.start()` threw after the input tap was installed, `running` stayed false so
  `stop()` early-returned and never removed the tap; the next `start()` would install
  a second tap on the same bus and crash. The tap (and converter/pending buffer) are
  now cleaned up before the error is rethrown. (`ios/MaxHelmet/Agent/MicStreamer.swift`)

### Changed

- **Doubao relay hardening** (`server/providers/doubao.ts`):
  - `extractTextFields` now has a recursion depth limit (8), so a deeply nested
    upstream JSON payload can no longer overflow the stack. Regression-tested in
    `tests/doubao-frame.test.ts`.
  - Upstream JSON payloads larger than 1 MB are rejected before parsing.
  - The pre-session mic buffer (`pendingAudio`) is capped at 150 frames (3 s);
    oldest frames are dropped first, so a session that never becomes ready cannot
    grow it without bound.
  - Voice audio is no longer relayed to a client whose socket write buffer exceeds
    4 MB (backpressure guard — frames are dropped instead of queueing in server memory).
- **Web HUD design & accessibility** (`src/styles.css`):
  - Keyboard-visible focus ring (`:focus-visible`) on all buttons/inputs/links —
    previously no interactive element had a visible focus state (WCAG 2.4.7).
  - ADAS hazard direction chip is larger and bolder (1.25 rem / 800) so the
    direction dominates the banner in safety-critical moments.
  - `--muted` lightened `#99aaa8 → #a7b8b6` for better label legibility outdoors.
  - Transcript list scrolls smoothly; `prefers-reduced-motion` now also disables
    the visor visualizer bar transitions, message hover transition, and smooth scroll.

## 2026-06-08

Audio fixes across all clients, plus a "Max" wake word on the live agent.

### Changed

- **ADAS now fires on the live Doubao path, not just mock** — extracted the hazard
  injection into a shared `server/hazard-injector.ts` used by both providers. The
  Doubao provider injects the simulated hazards when the **ADAS scenario** is selected
  (other scenarios stay uninterrupted), so the alerts "happen" with the real Doubao
  voice on the deployed server. Detection is still simulated.

### Fixed

- **ADAS alert spoken twice on iOS/Android** — the warning was read by both the
  `hazard.alert` handler and the alert transcript's `useBrowserSpeech`. The transcript
  is now display-only (`useBrowserSpeech: false`) and the `hazard.alert` handler is the
  single speaker on all three clients (the web handler now speaks too).
- **iOS & Android playback harshness** — the agent voice was boosted 2× and then
  hard-clipped, making the real Doubao voice sound harsher than on the web. Added a
  per-sample soft limiter (linear below ≈-3 dBFS, smooth compression above) to both
  `PcmPlayer`s, the PCM-domain equivalent of the web's DynamicsCompressor — so all
  three clients now match. (Note:
  a robotic voice on Android usually means the app is on the **mock** relay, which
  has no real audio and falls back to device TTS — point it at the Doubao relay for
  the real voice.)
- **Doubao transcript duplication / garbled spacing** — the agent reply was
  accumulated from _both_ Doubao channels into one buffer: `ChatResponse` (raw LLM
  tokens, missing spaces — "I'mMax") and `TtsSentence` (the spoken text, properly
  spaced — "I'm Max"). The substring de-dup missed because the two differed, so
  depending on timing the transcript showed the reply twice in one entry, or as two
  entries — while the voice played once. Now the channels are kept in separate
  buffers, the transcript uses the spoken (TTS) text (matching the voice), and the
  reply flushes exactly once at end-of-speech. (`server/providers/doubao.ts`)

### Changed

- **iOS & Android: max-width centered HUD** — the single-column HUD was stretching
  edge-to-edge on wide tablet / iPad screens (controls hugging the top-left, the ring
  floating in empty space). It is now capped at ~560 dp and centered, so it reads as
  a phone-width column on large screens — matching the web's centered shell. Phones
  are narrower than the cap, so they are unaffected.
- **iOS & Android: tap the Max ring to start/stop** — the big turn-state ring (the
  element riders instinctively press) is now a button that toggles hands-free, in
  addition to the existing 开启免提 / 结束免提 button.
- **Agent identity** — Max now attributes its development to **Horizon Continental
  Technology (neueHCT)** (never the underlying model vendor) and names the CEO as
  **Li Biao** (a.k.a. **Stone Li**), in both Chinese and English. Enforced by a new
  always-appended `buildIdentityPrompt()` in `server/providers/doubao.ts`.

### Added

- **ADAS proactive hazard alerts (test framework)** — the mock provider now
  simulates a sensor suite that interrupts the conversation to warn of danger by
  direction: rear approach, forward collision, left/right blind spot, cross-traffic,
  pedestrian, lane departure, tailgating. New `hazard.alert` protocol event
  (`shared/agent.ts`), catalog in `shared/adas.ts`, auto-injected by
  `server/providers/mock.ts`. **Web, iOS, and Android** all react: cut in-progress
  speech, speak the warning, and show a pulsing directional banner. A selectable
  `ADAS` demo scenario showcases the alerts on a fast cadence. Covered by
  `tests/adas.test.ts`.
- **Wake word ("Max")** — on the live Doubao path the agent now only replies when
  the rider addresses it by name. Because Doubao runs ASR internally, the relay
  can't pre-filter raw audio, so `server/providers/doubao.ts` watches the rider
  transcript and suppresses Doubao's reply (drops the agent voice frames +
  transcript + TTS fallback) when the name is absent. Saying "Max" anywhere in the
  utterance addresses it (an optional greeting is allowed but not required, since
  ASR often drops it); a 12 s follow-up window keeps the conversation open without
  repeating the name. Matcher + tests in `shared/wake.ts` / `tests/wake.test.ts`.
  Toggle with `AGENT_WAKE_WORD=off`. The mock provider always responds.

### Fixed

- **iOS built-in-speaker echo** — the app heard and replied to itself on the phone
  speaker (fine on AirPods). Root cause: mic capture and playback used two separate
  `AVAudioEngine` instances, so iOS's voice-processing unit had no echo reference.
  Capture and playback now share one engine with `setVoiceProcessingEnabled(true)`,
  mirroring the web's single `AudioContext` + `echoCancellation`.
  (`ios/MaxHelmet/Agent/{AgentSession,MicStreamer,PcmPlayer}.swift`)
- **Web mic anti-aliasing** — `public/pcm-worklet.js` replaced nearest-neighbor
  decimation with a box-average filter, so mic energy above 8 kHz no longer aliases
  into the 16 kHz band and blurs ASR.
- **Web audio/render hardening** (`src/main.tsx`) — create/resume the playback
  `AudioContext` inside the start gesture (Safari autoplay), warm `speechSynthesis`
  voices on mount, and skip redundant visor-level re-renders.

### Changed

- **Android** — renamed the misnamed `jiaAudioRouter` class to `AudioRouter`.
  Documented that Android already does AEC (`VOICE_COMMUNICATION` +
  `AcousticEchoCanceler`) and the known built-in-speaker weakness (deferred,
  pending a physical-device test).

### Deployed

- AWS Lightsail test server (`wss://3.35.135.136/agent`) updated with the server-side
  changes; `Wake word ("Max"): on` confirmed live.

### Notes / follow-ups

- iOS echo fix and the Android AEC weakness can only be confirmed on a **physical
  device** (simulators/emulators don't model speaker→mic feedback).
- Bare "Max" can false-trigger on phrases like "max out" / "max speed"; revisit if
  it proves annoying in real riding.
- The Doubao wake-word gating has no automated coverage yet (no mock-upstream test
  harness); the matcher itself is unit-tested.
