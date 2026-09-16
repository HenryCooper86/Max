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

- Xcode 16 or newer.
- iOS 17+ device or simulator
- An Apple Developer signing team for running on a physical device (Simulator needs none)
- Homebrew Ruby 3.2 through 4.x (Ruby 4.0.6 is verified); Apple's `/usr/bin/ruby` is too old.
- Bundler 4.0.16. The lockfile keeps CocoaPods on the reviewed 1.16.x minor (currently 1.16.2).

## Build & run

Bootstrap CocoaPods and create the ignored local key configuration from the repository root. Use
Homebrew Ruby explicitly because a default macOS shell may otherwise select Apple's unsupported
Ruby and Bundler:

```bash
brew install ruby
export PATH="$(brew --prefix ruby)/bin:$PATH"
gem install bundler -v 4.0.16

cd ios
bundle _4.0.16_ config set --local path vendor/bundle
bundle _4.0.16_ install
bundle _4.0.16_ exec pod install --repo-update
./scripts/verify-bootstrap.sh
test -e Config/Secrets.xcconfig || \
  cp Config/Secrets.xcconfig.example Config/Secrets.xcconfig
```

The verification script executes the selected Ruby, Bundler, installed dependency set, and
CocoaPods binary. It must report Ruby 3.2–4.x, Bundler 4.0.16, and CocoaPods 1.16.x before building.

Set `AMAP_IOS_KEY` only in the ignored `Config/Secrets.xcconfig`; never commit that file. Then
open `MaxHelmet.xcworkspace` in Xcode and press Run. The app uses `SwiftUI`, `AVFoundation`,
`CoreLocation`, `Combine`, and the native AMap iOS 3D Map SDK provided by CocoaPods.

On a physical device, select your team under **Signing & Capabilities** first (the bundle ID is
`com.horizon.maxhelmet`; change it if it collides).

> New Swift files dropped into `MaxHelmet/` are picked up automatically — the target uses a
> synchronized group, so there is no "add to target" step.

Return to the repository root before using the command-line examples below (`cd ..` if you are
continuing from the bootstrap shell). Command-line simulator build:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  HORIZON_GIT_COMMIT=$(git rev-parse --short=12 HEAD) build
```

If `xcodebuild` reports that the active developer directory is Command Line Tools, use the
explicit `DEVELOPER_DIR` command above or switch the machine to full Xcode with `xcode-select`.

## Run against the relay

1. Start the relay on the Mac: `npm run dev:server` (or `npm run dev`) from the repo root.
   The server listens on `0.0.0.0:8787`, so it is reachable over the LAN.
2. Launch the app. Tap the **设置** (gear) button at the bottom to open the settings sheet; the
   **连接** section holds the 语音中继地址 field. The
   field is prefilled from an environment-aware default (`MainViewModel.defaultRelayURL`) —
   override it for any of the rows below:

| Where the app runs    | Relay URL                                           | Default?                       |
| --------------------- | --------------------------------------------------- | ------------------------------ |
| iOS Simulator         | `ws://localhost:8787/agent`                         | ✅ on the simulator            |
| Physical iPhone       | `wss://3.35.135.136/agent` (Lightsail, self-signed) | ✅ in Debug (trust auto-on)    |
| Physical iPhone (LAN) | `ws://<Mac-LAN-IP>:8787/agent`                      | override for a local Mac relay |

On a physical device `localhost` is the phone itself, so a Debug build defaults to the shared AWS
Lightsail test relay and turns the self-signed trust toggle on for that first connection.
Point it back at a Mac relay by typing the LAN URL (and toggling self-signed off for `ws://`).

3. Tap the helmet. The app asks for microphone (required) and location (optional, used for live
   weather). With `VOICE_PROVIDER=mock` you get the scripted demo session; with
   `VOICE_PROVIDER=doubao` you get real speech-to-speech.

For release QA, the settings sheet's **QA 任务归因** section accepts Campaign, Test case, Run,
and Assignment IDs from the web control plane. The app persists them and sends them atomically
with `platform=ios` on the next `session.start`. Command-line/CI builds should always pass
`HORIZON_GIT_COMMIT`; an unstamped local Xcode build reports `unknown` honestly and cannot receive
credit for an assignment targeting a specific candidate commit.

