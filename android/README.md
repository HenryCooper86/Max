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

### Version and release signing

`versionName` is `1.0.0`, matching iOS. `versionCode` comes from a Gradle property and defaults
to 1; CI should pass a build number that only ever increases:

```bash
./gradlew assembleRelease -PversionCode=42
```

Release signing is optional. With none of the values below set, `assembleRelease` still produces
an unsigned APK. To sign, set all four, either as Gradle properties (`-P...` or
`~/.gradle/gradle.properties`, never a file in this repository) or as environment variables.
Setting only some of them fails the build.

| Gradle property           | Environment variable         | Value                       |
| ------------------------- | ---------------------------- | --------------------------- |
| `maxReleaseStoreFile`     | `MAX_RELEASE_STORE_FILE`     | Path to the keystore file   |
| `maxReleaseStorePassword` | `MAX_RELEASE_STORE_PASSWORD` | Keystore password           |
| `maxReleaseKeyAlias`      | `MAX_RELEASE_KEY_ALIAS`      | Alias of the release key    |
| `maxReleaseKeyPassword`   | `MAX_RELEASE_KEY_PASSWORD`   | Password of the release key |

Release builds run without R8 minification for now; `app/proguard-rules.pro` lists what must be
checked before it is turned on.

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
| `ACCESS_NETWORK_STATE`          | Notice network loss and Wi-Fi/mobile handover to reconnect at once. |

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
- Auto-reconnect with exponential backoff (6 attempts, mirrors the web client). Only drops while
  the phone has a network count: in a tunnel the session waits, and when the network returns or
  changes (Wi-Fi to mobile) the budget is refilled. With no socket it reconnects at once; an open
  socket is kept rather than cutting the current turn. If the change killed it, the platform
  usually closes it at once. Mid-reply, a socket that stays silent for 5 s after the change is
  replaced. When idle, OkHttp's 20-second ping is the bound (20-40 s): the relay has no message a
  client can send to get an answer.
- A microphone that stops working (a helmet headset that dies, a dead mic) switches voice off
  only: hands-free, the foreground service and crash detection stay on. Max says so once and
  retries the microphone on every audio-device change and every 15 s until it works. Phone calls
  are also detected from the audio mode, so a call pauses Max even when another app holds audio
  focus, and the call ending resumes listening and re-applies the headset route.
- Foreground service so the session keeps running with the screen off
- Bluetooth headset (SCO) routing for in-helmet headsets, with phone mic/speaker fallback. A headset
  that connects or drops mid-session is picked up within half a second: routing is re-applied and
  the microphone restarted on the new device without reconnecting to the relay. Nothing is
  re-routed while a phone call has the audio (that could move the call to the loudspeaker on
  Android 8-11); the route is re-applied when the call ends.
- Audio focus for the whole hands-free session (see _Audio notes_): a phone call pauses listening
  and Max's voice, and hanging up resumes both.
- Typed turns: when the backend reports `capabilities.textInput`, the captions panel shows a text
  field that sends `text.input`. It is locked at 5 km/h and above (phone GPS speed), and usable
  when speed is unknown.
- Pictures: when the backend also reports `capabilities.imageInput`, the field has a picture button.
  It opens the system photo picker (no storage permission), turns the photo upright by its EXIF
  data, scales it to 1024 pixels on its longer side and sends it as `image.input`, a JPEG that fits
  the relay's limit (quality and then size are lowered until it does, like the web SDK's
  `sendImage`). What is typed in the field goes with the picture as one turn; with nothing typed
  the assistant sees the picture with the next thing said. The relay's limits (one picture a
  second, 50 per connection) are kept on the phone too, so the reason is shown at once.
- Live video: when the backend reports `capabilities.videoInput`, the field has a camera button.
  The first time it is turned on the app asks for the camera permission; a refusal shows a short
  note. While on, CameraX's image analysis (the front camera first, with a control to switch to the
  back one) hands frames to a background thread, which keeps the newest, turns it upright by the
  sensor's orientation and sends it as `video.frame` about once a second: a JPEG of at most 768
  pixels on its longer side, at quality 60 and then 45 if it does not fit (a frame that still does
  not fit is skipped). Frames do not use up the 50 pictures of `image.input`, and none goes less
  than 500 ms after the last. A small preview shows what the assistant is shown. `video.stop` is
  sent when the user turns it off, the conversation ends or the app goes to the background. A lost
  connection turns the camera off too (it is not left on with nobody to show), as does a
  `session.started` without `videoInput`. Like the field, the camera is not turned on while the bike
  is moving; turning it off always works. One camera is used at a time: live video is not turned on
  during a recording, and a photo or a recording asked for by voice ends it.
