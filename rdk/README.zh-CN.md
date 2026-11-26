# Max on RDK X5

简体中文 · [English](README.md)

这是 Max 头盔助手的 RDK X5 嵌入式客户端。`rdk/agent/` 负责语音会话、HUD 与中继连接，`rdk/vision/` 负责双摄、相册、视觉服务和 ADAS 影子模式，`rdk/aec/` 提供进程内回声消除。本文提供中文部署、运行、验收和已知限制；[英文 README](README.md)还保留逐次硬件实验的原始数据、命令、时间线与完整受审部署脚本。设计背景见[嵌入式客户端设计](../docs/superpowers/specs/2026-07-25-rdk-x5-embedded-client-design.md)。

## 初始化

板卡需 Node.js 22.13 或更新版本、ALSA 工具、Python 及视觉依赖。Ubuntu 22.04 自带的 Node 版本过旧。以下命令在板卡运行：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs alsa-utils python3-pip
node --version

sudo install -d -m 0700 /var/lib/max
sudo install -d -m 0700 /var/lib/max/gallery
sudo mkdir -p /etc/systemd/system.conf.d
sudo cp rdk/systemd/10-max-watchdog.conf /etc/systemd/system.conf.d/
sudo systemctl daemon-reexec
```

`/var/lib/max/device-id` 是每块板卡独有的持久身份。首次启动时由 Agent 以私有权限生成；升级期间保留，不要复制到其他板卡，也不要在验收记录中输出其原值。`/run/max` 是临时目录，由 `max-vision.service` 的 `RuntimeDirectory=max` 在每次服务启动时创建；手工创建会在重启后消失。

## 硬件检查

将每一步的结果记录在[英文版硬件检查与实验记录](README.md#hardware-checklist)，再开始语音或摄像头验收：

1. 运行 `arecord -l` 与 `aplay -l`，确认 ES8326 音频卡的采集和播放设备号，并填入 `RDK_ALSA_CAPTURE`、`RDK_ALSA_PLAYBACK`。
2. 用 `arecord` 录制讲话片段，再用 `aplay` 回放，确认耳机接线（CTIA/OMTP）、音量及双工能力。只看 RMS 或扫频不能证明真实对话没有回声。
3. 检查前后摄像头的物理接口和 MIPI 通道。已验收板卡上，CAM1 前摄是通道 `0`，另一接口后摄是通道 `2`；每个接口只有一个可用的 camera host。不要把供应商 `open_cam` 自动检测当成可靠预检。
4. 检查供电、温度和服务日志。历史台架记录显示高负载时温度较高；道路、环境温度和电源条件仍需单独验收。

板卡 IP 会随网络变化；英文记录中的 `192.168.50.9` 是旧示例。先找到当前地址再使用 SSH。前后摄都工作时，每路可独立预览和录像；同一摄像头不能由两个进程同时占用。

## 声学与摄像头实验结论

- **回声消除：**单纯把 ES8326 `CROSSTALK` 降为 `0` 会让 Max 听见自己并形成对话循环；默认硬件抑制又会影响打断。当前使用 `rdk/aec/max-aec` 的 WebRTC APM 进程内 AEC，使回声消除和语音打断同时可用。任何更改混音器或音频路径都要重做真实对话测试，不能只看扫频指标。
- **摄像头：**已测 OV5647 在 host 0 工作、在 host 2 失败；IMX219 在 host 2 工作。不能把单个端口的失败推断为传感器型号整体不支持。`mipi_cam` 的默认 ROS topic 会让双实例混在同一 `/image_raw`，双摄要使用独立 topic。
- **相册与录像：**双路录制使用 JPEG 连接形成 `.mjpeg` 片段，实测每路约 9.8 fps；元数据记录实际帧率与时长。该格式存储开销高，H.264 仍受底层摄像头绑定无法打开的限制。
- **视觉描述：**如果视觉模型认证、网络、响应格式或超时出错，中继返回“我看不清”，不会编造描述。没有 Ark 凭据时使用固定演示结果；真实描述能力仍需有效凭据和现场质量验收。

完整传感器矩阵、错误日志、测量方法、AEC 误判经过与修复证据在[英文摄像头与台架记录](README.md#camera-findings)中保留。

## 运行服务

推荐用 `rdk/provision.sh` 创建 `/etc/max/agent.env`（权限 `0600`，密钥从环境变量或静默提示读取，不会回显）。下方为示例值，按本机设备号、接口和中继替换；**不要把真实令牌写入 Git、命令历史或验收材料**：

```dotenv
MAX_RELAY_URL=wss://relay.example.com/agent
MAX_RELAY_TOKEN=
MAX_REQUIRE_TLS=on
MAX_RELAY_INSECURE_TLS=0
MAX_DEVICE_ID_FILE=/var/lib/max/device-id
RDK_ALSA_CAPTURE=plughw:0,0
RDK_ALSA_PLAYBACK=plughw:0,0
MAX_GALLERY_DIR=/var/lib/max/gallery
MAX_GALLERY_MIN_FREE_MB=1024
MAX_HUD_PORT=8080
MAX_VISION_PREVIEW_PORT=8081
# MAX_VISION_LISTEN=all
MAX_VISION_TOKEN=
MAX_VISION_SOCKET=/run/max/vision.sock
RDK_CAMERA_FRONT=0
RDK_CAMERA_REAR=2
MAX_ADAS_SHADOW=0
MAX_VISION_SHARE=0
MAX_CORPUS_DIR=/var/lib/max/corpus
MAX_VOICE_GATE_RMS=900
MAX_VOICE_GATE_MS=400
# MAX_VOLUME_FLOOR=14  # “小声一点”能降到的最低音量（百分比，1–90）；请在真实板卡上戴着头盔试听后设置
```

针对已启用账号的中继，`MAX_RELAY_TOKEN` 必需，否则 `/agent` 升级会被拒绝。`MAX_VISION_TOKEN` 用于板外访问 `8080`（以及启用 `MAX_VISION_LISTEN=all` 后的 `8081`）；未配置时，非回环访问会返回 `401`。`MAX_VISION_SHARE=0` 默认拒绝摄像头帧离开板卡；设置为 `1` 后才允许语音视觉描述。仅精确值 `1` 会启用 `MAX_RELAY_INSECURE_TLS`，测试时才可考虑该选项。

令牌通过 `Authorization: Bearer` 请求头发送，不再放在 URL 里。但请求头不能让 `ws://` 变得私密：明文 `ws://` 会让令牌和骑手的麦克风音频以明文经过网络，只应用于自己可控的台架局域网。`MAX_REQUIRE_TLS=on`（默认写入）会在 `ws://` 指向非回环主机时拒绝启动；`MAX_REQUIRE_TLS=off` 仅限台架。视觉侧车的 `8081` 端口默认只监听 `127.0.0.1`，因此默认情况下，局域网浏览器打开 `http://<board>:8080/?t=<token>` 只能看到 HUD，摄像头与图库面板不可用（HUD 会提示）。仅在可信的台架网络中才设置 `MAX_VISION_LISTEN=all` 以开放 `8081`（SSH 本地转发不受影响）。

