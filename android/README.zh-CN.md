# Max 头盔助手 — Android App

简体中文 · [English](README.md)

Android 客户端使用 Kotlin 和 Jetpack Compose，通过与网页、iOS 相同的 `/agent` WebSocket 协议连接 Node.js 中继。手机负责麦克风采集、24 kHz 语音播放、定位、原生设备操作和界面；豆包凭据、高德 Web 服务密钥和测试数据留在中继端。

## 环境要求

- Android Studio 及其自带的 JBR/JDK。Gradle 需要 JDK 17–21，不要使用 Homebrew Java 25 或更新版本。
- Android SDK Platform 36.1；Android 8.0（API 26）或更新版本的设备或模拟器。
- 仓库使用 Gradle Wrapper 9.4.1、Android Gradle Plugin 9.2.1、Kotlin 2.2.10 和 Compose BOM 2024.09.03。

## 构建与检查

首次在 Android Studio 打开 `android/` 时，通常会自动生成不纳入 Git 的 `local.properties`。命令行构建也可以直接设置 `ANDROID_HOME`：

```bash
cd android
ANDROID_HOME="$HOME/Library/Android/sdk" \
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
MAX_GIT_COMMIT=$(git -C .. rev-parse --short=12 HEAD) \
./gradlew assembleDebug
```

产物位于 `app/build/outputs/apk/debug/app-debug.apk`。如需在 `local.properties` 写入 SDK 路径，可参考 `local.properties.example`；不要提交该文件。运行单元测试和 Debug Lint：

```bash
ANDROID_HOME="$HOME/Library/Android/sdk" \
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
./gradlew testDebugUnitTest lintDebug
```

## 连接中继

从仓库根目录运行 `npm run dev:server`。中继监听 `0.0.0.0:8787`。安装 App 后，点底部齿轮打开 **设置 → 连接**，填写 **语音中继地址**：

| 运行位置         | 中继 URL                                                                 |
| ---------------- | ------------------------------------------------------------------------ |
| Android 模拟器   | `ws://10.0.2.2:8787/agent`（默认；指向宿主机）                           |
| 真机、同一局域网 | `ws://<开发机局域网 IP>:8787/agent`                                      |
| USB 连接的真机   | 先运行 `adb reverse tcp:8787 tcp:8787`，再用 `ws://127.0.0.1:8787/agent` |

点头盔开始或结束免手会话。麦克风权限必需；定位可选，用于天气，导航需要精确定位。`VOICE_PROVIDER=mock` 为无凭据演示，`doubao` 为实时语音。**QA 任务归因**可填写活动、用例、发布批次和分配 ID；下一次 `session.start` 会连同 `platform=android` 和构建 SHA 发送。

模拟器快速启动示例（第一个终端在仓库根目录启动中继，第二个终端在 `android/` 目录执行）：

```bash
npm run dev:server

~/Library/Android/sdk/emulator/emulator -avd Medium_Tablet &
ANDROID_HOME="$HOME/Library/Android/sdk" \
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
./gradlew installDebug
~/Library/Android/sdk/platform-tools/adb shell am start -n io.github.henrycooper86.max/.MainActivity
```

## 权限

| 权限                                                  | 用途                               |
| ----------------------------------------------------- | ---------------------------------- |
| `INTERNET`                                            | 连接中继                           |
| `RECORD_AUDIO`                                        | 采集骑手语音，上传 16 kHz PCM16 帧 |
| `ACCESS_COARSE_LOCATION`、`ACCESS_FINE_LOCATION`      | 天气、导航和显式启动的 Helmet Ride |
| `FOREGROUND_SERVICE_MICROPHONE`、`POST_NOTIFICATIONS` | 后台免手会话与前台服务通知         |
| `BLUETOOTH_CONNECT`、`MODIFY_AUDIO_SETTINGS`          | 头盔耳机及扬声器/麦克风路由        |
| `CAMERA`                                              | 拍摄、录像和手电筒命令             |
| `READ_CONTACTS`                                       | 通过语音姓名查找联系人             |

未授予天气定位权限时，中继仍可使用服务端备用坐标。设备能力的权限按需申请；拨号和短信使用系统确认界面。

## 已实现能力