- Tool activity: `tool.activity` events show as a short status line ("Using get weather…"). The
  app declares no client tools, so an unexpected `tool.call` is answered at once with an
  `unknown tool` error, as the protocol requires.
- Heat and battery saver (the same tiers as iOS): at severe phone temperature video recording
  stops, and new recordings and gallery uploads are refused; at critical temperature photos, the
  torch, music, HUD casting and the map pause too. Battery saver only refuses new recordings; one
  already running continues. Heat that arrives while a recording is starting stops it straight
  after the start (the short clip is kept). Max speaks a heat warning once per hot spell, never the same warning
  twice within 5 minutes, and shows when it has cooled down. The voice session, crash detection and
  voice navigation always keep running.
- Acoustic echo cancellation: mic capture uses the `VOICE_COMMUNICATION` source plus
  `AcousticEchoCanceler` / `NoiseSuppressor`, so the agent's voice is not fed back into the
  mic (the Android analogue of the web's `getUserMedia({ echoCancellation })`). See _Audio
  notes_ below for a known built-in-speaker limitation.
- `wss://` support with a debug-only toggle for the installed CA of a test relay;
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

## Connecting to your own TLS relay

Run the relay on a host you control and enter its address, for example
`wss://relay.example.com/agent`. For a private test relay, install its CA certificate in Android’s trusted credentials on the test device.
In a **Debug** build, enable **Trust device-installed CAs**. The relay certificate must cover the hostname
or IP address in the URL. Release builds use the default Android trust policy.

## Troubleshooting

| Symptom                              | Check                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| App stays offline in emulator        | Use `ws://10.0.2.2:8787/agent`, not `localhost`; `localhost` means the emulator itself.        |
| Physical phone cannot connect        | Put phone and Mac on the same LAN, use the Mac LAN IP, and allow firewall access.              |
| USB device cannot connect            | Run `adb reverse tcp:8787 tcp:8787`, then use `ws://127.0.0.1:8787/agent`.                     |
| Mic does not start                   | Grant microphone permission. A phone call pauses hands-free until it ends (the HUD says so).   |
| "Another app is playing audio"       | An app kept taking audio focus back. Max still listens and lowers that app only to speak.      |
| Bluetooth headset is ignored         | Grant Bluetooth permission on Android 12+ and confirm the headset supports HFP/SCO.            |
| Test server TLS fails                | Check the relay hostname, install its CA on Android, and enable device-installed CAs in Debug. |
| Build fails with Java version errors | Use Android Studio's JBR as `JAVA_HOME`; do not build with Homebrew Java 25+.                  |

## Audio notes

- **Echo cancellation** is handled by the platform: `MicStreamer` records from
  `MediaRecorder.AudioSource.VOICE_COMMUNICATION` (which engages the device AEC/AGC/NS) and
  additionally attaches `AcousticEchoCanceler` + `NoiseSuppressor` to the record session. Unlike
  iOS's voice-processing unit — which only cancels audio rendered through the _same_
  `AVAudioEngine` — Android's `VOICE_COMMUNICATION` AEC references the actual speaker output at
  the HAL level, so capture and playback do **not** have to share one graph.
- **Speaker and headset routing.** A live voice session now uses `MODE_IN_COMMUNICATION` and `USAGE_VOICE_COMMUNICATION` on the phone speaker as well as Bluetooth. It prefers a connected headset, otherwise the speaker, and restores the prior mode on teardown. Music uses its own media path; it does not mute the mic. Speaker echo cancellation, helmet HFP/SCO behavior, and audible voice/music balance still require physical-device checks.
- **Audio focus.** Hands-free holds `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` focus (voice communication,
  speech) for the whole session, so the rider's music keeps playing, ducked under Max, and returns
  to full volume when hands-free ends. In-app music plays under that focus, ducked the same way.
  A transient loss (a phone call) pauses capture and Max's voice and tells the rider; focus coming
  back re-routes and restarts the microphone. A navigation prompt (a may-duck request) does not
  pause listening, and is not ducked under Max either: it plays over Max's voice. A permanent loss
  usually means the rider started music (by voice or the helmet's play button), so Max takes focus
  back and the music plays ducked. Speech apps such as podcasts are not auto-ducked; they pause
  and take focus back when the rider presses play. After three reclaims in a minute (or a refused
  one) Max stops competing: hands-free keeps running without focus (the microphone does not need
  it, and crash detection stays armed), the rider is told once, and Max asks for focus again only
  to speak (handing it back afterwards) or when the other app stops playing. Audio focus never
  ends hands-free. Safety warnings still play during a call.

## Release caveats

- Release builds hide and compile-gate the self-signed trust path and reject cleartext traffic.
- The debug APK is unsigned for distribution. Configure release signing (see _Version and release signing_) before shipping.
- Backups are limited by `res/xml/backup_rules.xml` and `res/xml/data_extraction_rules.xml` to
  interface preferences (language, visor template, voice display). Transcripts, account data,
  tokens, the emergency contact, crash settings, captures and their metadata never leave the phone.
- The launcher and system labels default to English (`res/values/`), with Chinese in
  `res/values-zh/`, matching the in-app language rule (Chinese only for Chinese system locales).
- The app targets API 36 and compiles against Android 16 QPR2 (36.1), matching the 2026 Play gate.
- Keep the foreground-service notification clear and user-visible for Android policy compliance.

## Remaining validation and follow-ups

- Validate Bluetooth routing, speaker echo cancellation, crash sensing, and emergency delivery on physical devices.
- Verify live AMap key authorization and map tiles with a signed Android build. The map implementation and keyless text/voice fallback are present.
- Finish the physical RDK pairing and helmet-ride acceptance checks in [mobile parity](../docs/mobile-parity.md).
- Wake-word gating currently applies to the live Doubao relay; microphone streaming continues during a hands-free session.

### Helmet rides and crash checks

Settings now includes RDK code/nearby pairing and explicit helmet ride start/stop. Sign in with an account first; the manually pasted relay token does not authorize companion sharing. Starting a ride requires precise location and keeps a visible foreground notification with a stop action. Phone hands-free and helmet ride modes are mutually exclusive. Logout and unpair stop sharing; rides do not resume automatically after process death.

Phone hands-free arms the iOS-equivalent crash detector when linear acceleration and gyroscope sensors are available. Its speed comes from the phone's own GPS (the session's existing location stream), so detection does not depend on the relay. For the crash detector's stillness check a GPS speed counts for 2 s, so a pre-impact speed cannot block the check that confirms a crash; a GPS fix without a usable speed makes the speed unknown at once. The 10 km/h speed gate also accepts the last usable GPS speed for up to 15 s, so a crash in a tunnel or under poor GPS still starts an incident. Crash detection never uses the relay's speed. Other uses accept a fix up to 5 s old. A live relay's `ride.context` speed is only the phone's own speed echoed back and is ignored; a mock relay's scenario speed (mode exactly "mock") is used for SMS, typing and the HUD when there is no fresh GPS, and is forgotten whenever the socket closes or reconnects. Otherwise speed is unknown, never zero, and a crash then needs an impact together with a tumble to raise a check-in. The same speed drives the SMS rule (refused at 5 km/h and above, and while speed is unknown, for example indoors without GPS; dialling is unaffected) and the typing field (locked at 5 km/h and above, usable when speed is unknown). `location.update` carries the fresh GPS speed as optional `speedKmh` for the relay's own fast-moving rule. An incident progresses through a 15-second check-in and 30-second alarm. “我没事”/“取消”, the crash screen or notification cancels it. Ending hands-free preserves an active alarm; logging out disables its network delivery but retains the local alarm and dialer. Emergency contact notification is opt-in, and relay failures are shown explicitly. The default manual call target is 120; settings can select the configured contact instead. No call is placed automatically.

In a debug build, developer settings expose a local-only crash drill. It cannot notify an emergency contact. Hardware sensor validation, real RDK discovery, Bluetooth audio, live AMap authorization and actual notification-provider delivery remain device/release acceptance gates; see [the parity audit](../docs/mobile-parity.md).

### Latest riding-screen parity

Navigation requires destination approval before turn-by-turn voice guidance. The full-screen map prioritizes the next turn, route, trip summary and compact music controls; expanded steps reserve visible space in portrait. Music selection is owned by the activity so it remains available above the map. Fresh phone GPS updates reach Max during hands-free without navigation or RDK sharing, and location tracking retries after returning from Settings or granting permission. RDK location forwarding remains a separate optional feature.

## Wi-Fi navigation HUD casting (bench prototype)

Phone-owned navigation can now be sent from either development app to the RDK
display. Open `/cast` on the board-local HUD server, then use **投屏到 HUD**
in the phone’s navigation details. See [setup, limits and acceptance checks](../docs/rdk-hud-casting.md).