### RDK 头盔配对与 Helmet Ride

RDK 导航位置转发是设置里的独立、显式流程，不会随登录、启动 App 或开启免提自动开始：

1. 先登录账号，在 **RDK 头盔** 设置中输入头盔显示的六位配对码，然后点 **配对头盔**。
   配对只建立账号与头盔的关系，不会启动定位。
2. 配对成功且头盔在线后，点 **开始 Helmet Ride**。首次使用时允许 **使用 App 期间**
   的位置权限，并在系统设置中保持 **精确位置** 开启。骑行期间 iOS 会显示连续的后台/锁屏
   位置指示器；锁屏后仍可继续把最新位置转发给 RDK 头盔导航。
3. 骑行结束时点 **停止 Helmet Ride**。**取消配对**和**退出登录**也会先停止定位与转发，
   再关闭独立的头盔连接。

头盔连接只使用登录取得的**账号会话令牌**；连接设置里的**手动操作员令牌**只服务于
`/agent` 语音会话，不能代替账号登录来配对头盔。App 不显示地图、不显示原始坐标，也不持久化位置；
配对码同样不会写入持久化存储。iOS **强制退出** App 会停止后台转发，重新启动后**不会自动恢复**
Helmet Ride，必须由骑手再次显式开始。

Debug 构建可通过设置开关连接使用自签名证书的测试中继；生产/Release 构建没有该绕过，必须使用
主机名匹配的受信任证书。这个区别同时适用于 `/agent` 和独立的 `/companion` 连接。

部署顺序固定为：已评审且 `/health`、`/ready` 均匹配目标 SHA 的中继 → 签名后的 iOS 构建 →
RDK。安装后先登录、配对并确认头盔 HUD 为 ready，再开始 Helmet Ride；不要用配对成功代替定位
许可或骑行启动的验收。回滚时先停止 Helmet Ride，再安装上一份已记录的签名构建；重新登录后
不会自动恢复骑行。完整的构建标识、设备/OS、锁屏十分钟、断网/精确位置恢复、ADAS 抢占、第二条
路线和隐私检查记录在 [`../docs/rdk-ios-companion-acceptance.md`](../docs/rdk-ios-companion-acceptance.md)。

### Simulator quick start

Run both terminals from the repository root:

```bash
# Terminal 1 — relay (repository root)
npm run dev:server

# Terminal 2 — build, install, and launch (repository root)
DEVICE="iPhone 17 Pro"
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination "platform=iOS Simulator,name=$DEVICE" build

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun simctl boot "$DEVICE"
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun simctl install "$DEVICE" \
  ~/Library/Developer/Xcode/DerivedData/MaxHelmet-*/Build/Products/Debug-iphonesimulator/MaxHelmet.app
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun simctl launch "$DEVICE" \
  com.horizon.maxhelmet
```

The simulator can connect to the Mac relay at `ws://localhost:8787/agent`.

### Physical device quick start

Running on a real iPhone needs a signing team. With a **free** Apple ID, add it once in
**Xcode ▸ Settings ▸ Accounts**, then select your **(Personal Team)** under the MaxHelmet target's
**Signing & Capabilities** so Xcode provisions an _Apple Development_ certificate. The repo already
pins `DEVELOPMENT_TEAM = V487HQQLC6`; change it to your own team if you are not on that account.
Run the following commands from the repository root.

```bash
# Find your connected device's UDID
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun devicectl list devices

UDID=<your-device-udid>
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer

# Build, install, and launch on the device
xcodebuild -workspace ios/MaxHelmet.xcworkspace -scheme MaxHelmet \
  -destination "id=$UDID" -configuration Debug \
  -derivedDataPath /tmp/MaxHelmetBuild -allowProvisioningUpdates build
xcrun devicectl device install app --device "$UDID" \
  /tmp/MaxHelmetBuild/Build/Products/Debug-iphoneos/MaxHelmet.app
xcrun devicectl device process launch --device "$UDID" com.horizon.maxhelmet
```

The device must have **Developer Mode** enabled (Settings ▸ Privacy & Security ▸ Developer Mode).
On the first launch, trust the developer under **Settings ▸ General ▸ VPN & Device Management** if
iOS shows an "Untrusted Developer" prompt. A free personal team's signature **expires after 7 days** —
re-run the build/install to refresh it. The installed app defaults to the Lightsail relay above.

