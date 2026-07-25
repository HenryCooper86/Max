# Max on RDK X5

Embedded client for the Max helmet assistant. See
`docs/superpowers/specs/2026-07-25-rdk-x5-embedded-client-design.md`.

## Provisioning

```bash
# Node 22 (Ubuntu 22.04 ships Node 12)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs alsa-utils python3-pip
node --version   # expect v22.13+

sudo mkdir -p /var/lib/max/gallery /run/max
sudo chown -R "$USER" /var/lib/max /run/max
```

## Hardware checklist

Record the result of every step in "Bench findings" below.

1. **ALSA devices** — `arecord -l` and `aplay -l`. Note the ES8326B card and
   device numbers; these become `RDK_ALSA_CAPTURE` / `RDK_ALSA_PLAYBACK`.
2. **Headset wiring (CTIA vs OMTP)** — record 5 s and confirm the capture is not
   silent:
   ```bash
   arecord -D plughw:0,0 -f S16_LE -r 48000 -c 1 -d 5 /tmp/mic.wav
   python3 -c "import wave,audioop;w=wave.open('/tmp/mic.wav');d=w.readframes(w.getnframes());print('rms',audioop.rms(d,2))"
   ```
   An RMS near 0 with someone speaking means the headset is OMTP-wired and needs
   an adapter.
3. **Loopback** — `aplay -D plughw:0,0 /tmp/mic.wav`. Confirm intelligible.
4. **Echo return loss (the AEC spike)** — play a sweep through the helmet
   speaker while recording the helmet mic, with nobody speaking:
   ```bash
   sox -n /tmp/sweep.wav synth 5 sine 200-8000
   aplay -D plughw:0,0 /tmp/sweep.wav & arecord -D plughw:0,0 -f S16_LE -r 48000 -c 1 -d 5 /tmp/echo.wav; wait
   ```
   Compare the RMS of `/tmp/echo.wav` against a silent reference recording. The
   difference is the coupling. Then try the WebRTC canceller:
   ```bash
   pactl load-module module-echo-cancel aec_method=webrtc source_name=maxmic sink_name=maxspk
   ```
   Repeat the measurement against `-D pulse:maxmic`.
5. **Cameras** — see "Camera findings" below before touching this. Do **not**
   rely on `open_cam` auto-detect; use the known-good `mipi_cam` command to
   confirm a module streams, and note its VCON index.

## Bench findings

Verified over SSH against the real board on 2026-07-25.

| Item                               | Value                                                          | Date       |
| ---------------------------------- | -------------------------------------------------------------- | ---------- |
| Board                              | `D-Robotics X5 MD V0.2`, Ubuntu 22.04.5, kernel 6.1.83         | 2026-07-25 |
| ALSA capture device                | `plughw:0,0` — card 0 `duplexaudio`, codec **ES8326**          | 2026-07-25 |
| ALSA playback device               | `plughw:0,0` — same duplex card, one device for both           | 2026-07-25 |
| Headset wiring (CTIA/OMTP)         | not yet measured — needs the headset on the bench              |            |
| Raw echo coupling                  | not yet measured                                               |            |
| Coupling with `module-echo-cancel` | not yet measured — **PipeWire is already running**, no install |            |
| AEC path chosen                    | pending the measurement above                                  |            |
| Camera front port index            | **MIPI host 2** (`vcon@2`, i2c bus 4) — see "Camera findings"  | 2026-07-25 |
| Camera rear port index             | unresolved — only one camera reachable so far                  |            |
| BPU                                | present, idle, 500–1000 MHz; `pyeasy_dnn` + `libsrcampy` OK    | 2026-07-25 |
| Node.js                            | **not installed** — provisioning step above is still required  | 2026-07-25 |

> **Step 4 is a decision gate, not a formality.** If `module-echo-cancel` does
> not suppress the coupling adequately, stop before implementing the audio path.
> The fallback — half-duplex ducking — costs barge-in, which is a shipped
> feature on the web, iOS, and Android clients. That is a product decision, not
> an implementation detail.

Also on the board already: a prebuilt BPU detector at
`/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/yolov5s_672x672_nv12.bin`
and a MIPI-camera-into-YOLOv5s sample at
`/app/pydev_demo/08_mipi_camera_sample/01_mipi_camera_yolov5s.py`.

## Camera findings

**The stock auto-detect path is broken on this board.** `libsrcampy.open_cam(port, -1, …)`
always searches `vcon@0` (i2c bus 6), which is physically empty. The vendor stack
reports a phantom `ov5647` there — the log line is `vp_sensor_detect_2 Support
sensor index:0`, i.e. it lists _supported_ sensors, not detected ones — then
`/usr/hobot/bin/cam-service` NULL-dereferences initialising a sensor that does
not exist. Every camera open fails as a result, and the first failure wedges the
ISP so later attempts fail earlier and differently.

Consequences:

