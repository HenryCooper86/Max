# Max 头盔助手 — iOS App

简体中文 · [English](README.md)

iOS 客户端使用 Swift 和 SwiftUI，与网页及 Android 使用相同的 `/agent` 中继协议。App 实现原生音频路由、后台音频、定位、拍摄、音乐、导航和 RDK 头盔配对；豆包与高德 Web 服务凭据留在中继端。

## 环境要求

- Xcode 16 或更新版本；iOS 17 或更新版本的模拟器或设备。
- 真机需要 Apple Developer 签名团队；模拟器不需要。
- Homebrew Ruby 3.2–4.x、Bundler 4.0.16。仓库锁定 CocoaPods 1.16.x；系统自带 `/usr/bin/ruby` 版本太旧。

## 安装依赖与构建

在仓库根目录执行，明确选用 Homebrew Ruby：

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

脚本会核对 Ruby、Bundler、CocoaPods 和依赖。只在忽略提交的 `Config/Secrets.xcconfig` 中设置 `AMAP_IOS_KEY`，不要提交真实密钥。用 Xcode 打开 `ios/MaxHelmet.xcworkspace` 运行；真机构建需在 `Config/Secrets.xcconfig` 中写入 `MAX_DEVELOPMENT_TEAM = <你的团队 ID>`（项目文件不再固定团队），并设置 `MAX_RELAY_HOST`（Release 真机构建缺少它会直接编译失败）。版本号在 `Config/Base.xcconfig` 的 `MARKETING_VERSION`，构建号通过 `xcodebuild ... MAX_BUILD_NUMBER=<n>` 传入。新增 Swift 源文件由同步文件组自动纳入 target。

从仓库根目录构建模拟器版本：

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild \
  -workspace ios/MaxHelmet.xcworkspace \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  MAX_GIT_COMMIT=$(git rev-parse --short=12 HEAD) build
```

如果命令行工具当前指向 Command Line Tools，保留上面的 `DEVELOPER_DIR` 设置即可。CI 与发布候选构建应写入 `MAX_GIT_COMMIT`；未标记的本地构建会诚实报告 `unknown`。

## 连接中继

在仓库根目录运行 `npm run dev:server`，然后打开 App，点底部齿轮进入 **设置 → 连接** 修改 **语音中继地址**。

| 运行位置           | 中继 URL                                                             | 默认值                             |
| ------------------ | -------------------------------------------------------------------- | ---------------------------------- |
| iOS 模拟器         | `ws://localhost:8787/agent`                                          | 是                                 |
| iPhone 真机        | `wss://<MAX_RELAY_HOST>/agent`，例如 `wss://relay.example.com/agent` | 设置了 `MAX_RELAY_HOST` 时为默认值 |
| 同一局域网的开发机 | `ws://<开发机局域网 IP>:8787/agent`                                  | 需手动填写                         |

在真机上，`localhost` 指向手机本身，默认中继来自 `Config/Secrets.xcconfig` 中的 `MAX_RELAY_HOST`；未设置时点头盔会显示「未配置语音中继」卡片，而不会去连接任何地址。Debug 构建可使用设置中的自签名测试证书选项；Release 构建没有该绕过，必须使用主机名匹配的可信证书。点头盔开始或结束会话。麦克风必需，天气定位可选；`VOICE_PROVIDER=mock` 为脚本演示，`doubao` 为实时语音。

**QA 任务归因**可输入活动、用例、发布批次和分配 ID；下一次 `session.start` 会连同 `platform=ios` 与构建 SHA 一起发送。

## RDK 头盔配对与 Helmet Ride

RDK 定位转发是独立、显式的流程。登录、打开 App 或启动手机免手会话都不会自动开始：

1. 先登录账号，在 **RDK 头盔** 设置中输入头盔显示的六位配对码并点 **配对头盔**。配对不会启动定位。
2. 确认头盔在线后点 **开始 Helmet Ride**。首次使用时授权 **使用 App 期间**，并保持 **精确位置** 开启。骑行时 iOS 会显示位置指示器；锁屏后仍可向头盔转发新位置。
3. 结束时点 **停止 Helmet Ride**。**取消配对**和**退出登录**也会先停止转发。

头盔连接只接受登录取得的**账号会话令牌**；连接设置中的**手动操作员令牌**仅用于 `/agent`，不能替代账号登录。App 不显示地图、不显示原始坐标、不持久化位置或配对码。**强制退出** App 会结束后台转发，重新启动后**不会自动恢复** Helmet Ride。Debug 可连接自签名测试中继；生产/Release 必须使用受信任证书。部署与回滚、锁屏十分钟、断网恢复、ADAS 抢占和隐私验收详见 [RDK 伴侣验收说明](../docs/rdk-ios-companion-acceptance.md)。

## 快速运行

模拟器：先在一个终端从仓库根目录执行 `npm run dev:server`，再构建、启动、安装 App：

```bash
DEVICE="iPhone 17 Pro"
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild \
  -workspace ios/MaxHelmet.xcworkspace -scheme MaxHelmet \
  -destination "platform=iOS Simulator,name=$DEVICE" build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun simctl boot "$DEVICE"
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun simctl install "$DEVICE" \
  ~/Library/Developer/Xcode/DerivedData/MaxHelmet-*/Build/Products/Debug-iphonesimulator/MaxHelmet.app
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun simctl launch "$DEVICE" \
  io.github.henrycooper86.max
```