### Permissions

| Permission / capability               | Why it is needed                                                            |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `NSMicrophoneUsageDescription`        | Stream rider speech to the relay.                                           |
| `NSLocationWhenInUseUsageDescription` | With precise When In Use approval, forward Helmet Ride navigation fixes.    |
| `NSLocalNetworkUsageDescription`      | Connect to a relay running on the same LAN during local development.        |
| `UIBackgroundModes = audio, location` | Keep voice active and an explicitly started Helmet Ride alive while locked. |
| `NSAllowsArbitraryLoads`              | Debug-plist-only support for `ws://` development relays.                    |

Location is optional. If denied, the server can use fallback weather coordinates.

Weather location and Helmet Ride are separate. Weather may operate with ordinary foreground
permission or a server fallback; RDK forwarding requires precise When-In-Use authorization plus
an explicit Start Helmet Ride. The system location indicator remains visible while forwarding
under lock. Force-quit terminates forwarding, and neither login nor relaunch resumes it.

### Self-signed test server

The Lightsail test box uses a self-signed certificate. In Debug only, the toggle
**信任自签名证书（仅调试）** gates a trust-all path and defaults on for a physical device. The
simulator defaults it off because it talks to local `ws://`. Release builds compile out the bypass,
hide the toggle, use the hardened `Info.plist`, and require a trusted certificate and hostname.

## What's implemented

- Helmet-only session toggle: tap the helmet once to start mic streaming and the relay session, then tap it again to stop. Mute is a separate, 44-point utility available only while the session is active.
- Native AMap route card: the first route shows a one-time Chinese disclosure before any AMap API use. Choosing **暂不启用** preserves maneuver text, ETA, prompts, rerouting, and stop-navigation while showing **地图未启用**; **启用地图** lets the rider reconsider. After acceptance, a configured key and valid geometry show the native AMap iOS 3D Map SDK; a missing key, invalid geometry, map load failure, or simulator shows an honest unavailable state instead. The app does not use the AMap Location SDK and has no MapKit fallback.
- SwiftUI turn-state HUD with the same captions, colors, controls, and ride cards as Android/web.
- Voice gender, personality, ride mode, and demo scenario selectors.
- 16 kHz PCM16 mono microphone streaming through `AVAudioEngine`.
- 24 kHz PCM16 gapless playback through `AVAudioPlayerNode`.
- Acoustic echo cancellation: capture and playback share **one** `AVAudioEngine` with the
  voice-processing I/O unit enabled, so the built-in speaker does not feed the agent's own
  voice back into the mic. See _Platform notes_ below.
- Barge-in: rider speech stops queued provider audio and fallback TTS.
- ADAS hazard alerts: reacts to the server `hazard.alert` event by interrupting playback, speaking
  the warning, and showing a pulsing directional banner; an `ADAS` demo scenario showcases them.
- Voice-triggered camera: "拍照" captures a photo and "开始录像 / 停止录像" records **silent** video —
  silent by design so the capture session never takes the mic and Max keeps listening (stop-by-voice
  works mid-clip). Captures land in an in-app **Max gallery** (grid, full-screen viewer, video player)
  with per-item **export to Photos** (add-only permission, copy + `已导出` badge) and delete. Storage is
  keep-until-deleted with a low-space refusal; recording auto-stops at 10 minutes. Reachable by the
  相册 button or "打开相册".
- Voice-triggered device actions: spoken commands drive the phone through the `device.command` /
  `device.result` protocol — torch on/off, Max's own playback volume, Apple Music / local-library
  playback, SMS composition, and dialing (including 110/120/122). Max's spoken confirmation always
  matches the real outcome, and every failure is spoken. Limits are deliberate and honest: dialing
  and SMS require the native iOS confirmation tap (truly hands-free dialing is impossible on iOS);
  music reaches only Apple Music and the local library, never 网易云/QQ音乐; SMS is refused above
  5 km/h. Contact numbers never leave the device, and spoken contact names are redacted from stored
  QA transcripts.