- **`rdk/vision/camera.py` cannot use `open_cam` auto-detect.** It must pin the
  port explicitly via `hbn_camera_create(camera_config_t*, …)` from
  `/usr/hobot/lib/libcam.so`, setting `bus_select` (the VCON index) plus `name`
  and `addr`. Headers are installed: `/usr/include/hb_camera_data_config.h`,
  `hb_camera_interface.h`, `hbn_api.h`.
- `systemctl restart cam-service` resets a wedged pipeline — no reboot needed
  between experiments.
- Vendor bug worth reporting: `cam-service.service` has
  `ExecStart=… -V6 &`, and systemd passes that trailing `&` as a literal argv.

**Sensor support is not equal.** Measured A/B on the same port:

| Module     | i2c addr | Result on MIPI host 2                        |
| ---------- | -------- | -------------------------------------------- |
| **IMX219** | `0x10`   | **streams 1920×1080 @ 30 fps** ✅            |
| **OV5647** | `0x36`   | `create_and_run_vflow ret -10`, no frames ❌ |

Use **IMX219** modules. The OV5647 fails at video-flow start at both 1920×1080
and 1280×960 (the driver ignores the requested mode and reports 1080 either way),
and the image ships one ISP tuning file for it versus many FOV variants for
IMX219.

Known-good reference command, for confirming the camera outside our stack:

```bash
source /opt/tros/humble/setup.bash
ros2 run mipi_cam mipi_cam --ros-args \
  -p video_device:=IMX219 -p channel:=2 -p image_width:=1920 -p image_height:=1080
```

**Open question blocking front+rear:** both camera connectors map to i2c bus 4
(`vcon@2` and `vcon@3`), so two modules collide at the same address. Selecting
between them likely needs `gpio_enable_bit` / `gpio_level_bit` in
`camera_config_t` ("索引自 VCON"), and `vcon@3` has no `gpio_oth` property while
`vcon@2` does. Untested — needs two IMX219 modules on the bench.

## Running

```bash
sudo mkdir -p /etc/max
sudo tee /etc/max/agent.env >/dev/null <<'ENV'
MAX_RELAY_URL=ws://<lan-ip>:8787/agent
MAX_RELAY_INSECURE_TLS=0
RDK_ALSA_CAPTURE=plughw:0,0
RDK_ALSA_PLAYBACK=plughw:0,0
MAX_GALLERY_DIR=/var/lib/max/gallery
MAX_GALLERY_MIN_FREE_MB=1024
MAX_HUD_PORT=8080
MAX_VISION_PREVIEW_PORT=8081
MAX_VISION_SOCKET=/run/max/vision.sock
MAX_VOICE_GATE_RMS=900
MAX_VOICE_GATE_MS=400
ENV

sudo cp rdk/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now max-agent
journalctl -u max-agent -f
```

Only the exact string `1` enables `MAX_RELAY_INSECURE_TLS`; anything else leaves
certificate validation on.

`max-agent` names `max-vision` in `After=` but does not `Require=` it: if the
vision sidecar is down, the agent still runs and camera actions fail truthfully
rather than taking the voice path down with them.

## On-hardware verification

With `npm run dev:server` running on the LAN host:

**Voice**

1. `systemctl start max-agent`, then `journalctl -u max-agent -f` — expect
   `[relay] session ready`.
2. Say "Max，现在天气怎么样" into the headset and hear a spoken reply.
3. Interrupt a reply mid-sentence; speech must stop within ~120 ms.
4. Unplug and replug the headset; the service recovers without a restart.

**Cameras**

1. `systemctl start max-vision`, then open `http://<board>:8081/preview/front`
   and `/preview/rear` — both show live video.
2. Say "拍照" — a `pair-*` directory appears under `/var/lib/max/gallery` with
   two JPEGs and a manifest.
3. Say "开始录像", wait, then "停止录像" — two `.h264` files and a manifest.
4. Say "开始录像" twice — Max says "已经在录了。"
5. `systemctl stop max-vision`, then say "拍照" — Max reports a truthful failure
   and the voice session keeps working.

**Dev HUD**

Open `http://<board>:8080` from a laptop, or Chromium kiosk on the board's HDMI.
Start a session and confirm turn state, transcript, latency, and both previews
update live.

## Known gap

`camera.py` does not yet attach the `libsrcampy` H.264 encoder in
`start_recording` / `stop_recording` — that is the one piece that cannot be
written without the board. The surrounding policy (recording state machine,
space guard, ten-minute cap, and which sides the manifest names) is implemented
and covered by `tests/test_camera_policy.py`. Attach `libsrcampy.Encoder` to each
live sensor on start and release it on stop, writing `front.h264` / `rear.h264`
into the pair directory. Do not change the state machine while doing so.

## Running the Python suite

pytest is a dev-only dependency; the sidecar itself needs no third-party
packages.

```bash
pip install pytest
cd rdk/vision && python3 -m pytest tests/ -q
```