安装 systemd 服务（含加固 drop-in）并发布代码：

```bash
export RDK_HOST=root@board.example.com
rdk/provision.sh --dry-run   # 先预览，不执行任何远程命令
rdk/provision.sh
rdk/deploy.sh --dry-run
rdk/deploy.sh
journalctl -u max-agent -f
```

两个服务以 root 运行；`rdk/systemd/*.service.d/hardening.conf` 提供只含已论证指令的沙箱加固。服务清单、板上验收清单和一条命令移除加固的方法见[英文版 Service hardening](README.md#service-hardening)。
两个服务使用 30 秒 watchdog；部署 unit 文件和会发送 heartbeat 的代码必须在同一次发布中完成，否则健康进程会每 30 秒被错误重启。Agent 不强制依赖视觉侧车：摄像头服务故障时，语音仍可运行，拍摄动作应报告真实失败。系统服务比 SSH 会话中的 `nohup` 更可靠。

## 受审发布与回滚

发布顺序为：**匹配目标 SHA 且 `/health`、`/ready` 均正常的中继 → 签名 iOS App → RDK 板卡**。板卡应从干净、已评审的完整 Git SHA 创建新 staging 目录，而不是把开发工作树直接覆盖到 `/opt/max`。原生 AEC 可执行文件和渲染后的 ADAS 警告音频不在 Git 里，必须从当前发布显式复制、逐项验证。激活后只做一次受控重启，确认新的 systemd Invocation ID、`[relay] session ready`、服务仍在运行、设备身份摘要不变，再保留上一个版本供回滚。

这套流程现在是受版本控制的脚本：`rdk/deploy.sh` 完成 staging、校验、切换、健康检查，并在失败时自动回滚到上一个版本（含其 unit 文件和 drop-in），退出码 2 表示回滚也未能证明，需要按[英文版附录](README.md#deploying)手动处理。`--dry-run` 会打印每条远程命令而不执行。请不要从上述说明临时拼接部署命令。

## 板卡验收

在同局域网启动中继后，逐项检查：

1. **语音：**启动 `max-agent`，日志出现 `[relay] session ready`；对耳机说“Max，现在天气怎么样”，确认听到一次回答；说话打断回答，确认及时停止；拔插耳机后无需重启可恢复。
2. **iPhone 伴侣：**未配对时可通过 `_maxhelmet._tcp` mDNS 发现，或从板卡本地 HUD 读取六位码。远程查看配对码应使用 SSH 本地转发；必须把 `8080` 和 `8081` 同号转发。配对后确认 HUD 显示 ready，再显式开始 Helmet Ride。锁屏、断网恢复、ADAS 抢占、第二条路线和隐私检查按 [RDK 伴侣验收](../docs/rdk-ios-companion-acceptance.md)执行。
3. **摄像头：**启用 `MAX_VISION_SHARE=1` 后，带令牌访问 `/preview/front` 和 `/preview/rear`；无令牌应为 `401`，关闭共享后应为 `403`。拍照应生成一对 JPEG 和清单；录像应生成两路 `.mjpeg` 与记录真实时长/帧率的清单。侧车停机后，语音应继续，拍摄应给出失败。
4. **开发 HUD：**本机回环或带令牌的板外浏览器访问 `8080`。确认状态、字幕、导航、时延、相册和双预览更新。板外令牌只授予访问，不授予查看配对码的权限；配对码只对板卡回环连接显示。
5. **关机：**“Max，关机”在板上启动十秒倒计时，提示音经正常播放/AEC 路径输出；“取消关机”可取消。结束音之后等待约 15 秒再切断电源。

板卡根路径验收、完整截图/日志要求及具体 HTTP 返回码见[英文板卡验收清单](README.md#on-hardware-verification)。

## Python 测试

与硬件无关的视觉、相册和 ADAS 测试使用 Python 3.10；不会导入摄像头、ROS/ISP 或 BPU 驱动。macOS 可用 `uv` 安装临时依赖并运行：

```bash
uv run --with-requirements rdk/vision/requirements-dev.txt python -m pytest \
  -c rdk/vision/pytest.ini -m 'not hardware' --strict-markers rdk/vision/tests
```

也可按[英文版环境步骤](README.md#running-the-python-suite)创建 `.venv` 后运行 `npm run test:rdk-vision`。缺少 NumPy、OpenCV、FFmpeg 或 `ffprobe` 应被视为测试失败；只跳过明确标记 `hardware` 的用例。真实摄像头和 BPU 检查仍需板上执行：`rdk/vision/tests/test_hardware_smoke.py` 的用例全部标记为 `hardware`（上面的命令会取消选择它们），板上运行方法见[英文版](README.md#running-the-python-suite)。

## ADAS 阶段与限制

- **M0：**采集和标注骑行素材，分段存盘并保留可追溯元数据。影子模式不能直接当成骑手警报。
- **M1：**验证模型锚点、检测与测量流水线、延迟和候选告警；历史数据与阈值是初始值，不能直接证明道路安全。
- **M2：**在骑行影子模式下运行双摄、跟踪、TTC 与抑制规则；已锁定的警告音频必须经过统一播放路径，使限幅、节奏和 AEC 参考保持有效。

详细的测量、误报边界、道路实验方案、日志阅读方法与原始数值在[英文 ADAS M0/M1/M2 章节](README.md#adas-m1--the-measurement-pipeline)。当前仍需真实道路数据、误报调校、热/供电验收和 H.264 摄像头绑定。不要把模型输出或影子日志当作已经获准的主动安全告警。