- 点头盔开关会话；会话中可单独静音。界面提供状态提示、可选字幕、天气、风险摘要、时延、演示场景和日志 JSON 导出。
- 上行使用 `AudioRecord` 发送 16 kHz PCM16、20 ms 帧；下行使用 `AudioTrack` 播放 24 kHz PCM16。说话时可打断 Max 的声音。文字无音频时由系统 TTS 兜底。
- WebSocket 指数退避重连；麦克风前台服务；Keystore 支持的 AES-GCM 令牌存储；Debug 构建可显式信任测试服务器的自签名证书，Release 构建要求可信 TLS 并拒绝明文。
- 模拟 ADAS `hazard.alert` 会打断播放、朗读方向警告并显示横幅。当前检测是演示注入，真实传感器告警仍需验证。
- 语音设备操作包括手电筒、Max 自身音量、音乐、拨号/短信、拍照/静音录像、相册和导航。未知或格式错误的命令会返回失败，不会无声超时；速度未知或超过 5 km/h 时拒绝短信。
- 自有音乐队列支持文件选择、播放/暂停、上一首/下一首和关闭。锁屏、离开 App、关闭卡片或结束会话会暂停；回来后不会自动恢复。不控制其他 App，也不接入受保护的 Apple Music 曲库。
- CameraX 拍照和无声录像；低空间拒绝、十分钟或 1 GB 限制、切到后台停止。相册可浏览、删除和导出；描述照片上传一帧，视频上传八帧，不上传完整视频。

## 导航

说“导航去 X”开始，“停止导航”结束。客户端经 `/agent` 发送 `nav.request` 并接收 `nav.route` / `nav.error`；服务端未配置 `AMAP_API_KEY` 时仍提供固定演示路线。原生地图另需为 Android 包名和签名证书注册的高德密钥：构建时设置 `AMAP_ANDROID_KEY`，或在忽略提交的 `local.properties` 中设置 `amap.android.key=...`。iOS 和服务端的密钥不能代用。

- 路线和 App 内导航坐标使用 GCJ-02；GPS 的 WGS-84 位置只在 `NavigationController` 边界转换一次。
- 与网页和 iOS 一致的引导规则在约 400 米、150 米和转弯处提示；偏航后限频重算，到达后宣布结束。重算失败会明确停止引导。
- 用户同意地图披露后才初始化高德 SDK。拒绝地图或密钥/图块不可用时，文字和语音导航继续，地图显示不可用状态。
- 首次 GPS 定位限时八秒，约 1.5 秒时给出等待提示。导航只在前台免手会话内运行，不申请后台导航定位权限。
- 当前使用驾车路线，**不识别摩托车禁行道路**。

## 协议与代码结构

变更 `shared/agent.ts`、`shared/ride.ts`、`shared/language.ts` 或音频帧格式时，要同步检查 `agent/AgentProtocol.kt`、`AgentSession.kt`、`MicStreamer.kt`、`PcmPlayer.kt` 与相关测试。主要模块：

| 路径                           | 职责                         |
| ------------------------------ | ---------------------------- |
| `agent/`                       | 协议、会话、音频和重连       |
| `service/VoiceAgentService.kt` | 麦克风前台服务               |
| `navigation/`                  | 坐标、路线、引导和地图状态   |
| `capture/`、`music/`           | 拍摄与自有音乐队列           |
| `ui/`                          | Compose 骑行界面、设置与相册 |

## RDK 骑行与事故检查

设置页提供六位码或附近发现配对，以及单独的 **开始/停止 Helmet Ride**。必须先登录账号；手动粘贴的中继操作员令牌不能用于伴侣配对。开始骑行需要精确定位，并显示可停止的前台通知。手机免手模式与 Helmet Ride 互斥；退出登录或取消配对会停止位置分享，进程结束后不会自动恢复。

手机免手会话可在传感器可用时启用碰撞检测。事故流程包括 15 秒确认和 30 秒警报；“我没事”/“取消”、事故界面或通知可取消。紧急联系人通知需要用户选择加入，失败会明确显示；电话只打开拨号界面，**不会自动拨出**。Debug 的本地事故演练不能通知联系人。

## 测试服务器、故障排查与发布

Debug 构建可使用共享 Lightsail 测试中继 `wss://3.35.135.136/agent` 并打开“信任自签名证书”。Release 构建不提供此选项，必须使用可信域名和证书。

| 现象                | 检查项                                                       |
| ------------------- | ------------------------------------------------------------ |
| 模拟器离线          | 用 `10.0.2.2`，不要用指向模拟器自己的 `localhost`            |
| 真机无法连接        | 检查同一局域网、开发机 IP 和防火墙；USB 可使用 `adb reverse` |
| 麦克风无声音        | 检查权限和其他 App 是否占用音频                              |
| 蓝牙耳机未使用      | 检查 Android 12+ 蓝牙权限与耳机 HFP/SCO 支持                 |
| 测试服务器 TLS 失败 | 仅 Debug 可开启自签名信任；Release 必须用可信 TLS            |
| Java 版本错误       | 使用 Android Studio 自带 JBR                                 |

`VOICE_COMMUNICATION` 采集源与 `AcousticEchoCanceler` / `NoiseSuppressor` 负责回声与噪声处理；真实扬声器、蓝牙和音乐混音效果仍需设备验收。Debug APK 不能直接作为正式分发包；发布前需配置签名，保持前台服务通知可见，并验证高德地图密钥、事故传感器、紧急通知和 RDK 实机配对。详见[移动端一致性审查](../docs/mobile-parity.md)与[HUD 投屏原型](../docs/rdk-hud-casting.md)。
