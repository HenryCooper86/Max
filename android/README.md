# Max 头盔助手 — Android App

[简体中文](README.zh-CN.md) · English

Native Android (Kotlin + Jetpack Compose) client for the Max motorcycle helmet voice agent.
It speaks the same `/agent` relay protocol as the web HUD, so the Node server, Doubao
integration, weather, and ride intelligence all work unchanged — this app replaces only the
browser side.

```text
Phone (this app)                        Mac / test server
┌─────────────────────────┐            ┌──────────────────────┐
│ Jetpack Compose HUD     │            │ Express + ws relay   │
│ AudioRecord 16kHz PCM16 ├───────────▶│ /agent  (unchanged)  │
│ AudioTrack  24kHz PCM16 │◀───────────┤        │             │
│ Foreground service      │  binary +  │        ▼             │
│ Location → weather      │  JSON WS   │ Doubao OpenSpeech    │
└─────────────────────────┘            └──────────────────────┘
```

## Requirements

- Android Studio with its bundled JBR/JDK. Gradle requires JDK 17-21; avoid Homebrew Java 25+.
- Android SDK with platform 36.1.
- A device or emulator running Android 8.0+ (API 26+)
- Gradle wrapper 9.4.1, Android Gradle Plugin 9.2.1, Kotlin 2.2.10, Compose BOM 2024.09.03.

## Build

This project needs a gitignored `android/local.properties` pointing at your Android SDK:

```
sdk.dir=/Users/admin/Library/Android/sdk
```

Android Studio writes this automatically on first open; command-line Gradle (including
`./gradlew test`, which needs no device or emulator) needs it too.

From this `android/` directory:

```bash
MAX_GIT_COMMIT=$(git -C .. rev-parse --short=12 HEAD) \
  JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleDebug
```

The APK lands at `app/build/outputs/apk/debug/app-debug.apk`. Or open `android/` in
Android Studio and press Run.

Useful Gradle checks:

```bash
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew test
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleDebug
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew lintDebug
```

## Run against the relay

1. Start the relay on the Mac: `npm run dev:server` (or `npm run dev`) from the repo root.
   The server listens on `0.0.0.0:8787`, so it is reachable over the LAN.
2. Install and launch the app, then set the 语音中继地址 field — tap the **设置** (gear) button
   at the bottom to open the settings sheet; the **连接** section holds the field:

| Where the app runs   | Relay URL                                                         |
| -------------------- | ----------------------------------------------------------------- |
| Android emulator     | `ws://10.0.2.2:8787/agent` (default — host loopback)              |
| Physical phone (LAN) | `ws://<Mac-LAN-IP>:8787/agent`                                    |
| Physical phone (USB) | `ws://127.0.0.1:8787/agent` after `adb reverse tcp:8787 tcp:8787` |

3. Tap the helmet. The app asks for microphone (required) and location (optional, used for
   live weather). With `VOICE_PROVIDER=mock` you get the scripted demo session; with
   `VOICE_PROVIDER=doubao` you get real speech-to-speech.

For release QA, the settings sheet's **QA 任务归因** section accepts Campaign, Test case, Run,
and Assignment IDs from the web control plane. The app persists them and sends them atomically
with `platform=android` on the next `session.start`. Gradle resolves the current repository commit
automatically; CI can set `MAX_GIT_COMMIT` explicitly so the APK and release run always use the
same candidate identity.

### Permissions

The manifest requests only the permissions needed for the prototype:

| Permission                      | Why it is needed                                                    |
| ------------------------------- | ------------------------------------------------------------------- |
| `INTERNET`                      | Connect to the local or test `/agent` WebSocket relay.              |
| `RECORD_AUDIO`                  | Stream the rider's microphone as 16 kHz PCM16 frames.               |
| `ACCESS_COARSE/FINE_LOCATION`   | Send coordinates to the relay for live weather and risk advice.     |
| `FOREGROUND_SERVICE_MICROPHONE` | Keep the hands-free mic session alive when the app is backgrounded. |
| `POST_NOTIFICATIONS`            | Show the foreground-service notification on newer Android versions. |
| `BLUETOOTH_CONNECT`             | Route audio to an in-helmet Bluetooth headset on Android 12+.       |
| `MODIFY_AUDIO_SETTINGS`         | Start/stop headset routing and speaker/mic mode adjustments.        |
| `CAMERA`                        | Requested only for photo/video or torch commands.                   |
| `READ_CONTACTS`                 | Requested only when resolving a spoken contact name.                |

