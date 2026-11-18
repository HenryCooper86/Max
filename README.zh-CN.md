# Max 摩托车头盔 AI

简体中文 · [English](README.md)

Max 是面向摩托车头盔的语音助手与发布前测试框架。项目包含网页骑行界面、iOS 与 Android 客户端、RDK X5 头盔端、Node.js 实时中继，以及测试归因和发布评审功能。Max 默认使用中文，也支持英语。默认的 `mock` 模式不需要语音服务凭据；接入豆包实时语音需要单独配置服务端凭据。

## 当前能力

- **免手操作：**持续麦克风会话、语音打断、实时字幕、断线重连、语音播放和浏览器/系统 TTS 兜底。实时豆包模式支持“Max”唤醒词；免手会话期间麦克风仍会持续传输音频。
- **骑行场景：**通勤、横风、低油、小队、紧急和 ADAS 演示；语音与界面会反映骑行模式、天气、风险和时延。当前 ADAS 注入属于模拟检测，不能代替真实传感器告警。
- **导航：**网页、iOS 和 Android 通过中继使用同一套路线协议和引导规则。未配置高德 Web 服务密钥时可运行确定性的演示路线。高德当前使用驾车路线，不识别摩托车禁行道路。地图需要各平台对应的密钥和用户同意；地图不可用时仍可使用文字与语音引导。
- **移动端：**iOS 与 Android 使用原生音频、设置页、账号登录、相册/拍摄、音乐与设备操作。RDK 头盔可与账号配对，并通过独立的 Helmet Ride 流程接收手机定位。碰撞检测、紧急联系及蓝牙音频等仍需真机验收。
- **视觉：**RDK 前置摄像头可响应主动“看看前面”，也可选择开启环境观察。iOS 相册描述只上传用户请求描述的照片或视频关键帧。没有 `ARK_API_KEY` 和 `ARK_MODEL` 时使用固定演示回答；真实视觉模型的效果需要现场验证。
- **测试与评审：**带测试员、活动、用例、版本与设备归因的会话证据；发布批次、策略、评审、审计和故障矩阵。默认不保留原始麦克风音频。

## 技术栈与目录

| 路径                   | 内容                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/`                 | React 19、Vite 8、TypeScript 网页骑行界面；`App.tsx` 组织界面，`hooks/useHelmetAgent.ts` 管理会话                    |
| `server/`              | Express 5、WebSocket 中继、豆包/模拟服务、认证、测试数据与路由                                                       |
| `shared/`、`protocol/` | 跨平台规则和事件 Schema；`npm run generate:protocol` 生成语言绑定                                                    |
| `android/`             | Kotlin、Jetpack Compose 原生客户端；详见 [Android 中文说明](android/README.zh-CN.md)（[English](android/README.md)） |
| `ios/`                 | Swift、SwiftUI 原生客户端；详见 [iOS 中文说明](ios/README.zh-CN.md)（[English](ios/README.md)）                      |
| `rdk/`                 | RDK X5 语音、视觉、AEC 与 systemd 服务；详见 [RDK 中文说明](rdk/README.zh-CN.md)（[English](rdk/README.md)）         |
| `tests/`               | 网页、服务端与共享逻辑的 Vitest 测试                                                                                 |

浏览器和移动端仅连接自己的 `/agent` 中继；豆包密钥留在服务端。开发模式下，Vite 在 `5173` 端口提供网页并代理 `/agent` 和 `/health`，Express 在 `8787` 端口提供中继。生产模式下，Express 还会提供构建后的 `dist/` 静态文件。

## 快速开始

需要 Node.js **22.13 或更新版本**。在仓库根目录执行：

```bash
npm install
cp .env.example .env
npm run dev
```

打开 `http://localhost:5173`。默认 `VOICE_PROVIDER=mock`，无需豆包或高德密钥。按界面上的免手按钮或空格键开始、结束会话；首次启动请授予麦克风权限。定位权限用于天气和导航。网页界面可在设置页切换中文与英语；这个开关只改变界面文字。

移动端先启动 `npm run dev:server`，再在 App 的 **设置 → 连接** 填写中继地址：

| 客户端                    | 本机开发中继地址                    |
| ------------------------- | ----------------------------------- |
| Android 模拟器            | `ws://10.0.2.2:8787/agent`          |
| Android 真机、iPhone 真机 | `ws://<开发机局域网 IP>:8787/agent` |
| iOS 模拟器                | `ws://localhost:8787/agent`         |

真机使用共享测试服务器时，请以团队当前发布信息核对地址与证书。自签名证书开关仅在 Debug 构建中提供；Release 构建需要可信证书和正常主机名验证。iOS、Android、RDK 的构建步骤分别见各自 README。

## 环境配置