真机需签名团队，开启 **设置 → 隐私与安全性 → 开发者模式**。在 Xcode 的账号和 target 签名设置中选择自己的团队；如提示不受信任的开发者，在设备的 VPN 与设备管理中信任。免费个人团队签名约七天后过期，需要重新安装。

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcrun devicectl list devices
UDID="replace-with-device-udid"
xcodebuild -workspace ios/MaxHelmet.xcworkspace -scheme MaxHelmet \
  -destination "id=$UDID" -configuration Debug \
  -derivedDataPath /tmp/MaxHelmetBuild -allowProvisioningUpdates build
xcrun devicectl device install app --device "$UDID" \
  /tmp/MaxHelmetBuild/Build/Products/Debug-iphoneos/MaxHelmet.app
xcrun devicectl device process launch --device "$UDID" io.github.henrycooper86.max
```

## 权限与隐私

| 权限或能力                                 | 用途                                       |
| ------------------------------------------ | ------------------------------------------ |
| 麦克风                                     | 向中继发送骑手语音                         |
| 使用期间定位与精确位置                     | 天气、导航和显式启动的 Helmet Ride         |
| 本地网络                                   | 连接局域网中继、发现附近头盔               |
| 后台模式 `audio`、`location`               | 维持音频，以及锁屏时显式启动的 Helmet Ride |
| 相机、照片添加、通讯录、音乐库、运动传感器 | 按需拍摄/导出、联系、音乐与事故检测        |

普通天气可使用前台定位或服务端备用坐标；Helmet Ride 需要精确定位与明确的启动操作。Debug 的 `Info-Debug.plist` 允许开发用 `ws://` 与自签名测试服务器；Release 的 `Info.plist` 不提供信任绕过。

## 已实现能力

- 点头盔开关免手会话；会话中可单独静音。界面提供状态、可选字幕、ADAS 横幅、天气、风险摘要、场景和设置。
- 上行 `AVAudioEngine` 发送 16 kHz PCM16、20 ms 帧；下行 `AVAudioPlayerNode` 播放 24 kHz PCM16。采集和播放共享一套语音处理引擎以提供回声消除；骑手说话时可打断播放。真实扬声器与蓝牙表现需真机确认。
- WebSocket 断线重连、实时字幕去重、JSON 日志导出、`AVSpeechSynthesizer` 文字兜底；Keychain 保存令牌并迁移旧偏好设置。
- 高德原生路线卡仅在用户同意后初始化 SDK。拒绝地图、缺少密钥、几何无效或加载失败时，文字、ETA、语音提示与偏航重算继续工作。地图不使用 MapKit 兜底。
- “导航去 X”经中继请求驾车路线，约 400 米、150 米和转弯处提示，偏航后限频重算，到达后宣布结束；“停止导航”终止。当前不识别摩托车禁行道路。
- 语音拍照和**无声录像**，不会占用 Max 的麦克风。Max 相册可浏览、删除、导出到系统照片；低空间时拒绝拍摄，录像十分钟后自动结束。相册描述仅发送所选照片或视频关键帧。
- 语音控制手电筒、Max 自身音量、Apple Music/本地音乐、短信撰写与拨号。短信和拨号仍需 iOS 系统确认；速度超过 5 km/h 时拒绝短信。无法控制网易云/QQ 音乐等第三方队列。
- 模拟 ADAS 警告可打断语音并显示方向；真实危险检测仍需硬件与道路验证。

## 代码结构与同步检查

| 路径                                          | 职责                                  |
| --------------------------------------------- | ------------------------------------- |
| `Agent/AgentProtocol.swift`                   | 事件、字幕、骑行状态和纯逻辑          |
| `Agent/MicStreamer.swift`、`PcmPlayer.swift`  | 音频采集、播放、回声消除与打断        |
| `Agent/AgentSession.swift`                    | WebSocket 会话、重连、字幕、TTS、定位 |
| `UI/AgentScreen.swift`、`MainViewModel.swift` | 主界面、设置和状态                    |
| `MaxHelmetApp.swift`                          | App 入口                              |

网页/服务端的事件、骑行模式、语言和字幕规则变更时，应同步检查 `Agent/`、Android 对应模块与协议测试。Apple Music、蓝牙、扬声器回声、锁屏导航、后台定位、实际地图图块均需要物理 iPhone 验收。

## 构建验证、故障排查与发布

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild \
  -workspace ios/MaxHelmet.xcworkspace -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

| 现象             | 检查项                                                     |
| ---------------- | ---------------------------------------------------------- |
| 找不到模拟器     | 明确设置完整 Xcode 的 `DEVELOPER_DIR`                      |
| 模拟器离线       | 使用 `ws://localhost:8787/agent`，确认中继已启动           |
| 真机离线         | 核对中继 URL、局域网权限与防火墙；自签名选项仅适用于 Debug |
| 约七天后无法打开 | 免费个人团队签名可能已过期，重新构建安装                   |
| 无声音或回声     | 检查麦克风/蓝牙路由，并用真机测试扬声器与耳机              |

发布候选应记录已评审 SHA、Xcode 配置、构建号、设备和 iOS 版本。生产中继需要主机名匹配、公开受信任的 TLS 证书。手机导航可通过开发版的 **投屏到 HUD** 发往 RDK 的 `/cast` 页面；设置和验收见 [HUD 投屏说明](../docs/rdk-hud-casting.md)。