Location is optional. If the rider denies it, the relay can still use server-side fallback
weather coordinates.

## Emulator quick start

```bash
# Terminal 1 — relay
npm run dev:server

# Terminal 2 — emulator + install
~/Library/Android/sdk/emulator/emulator -avd Medium_Tablet &
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew installDebug
~/Library/Android/sdk/platform-tools/adb shell am start -n io.github.henrycooper86.max/.MainActivity
```

The emulator forwards the host Mac's microphone, so the full voice loop is testable.

## Core mobile features

- Tap the helmet to start/stop the voice session, matching iOS. Mute remains a separate utility action.
- Responsive portrait/landscape regions keep the helmet, map, music, captions, and utilities reachable, with system-bar insets and labeled controls.
- Turn-state ring with the web HUD's captions and palette (待机 / 请讲话 / 聆听 / 思考 / 回答)
- Live transcript with in-place partial updates and agent-line dedup (same rules as the web client)
- Transcript JSON export via the system share sheet (导出日志, same payload as the web export)
- Weather card with risk colour and rider advice
- 女声 / 男声 toggle — restarts the realtime session like the web `restartSession`
- 语气 (voice personality) selector: 极简 / 友好 / 技术 / 领航
- 骑行模式 selector (骑行 / 导航 / 停车 / 紧急) and 演示场景 strip (通勤 / 横风 / 低油 / 小队 / 紧急)
- 态势摘要 (ride pulse) card: fused ride + weather hazard, rider action, mode/scenario/network/battery
  grid, speed + route phase, session-memory chips
- Telemetry readouts: relay latency tone plus ASR / 思考 / 首音 / 总计 timings
- Barge-in: rider speech stops queued Doubao audio and device TTS
- ADAS hazard alerts: reacts to the server `hazard.alert` event by interrupting playback, speaking
  the warning, and showing a pulsing directional banner; an `ADAS` demo scenario showcases them
