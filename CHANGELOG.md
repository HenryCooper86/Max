# Changelog

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
