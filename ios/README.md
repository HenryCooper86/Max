# Max 头盔助手 — iOS App

Native iOS (Swift + SwiftUI) client for the Max motorcycle helmet voice agent. It speaks the
same `/agent` relay protocol as the web HUD and the Android app, so the Node server, Doubao
integration, weather, and ride intelligence all work unchanged — this app replaces only the
client side.

```text
iPhone (this app)                       Mac / test server
┌─────────────────────────┐            ┌──────────────────────┐
│ SwiftUI HUD             │            │ Express + ws relay   │
│ AVAudioEngine 16kHz in  ├───────────▶│ /agent  (unchanged)  │
│ AVAudioPlayerNode 24kHz │◀───────────┤        │             │
│ Background audio mode   │  binary +  │        ▼             │
│ CoreLocation → weather  │  JSON WS   │ Doubao OpenSpeech    │
└─────────────────────────┘            └──────────────────────┘
```

## Requirements

- Xcode 16 or newer (the project uses file-system-synchronized groups, an Xcode 16 format)
- iOS 17+ device or simulator
- An Apple Developer signing team for running on a physical device (Simulator needs none)

## Build & run

Open `MaxHelmet.xcodeproj` in Xcode and press Run — no extra tooling, CocoaPods, or SPM
packages. The project has no third-party dependencies; it uses only `SwiftUI`, `AVFoundation`,
`CoreLocation`, and `Combine`.

On a physical device, select your team under **Signing & Capabilities** first (the bundle ID is
`com.horizon.maxhelmet`; change it if it collides).

> New Swift files dropped into `MaxHelmet/` are picked up automatically — the target uses a
> synchronized group, so there is no "add to target" step.

## Run against the relay

1. Start the relay on the Mac: `npm run dev:server` (or `npm run dev`) from the repo root.
   The server listens on `0.0.0.0:8787`, so it is reachable over the LAN.
2. Launch the app and set the 语音中继地址 field:

| Where the app runs    | Relay URL                                |
| --------------------- | ---------------------------------------- |
| iOS Simulator         | `ws://localhost:8787/agent` (default)    |
| Physical iPhone (LAN) | `ws://<Mac-LAN-IP>:8787/agent`           |
| Shared test server    | `wss://3.35.135.136/agent` (self-signed) |

3. Tap 开启免提. The app asks for microphone (required) and location (optional, used for live
   weather). With `VOICE_PROVIDER=mock` you get the scripted demo session; with
   `VOICE_PROVIDER=doubao` you get real speech-to-speech.

### Self-signed test server

The Lightsail test box uses a self-signed certificate. Toggle **信任自签名证书（测试服务器）**
before connecting to a `wss://` host with such a cert. This trust-all path is gated behind the
toggle and must never ship in a production build. `Info.plist` also enables
`NSAllowsArbitraryLoads` so `ws://` (cleartext) dev relays work — tighten both before release.

## Architecture

The app mirrors the Android client's two-layer split. The `Agent/` layer is pure protocol +
audio + session logic; the `UI/` layer is the SwiftUI HUD.

| File                        | Role                                                                                                                                                                | Ports from                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Agent/AgentProtocol.swift` | Enums, event parsing, `session.start` builder, pure helpers (`combineHazardLevels`, `mapTurnState`, `detectLanguage`, `normalizeTranscriptText`, transcript export) | `shared/agent.ts`, `shared/ride.ts`, `shared/language.ts`, `android/.../AgentProtocol.kt` |
| `Agent/MicStreamer.swift`   | Mic capture → 16 kHz PCM16 mono, 320-sample (20 ms) frames                                                                                                          | `public/pcm-worklet.js`, `MicStreamer.kt`                                                 |
| `Agent/PcmPlayer.swift`     | Gapless 24 kHz PCM16 playback + barge-in                                                                                                                            | playback cursor in `src/main.tsx`, `PcmPlayer.kt`                                         |
| `Agent/AudioRouter.swift`   | `AVAudioSession` voice-chat config + Bluetooth (HFP) routing                                                                                                        | `AudioRouter.kt`                                                                          |
| `Agent/AgentSession.swift`  | Relay WebSocket, reconnect backoff, transcript dedup, barge-in, `AVSpeechSynthesizer` TTS fallback, location, self-signed TLS, published state                      | `useHelmetAgent` in `src/main.tsx`, `AgentSession.kt`                                     |
| `UI/AgentScreen.swift`      | The HUD: header, rider controls, turn-state ring, 态势摘要, weather, telemetry, transcript, controls                                                                | `src/components/HelmetVisual.tsx`, `AgentScreen.kt`                                       |
| `UI/MainViewModel.swift`    | Relay-URL / cert prefs (`UserDefaults`), hands-free toggle, transcript export share sheet                                                                           | `MainViewModel.kt`                                                                        |
| `UI/HudTheme.swift`         | Design tokens                                                                                                                                                       | `src/styles.css`, `theme/Theme.kt`                                                        |
| `MaxHelmetApp.swift`        | App entry; keeps the screen awake, forces dark mode                                                                                                                 | `MainActivity.kt`                                                                         |

### Platform notes vs. Android

- **Background audio** replaces the Android foreground service: `UIBackgroundModes = audio`
  in `Info.plist` keeps the mic and playback alive when the app is backgrounded or the screen
  is off. There is no separate notification.
- **Bluetooth routing** is handled by iOS itself — `AVAudioSession` with `.playAndRecord` +
  `.allowBluetooth` automatically prefers a connected HFP headset, so there is no manual SCO
  start/stop.
- **TTS fallback** uses `AVSpeechSynthesizer` (the mock provider returns reply text but no
  audio; Doubao returns synthesized audio).

When the relay protocol or the web-side helpers (`shared/agent.ts`, `shared/ride.ts`,
`shared/language.ts`, the pure functions in `src/main.tsx`, or the dedup logic mirrored in
`server/providers/doubao.ts`) change, update this app's `Agent/` layer alongside the Android
counterparts.

## Verifying the build

There is no headless way to compile an iOS app off a Mac, so CI/parity checks should run on a
Mac runner:

```bash
xcodebuild -project ios/MaxHelmet.xcodeproj -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 15' build
```