- Device-TTS fallback when the provider sends text without audio (mock provider, Doubao text-only replies)
- Auto-reconnect with exponential backoff (6 attempts, mirrors the web client)
- Foreground service so the session keeps running with the screen off
- Bluetooth headset (SCO) routing for in-helmet headsets, with phone mic/speaker fallback
- Acoustic echo cancellation: mic capture uses the `VOICE_COMMUNICATION` source plus
  `AcousticEchoCanceler` / `NoiseSuppressor`, so the agent's voice is not fed back into the
  mic (the Android analogue of the web's `getUserMedia({ echoCancellation })`). See _Audio
  notes_ below for a known built-in-speaker limitation.
- `wss://` support with a debug-only "信任自签名证书" toggle for the Lightsail test server;
  release builds require trusted TLS and block cleartext
- Keystore-backed AES-GCM storage for relay/login tokens, including migration from older preferences
- Release-run/test-case/assignment attribution with explicit Android platform and stamped git commit
- Every supported device command returns a result: torch, Max voice volume, music, contact/number dialing, SMS composition, photo/video capture, gallery, and navigation. Unknown or malformed actions return an error instead of timing out. Dialing/SMS open the system confirmation UI; SMS is refused without known speed at or below 5 km/h.
- App-owned music queue with play/pause/previous/next and close, available in both the HUD and full-screen map. Select multiple audio files through Android's document picker. Leaving Max, locking the screen, closing the card, or ending the session pauses playback; returning never resumes automatically. Stop cancels loading immediately, and voice skip succeeds only after the next file actually starts. Android does not integrate the protected Apple Music catalog or control another app's queue.
- CameraX photos and silent video (no microphone input), with permission prompts, low-storage refusal, a ten-minute/1 GB recording limit, and stop-on-background behavior. Captures stay private until exported.
- Max gallery with photo/video viewing, deletion confirmation, export to system Photos on Android 10+, system save/share on Android 8–9, and gallery.describe uploads using one photo or eight video frames. Photo previews respect EXIF orientation.

See [the mobile parity audit](../docs/mobile-parity.md) for verification evidence, platform differences, and remaining work.

## Navigation

Voice-triggered turn-by-turn guidance: "导航去X" starts an in-app session, "停止导航" ends it.
Routing is relay-side — the app sends `nav.request` and receives `nav.route` / `nav.error` over
the same `/agent` socket the voice session already uses, reaching the same Amap driving service
web and iOS use. A missing `AMAP_API_KEY` on the relay still resolves a deterministic mock route
end-to-end. Voice/text guidance therefore works without a client map key. Native map tiles
require a separately registered **Android** AMap key for the app package and signing certificate.
Set `AMAP_ANDROID_KEY` for the build, or `amap.android.key=...` in ignored `android/local.properties`.
The iOS key and relay web-service key cannot be substituted. Never commit a real key.

- **Coordinates.** GCJ-02 on the wire _and_ inside the app — routes arrive already GCJ-02 and stay
  that way. Raw WGS-84 exists only for the instant between a GPS fix and
  `NavigationController`'s one `CoordinateDatum.wgs84ToGcj02` call, the app's single datum
  conversion site. The reverse direction is never implemented anywhere in the app.
- **Guidance logic.** `GuidanceEngine.kt` is a Kotlin port of the same six-rule contract as
  `shared/guidance.ts` (web) and the iOS Swift port, tested against the identical shared table:
  maneuver prompts at ~400 m / ~150 m / the turn, one debounced reroute per wrong turn, an arrival
  announcement, and a clean stop (not a silent retry) when the relay fails.
- **Display.** Native AMap route geometry, destination and rider markers, and a full-route camera control inside the guidance card. All map coordinates are already GCJ-02; the renderer does not convert them again. The SDK is initialized only after the rider accepts the disclosure. Declining preserves text/voice guidance and exposes an enable-map action. Missing keys, invalid geometry, initialization errors, and map-load timeouts show an unavailable state.
- **Location.** `LocationManagerSource` requests GPS fixes. Fine location is required; the first-fix deadline is eight seconds, with a locating announcement after 1.5 seconds. A timeout returns a spoken failure rather than silently starting without a location.
- **Session scope.** Navigation lives entirely inside the foreground hands-free session: it wires
  up with `AgentSession` and tears down with it, the same lifetime as the mic. No
  background-location permission, no guidance outside a live session.
- **Honest limits.** Car routing profile only — 摩托车禁行 (motorcycle-restricted) roads are not
  respected, matching iOS and web.

## Protocol parity checklist

When changing shared web/server behavior, update Android at the same time:

- Event names and payloads in `shared/agent.ts` and `agent/AgentProtocol.kt`
- Ride modes, scenarios, hazard fusion, and prompt labels from `shared/ride.ts`
- Language detection and transcript normalization from `shared/language.ts` and `src/hooks/useHelmetAgent.ts`
- Audio frame assumptions: uplink 16 kHz PCM16 mono, 320 samples / 20 ms; downlink 24 kHz PCM16
- Reconnect/backoff behavior, barge-in behavior, and transcript JSON export payload
- Self-signed test-server handling and relay URL defaults

## Architecture

| File                           | Role                                                                                                              | Web counterpart                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `agent/AgentProtocol.kt`       | Event types, JSON parsing, ride/hazard/turn-state/language helpers, export payload                                | `shared/agent.ts`, `shared/ride.ts`, `shared/language.ts`, helpers in `src/hooks/useHelmetAgent.ts` |
| `agent/MicStreamer.kt`         | 16 kHz PCM16 mic capture, 20 ms frames; `VOICE_COMMUNICATION` source + `AcousticEchoCanceler` / `NoiseSuppressor` | `public/pcm-worklet.js`                                                                             |
| `agent/PcmPlayer.kt`           | 24 kHz PCM16 gapless playback + barge-in flush                                                                    | playback scheduling in `src/hooks/useHelmetAgent.ts`                                                |
| `agent/AudioRouter.kt`         | Bluetooth headset (SCO) routing for in-helmet headsets                                                            | — (browsers can't control routing)                                                                  |
| `agent/AgentSession.kt`        | Session orchestration, reconnect, transcript, state                                                               | `useHelmetAgent` hook in `src/hooks/useHelmetAgent.ts`                                              |
| `service/VoiceAgentService.kt` | Microphone foreground service                                                                                     | — (browser tabs can't do this)                                                                      |
| `ui/AgentScreen.kt`            | Compose HUD: ring, ride pulse, telemetry, transcript, controls                                                    | `src/components/` + HUD layout in `src/hooks/useHelmetAgent.ts`                                     |

## Connecting to the Lightsail test server

In a **Debug** build, set the relay address to `wss://3.35.135.136/agent` and switch on
信任自签名证书. Release builds intentionally omit this option and require a trusted certificate.

## Troubleshooting

| Symptom                              | Check                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| App stays offline in emulator        | Use `ws://10.0.2.2:8787/agent`, not `localhost`; `localhost` means the emulator itself.        |
| Physical phone cannot connect        | Put phone and Mac on the same LAN, use the Mac LAN IP, and allow firewall access.              |
| USB device cannot connect            | Run `adb reverse tcp:8787 tcp:8787`, then use `ws://127.0.0.1:8787/agent`.                     |
| Mic does not start                   | Grant microphone permission and confirm no other app is holding exclusive audio focus.         |
| Bluetooth headset is ignored         | Grant Bluetooth permission on Android 12+ and confirm the headset supports HFP/SCO.            |
| Test server TLS fails                | Use a Debug build and enable its self-signed certificate toggle. Release requires trusted TLS. |
| Build fails with Java version errors | Use Android Studio's JBR as `JAVA_HOME`; do not build with Homebrew Java 25+.                  |

## Audio notes

- **Echo cancellation** is handled by the platform: `MicStreamer` records from
  `MediaRecorder.AudioSource.VOICE_COMMUNICATION` (which engages the device AEC/AGC/NS) and
  additionally attaches `AcousticEchoCanceler` + `NoiseSuppressor` to the record session. Unlike
  iOS's voice-processing unit — which only cancels audio rendered through the _same_
  `AVAudioEngine` — Android's `VOICE_COMMUNICATION` AEC references the actual speaker output at
  the HAL level, so capture and playback do **not** have to share one graph.
- **Speaker and headset routing.** A live voice session now uses `MODE_IN_COMMUNICATION` and `USAGE_VOICE_COMMUNICATION` on the phone speaker as well as Bluetooth. It prefers a connected headset, otherwise the speaker, and restores the prior mode on teardown. Music uses its own media path; it does not mute the mic. Speaker echo cancellation, helmet HFP/SCO behavior, and audible voice/music balance still require physical-device checks.

## Release caveats

- Release builds hide and compile-gate the self-signed trust path and reject cleartext traffic.
- The debug APK is unsigned for distribution. Configure a release signing key before shipping.
- The app targets API 36 and compiles against Android 16 QPR2 (36.1), matching the 2026 Play gate.
- Keep the foreground-service notification clear and user-visible for Android policy compliance.

## Remaining validation and follow-ups

- Validate Bluetooth routing, speaker echo cancellation, crash sensing, and emergency delivery on physical devices.
- Verify live AMap key authorization and map tiles with a signed Android build. The map implementation and keyless text/voice fallback are present.
- Finish the physical RDK pairing and helmet-ride acceptance checks in [mobile parity](../docs/mobile-parity.md).
- Wake-word gating currently applies to the live Doubao relay; microphone streaming continues during a hands-free session.

### Helmet rides and crash checks

Settings now includes RDK code/nearby pairing and explicit helmet ride start/stop. Sign in with an account first; the manually pasted relay token does not authorize companion sharing. Starting a ride requires precise location and keeps a visible foreground notification with a stop action. Phone hands-free and helmet ride modes are mutually exclusive. Logout and unpair stop sharing; rides do not resume automatically after process death.

Phone hands-free arms the iOS-equivalent crash detector when linear acceleration and gyroscope sensors are available. An incident progresses through a 15-second check-in and 30-second alarm. “我没事”/“取消”, the crash screen or notification cancels it. Ending hands-free preserves an active alarm; logging out disables its network delivery but retains the local alarm and dialer. Emergency contact notification is opt-in, and relay failures are shown explicitly. The default manual call target is 120; settings can select the configured contact instead. No call is placed automatically.

In a debug build, developer settings expose a local-only crash drill. It cannot notify an emergency contact. Hardware sensor validation, real RDK discovery, Bluetooth audio, live AMap authorization and actual notification-provider delivery remain device/release acceptance gates; see [the parity audit](../docs/mobile-parity.md).

### Latest riding-screen parity

Navigation requires destination approval before turn-by-turn voice guidance. The full-screen map prioritizes the next turn, route, trip summary and compact music controls; expanded steps reserve visible space in portrait. Music selection is owned by the activity so it remains available above the map. Fresh phone GPS updates reach Max during hands-free without navigation or RDK sharing, and location tracking retries after returning from Settings or granting permission. RDK location forwarding remains a separate optional feature.

## Wi-Fi navigation HUD casting (bench prototype)

Phone-owned navigation can now be sent from either development app to the RDK
display. Open `/cast` on the board-local HUD server, then use **投屏到 HUD**
in the phone’s navigation details. See [setup, limits and acceptance checks](../docs/rdk-hud-casting.md).
