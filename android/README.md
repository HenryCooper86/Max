# Max 头盔助手 — Android App

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

- Android Studio (its bundled JDK builds the project — Homebrew Java 25 is too new for Gradle 8.9)
- Android SDK with platform 34 (already configured in `local.properties`)
- A device or emulator running Android 8.0+ (API 26+)

## Build

From this `android/` directory:

```bash
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleDebug
```

The APK lands at `app/build/outputs/apk/debug/app-debug.apk`. Or open `android/` in
Android Studio and press Run.

## Run against the relay

1. Start the relay on the Mac: `npm run dev:server` (or `npm run dev`) from the repo root.
   The server listens on `0.0.0.0:8787`, so it is reachable over the LAN.
2. Install and launch the app, then set the 语音中继地址 field:

| Where the app runs   | Relay URL                                            |
| -------------------- | ---------------------------------------------------- |
| Android emulator     | `ws://10.0.2.2:8787/agent` (default — host loopback) |
| Physical phone (LAN) | `ws://<Mac-LAN-IP>:8787/agent`                       |
| Physical phone (USB) | `ws://127.0.0.1:8787/agent` after `adb reverse tcp:8787 tcp:8787` |

3. Tap 开启免提. The app asks for microphone (required) and location (optional, used for
   live weather). With `VOICE_PROVIDER=mock` you get the scripted demo session; with
   `VOICE_PROVIDER=doubao` you get real speech-to-speech.

## Emulator quick start

```bash
# Terminal 1 — relay
npm run dev:server

# Terminal 2 — emulator + install
~/Library/Android/sdk/emulator/emulator -avd Medium_Tablet &
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew installDebug
~/Library/Android/sdk/platform-tools/adb shell am start -n com.horizon.maxhelmet/.MainActivity
```

The emulator forwards the host Mac's microphone, so the full voice loop is testable.

## What's implemented (voice-first core)

- Hands-free toggle: one button starts mic streaming + relay session (开启免提 / 结束免提)
- Turn-state ring with the web HUD's captions and palette (待机 / 请讲话 / 聆听 / 思考 / 回答)
- Live transcript with in-place partial updates and agent-line dedup (same rules as the web client)
- Weather card with risk colour and rider advice
- 女声 / 男声 toggle — restarts the realtime session like the web `restartSession`
- Barge-in: rider speech stops queued Doubao audio and device TTS
- Device-TTS fallback when the provider sends text without audio (mock provider, Doubao text-only replies)
- Auto-reconnect with exponential backoff (6 attempts, mirrors the web client)
- Foreground service so the session keeps running with the screen off

## Architecture

| File | Role | Web counterpart |
| ---- | ---- | --------------- |
| `agent/AgentProtocol.kt` | Event types, JSON parsing, turn-state/language helpers | `shared/agent.ts`, `shared/language.ts`, helpers in `src/main.tsx` |
| `agent/MicStreamer.kt` | 16 kHz PCM16 mic capture, 20 ms frames | `public/pcm-worklet.js` |
| `agent/PcmPlayer.kt` | 24 kHz PCM16 gapless playback + barge-in flush | playback scheduling in `src/main.tsx` |
| `agent/AgentSession.kt` | Session orchestration, reconnect, transcript, state | `useHelmetAgent` hook in `src/main.tsx` |
| `service/VoiceAgentService.kt` | Microphone foreground service | — (browser tabs can't do this) |
| `ui/AgentScreen.kt` | Compose HUD | `src/components/HelmetVisual.tsx` + HUD layout |

## Not yet implemented (next steps)

- Ride modes / demo scenarios / 态势摘要 card / telemetry readouts (full HUD parity)
- Voice personality selector
- Bluetooth SCO routing for in-helmet headsets
- `wss://` with the test server's self-signed certificate
- Transcript JSON export