- Music commands reveal an in-app player with track/artist, previous, play/pause, next,
  and an embedded Apple Music library picker. Touch and voice share the system music queue;
  no Music-app URL is opened. Media access denial, an empty queue, and preparation errors
  produce failures instead of a false spoken success. This selects library music, not a
  catalog search by song name. The voice audio session mixes with music so playback can
  coexist with microphone capture and agent speech.
- Voice-triggered live navigation: "导航去X" starts in-app turn-by-turn guidance built on a pure
  `GuidanceEngine` — route matching, off-route detection, and prompt timing, all unit-tested from
  lat/lon literals — and speaks maneuver prompts at ~400 m, ~150 m, and the turn, with one debounced
  reroute per wrong turn and an arrival announcement. "停止导航" ends it. The live card shows the next
  maneuver, distance, and ETA over a route map. Routing is relay-side: `nav.request`/`nav.route`/
  `nav.error` over the agent socket reach the same Amap driving service the web HUD uses (GCJ-02 on
  the wire, WGS-84 inside the app, converted at the protocol boundary), so the keyless mock route
  works end-to-end with no Amap key configured. Guidance runs during the foreground hands-free
  session (the screen stays awake), so it needs no background-location permission. Honest limits:
  car routing only, so it does not respect 摩托车禁行 roads, and there is no MKDirections fallback —
  a relay that's down or unreachable is a spoken failure, not a silent retry elsewhere.
- Reconnect with exponential backoff and user-visible connection status.
- Live weather card and fused `态势摘要` ride-pulse card.
- Transcript with in-place updates, deduplication, timestamps, and JSON export via share sheet.
- `AVSpeechSynthesizer` fallback when the provider sends text without audio.
- Debug-only trust-all TLS path for the self-signed Lightsail test server.
- Keychain storage for relay/login bearer tokens, with migration from older `UserDefaults` values.
- Release-run/test-case/assignment attribution with explicit iOS platform and stamped git commit.

## Architecture

Music changes require a physical-iPhone check with a populated Music library (cloud songs
also require the appropriate account/subscription and network): start hands-free, ask to
play music, verify Max stays foreground and the music card appears, then use both touch
and voice for pause/resume/next/previous. Select songs and cancel the in-app picker; verify
metadata also updates after a headset/lock-screen control. Repeat on speaker and Bluetooth,
checking the mic level and an audible assistant reply while music plays. Check denied media
permission, an empty library/queue, and unavailable cloud songs. Simulator tests cannot
validate Apple Music playback or simultaneous hardware input/output.

The app mirrors the Android client's two-layer split. The `Agent/` layer is pure protocol +
audio + session logic; the `UI/` layer is the SwiftUI HUD.

