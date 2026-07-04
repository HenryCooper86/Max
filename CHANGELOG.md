# Changelog

## 2026-07-04 — Site-wide login gate: the whole HUD (and the voice line) now requires an account

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