从 [`.env.example`](.env.example) 复制配置，不要提交真实凭据。常用配置如下；完整参数、默认值和约束见模板及[英文配置说明](README.md#environment-variables)。

| 变量                                            | 用途                                           |
| ----------------------------------------------- | ---------------------------------------------- |
| `VOICE_PROVIDER`                                | `mock`（默认）或 `doubao`                      |
| `DOUBAO_API_KEY`、`DOUBAO_RESOURCE_ID`          | 豆包实时语音凭据与资源标识                     |
| `ARK_API_KEY`、`ARK_MODEL`                      | 真实视觉描述；未配置时使用固定模拟结果         |
| `AMAP_API_KEY`                                  | 服务端地点搜索与驾车路线；未配置时使用演示路线 |
| `AMAP_JS_KEY`、`AMAP_JS_SECRET`                 | 网页地图；安全密钥仅保留在服务端代理           |
| `RELAY_AUTH_TOKEN`、`RELAY_ALLOWED_ORIGINS`     | 可选的中继令牌与网页来源限制                   |
| `RELAY_TRUST_PROXY`、`RELAY_TRUSTED_PROXY_HOPS` | 部署在可信反向代理之后时的客户端地址解析       |
| `AGENT_WAKE_WORD`、`WEATHER_REFRESH_MS`         | 实时唤醒词和天气刷新配置                       |

## API 与安全

`GET /health` 是小型公开存活检查；`GET /ready` 报告配置和持久化存储的就绪状态。`WS /agent` 承载语音与导航事件，`WS /companion` 承载已认证的头盔配对和位置转发。`/auth/*` 提供账号与会话，`/testing/*` 提供按角色授权的测试证据、发布批次和评审。接口细节见[英文 API 章节](README.md#api-routes)。

服务端可配置令牌、来源白名单和按客户端地址的滑动窗口限流。部署在反向代理后需要正确配置 `RELAY_TRUST_PROXY` 与可信代理跳数。网页的本地字幕缓存按账号 UUID 隔离；Android 使用 Keystore 支持的加密存储，iOS 使用 Keychain 保存令牌。不要在仓库或工单中放入真实密钥、令牌或骑行者数据。

## 网页测试与管理工作区

“设置”中分别提供“测试”和“管理”入口。“测试”位于 `/#/testing/overview`，包含测试计划与测试记录：只展示易读的任务说明、对话、结果、备注和反馈，不显示构建哈希、系统标识符、原始检查详情或遥测表格。审核员与管理员还会看到质量概览、发布验证、测试诊断与测试策略等 QA 页面；原始技术细节仅以明确标注、默认折叠的“技术详情”呈现给审核员与管理员。记录不完整时，即使自动检查通过，也会单独标记为“记录不完整”。手机进入对话详情后收起列表筛选，点击“返回结果列表”即可恢复。

“管理”位于 `/#/admin/overview`，仅管理员可用，包含账号概览、账号管理与审计历史；审核员留在测试工作区，测试员无法进入管理工作区。App 令牌复制仍为自助功能：审核员在测试工作区的账号菜单、管理员在管理账号菜单各自复制；测试员不显示该入口。

所选页面、发布批次、会话和筛选条件支持分享、刷新及浏览器前进/后退。未保存的备注与复核草稿按账号和角色隔离，保存在当前浏览器标签页，并可跨测试/管理工作区保留；离开时可取消或明确放弃。测试计划只显示已分配任务；浏览器任务可配置后返回语音测试，其他设备任务明确提示使用对应客户端。发布批准与策略发布仍需单独确认，权限继续由服务端强制执行。

## 检查与构建

```bash
npm run check             # 协议、格式、Lint、死代码、RDK TS、测试、故障矩阵、网页构建
npm run test:rdk-vision   # 需要 Python pytest 及 rdk/vision/requirements-dev.txt 中的依赖
npm run build             # TypeScript 检查与 Vite 生产构建
```

Android 本地测试需要 Android SDK 和 Android Studio 的 JBR：

```bash
cd android
ANDROID_HOME="$HOME/Library/Android/sdk" \
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
./gradlew testDebugUnitTest lintDebug
```

iOS 使用 `ios/MaxHelmet.xcworkspace`，先按 [iOS 说明](ios/README.md) 安装 CocoaPods 并配置忽略提交的 `Secrets.xcconfig`。发布前还需执行真机地图、蓝牙、音频、碰撞与头盔配对验收；自动化测试不能替代道路和硬件验证。

## 部署与后续工作

共享 Lightsail 测试服务器的部署脚本为 `deploy-lightsail.command`。它要求干净的工作树、已评审的 `main` 提交，以及与 `gitlab/main` 一致的 SHA；从开发机推送构建产物，并在存活/就绪检查失败时回滚。具体步骤和持久化数据预检见[英文部署章节](README.md#build--deployment-pipeline)及 [RDK 伴侣验收说明](docs/rdk-ios-companion-acceptance.md)。

接下来的工作重点是附近停靠点工具、真实 ADAS 传感器与置信度、可信证书、以及各平台和 RDK 的真机验收。移动端一致性记录见[移动端一致性审查](docs/mobile-parity.md)。
