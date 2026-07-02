# Changelog

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