| File                        | Role                                                                                                                                                                | Ports from                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Agent/AgentProtocol.swift` | Enums, event parsing, `session.start` builder, pure helpers (`combineHazardLevels`, `mapTurnState`, `detectLanguage`, `normalizeTranscriptText`, transcript export) | `shared/agent.ts`, `shared/ride.ts`, `shared/language.ts`, `android/.../AgentProtocol.kt` |
| `Agent/MicStreamer.swift`   | Mic capture → 16 kHz PCM16 mono, 320-sample (20 ms) frames; enables echo cancellation on the shared engine and owns its start/stop                                  | `public/pcm-worklet.js`, `MicStreamer.kt`                                                 |
| `Agent/PcmPlayer.swift`     | Gapless 24 kHz PCM16 playback + barge-in; attaches its player node to the shared engine                                                                             | playback cursor in `src/main.tsx`, `PcmPlayer.kt`                                         |
| `Agent/AudioRouter.swift`   | `AVAudioSession` voice-chat config + Bluetooth (HFP) routing                                                                                                        | `AudioRouter.kt`                                                                          |
| `Agent/AgentSession.swift`  | Relay WebSocket, reconnect backoff, transcript dedup, barge-in, `AVSpeechSynthesizer` TTS fallback, location, self-signed TLS, published state                      | `useHelmetAgent` in `src/main.tsx`, `AgentSession.kt`                                     |
| `UI/AgentScreen.swift`      | Voice-mode screen: animated helmet centerpiece (ported SVG), status caption, ADAS banner, captions overlay, minimal controls, and the unified 设置 sheet            | `src/components/HelmetVisual.tsx`, `AgentScreen.kt`                                       |
| `UI/MainViewModel.swift`    | Relay/cert preferences, Keychain-backed tokens, hands-free toggle, transcript export share sheet                                                                    | `MainViewModel.kt`                                                                        |
| `UI/HudTheme.swift`         | Design tokens                                                                                                                                                       | `src/styles.css`, `theme/Theme.kt`                                                        |
| `MaxHelmetApp.swift`        | App entry; keeps the screen awake, forces dark mode                                                                                                                 | `MainActivity.kt`                                                                         |

### Platform notes vs. Android

- **Background audio and explicit Helmet Ride location** replace Android foreground services:
  `UIBackgroundModes = audio, location` keeps voice alive and permits an explicitly started
  Helmet Ride to continue forwarding under the iOS location indicator while locked. There is
  no separate Android-style service notification.
- **Bluetooth routing** is handled by iOS itself — `AVAudioSession` with `.playAndRecord` +
  Bluetooth category options automatically prefers a connected HFP headset, so there is no
  manual SCO start/stop.
- **Echo cancellation** is the iOS analogue of the web's `getUserMedia({ echoCancellation })`.
  iOS only cancels echo _within a single_ `AVAudioEngine`: enabling voice processing on the
  input node (`setVoiceProcessingEnabled(true)`) makes the voice-processing I/O unit subtract
  whatever is rendered through **that same engine's** output from the mic signal. So
  `MicStreamer` (capture) and `PcmPlayer` (playback) share one `AVAudioEngine` owned by
  `AgentSession` (`voiceEngine`): the player node is attached before the mic starts the engine,
  giving the canceller its reference signal. Two separate engines (the earlier design) gave the
  canceller no reference, so on the built-in speaker the mic picked up the agent's own voice and
  it replied to itself — AirPods masked the bug by isolating the audio path. Voice processing
  must be enabled while the engine is stopped; it can only be confirmed audibly on a physical
  device, since the Simulator does not model speaker→mic acoustic feedback.
- **TTS fallback** uses `AVSpeechSynthesizer` (the mock provider returns reply text but no
  audio; Doubao returns synthesized audio).

When the relay protocol or the web-side helpers (`shared/agent.ts`, `shared/ride.ts`,
`shared/language.ts`, the pure functions in `src/main.tsx`, or the dedup logic mirrored in
`server/providers/doubao.ts`) change, update this app's `Agent/` layer alongside the Android
counterparts.

## Verifying the build

CI/parity checks should run on a Mac runner with full Xcode installed:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  HORIZON_GIT_COMMIT=$(git rev-parse --short=12 HEAD) build
```

For a release candidate, also record the full reviewed SHA, Xcode build configuration, app build
number, physical device model, and iOS version in the acceptance template. Debug self-signed trust
is for the controlled test relay only; a production build must connect through a hostname-matched,
publicly trusted TLS certificate.

## Troubleshooting

| Symptom                               | Check                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xcodebuild` cannot find simulators   | Use full Xcode via `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.                                                                                      |
| Simulator app stays offline           | Use `ws://localhost:8787/agent` and make sure `npm run dev:server` is running.                                                                                      |
| Physical iPhone cannot connect        | Default is `wss://3.35.135.136/agent` (self-signed on); for a Mac relay use `ws://<Mac-LAN-IP>:8787/agent`, grant local-network permission, and check the firewall. |
| Device app won't launch after ~7 days | Free personal-team signature expired — re-run the device build/install to refresh it.                                                                               |
| Mic permission prompt does not appear | Reset app privacy in Simulator or delete/reinstall the app.                                                                                                         |
| Self-signed test server fails         | Use a Debug build and enable its self-signed certificate toggle. Release builds require trusted TLS.                                                                |
| App launches but no live weather      | Grant location permission or configure fallback coordinates on the server.                                                                                          |
| Bluetooth route is not selected       | Pair the headset before starting the session; iOS chooses HFP routing automatically.                                                                                |

## Release caveats

- `NSAllowsArbitraryLoads` and the trust-all path are restricted to Debug; Release uses normal ATS
  certificate and hostname validation.
- Configure a real signing team, bundle ID, versioning, icons, and privacy text before TestFlight.
- Keep the protocol parity checklist in sync with web and Android whenever `/agent` changes.
