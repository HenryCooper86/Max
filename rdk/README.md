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

| Item                               | Value                                                              | Date       |
| ---------------------------------- | ------------------------------------------------------------------ | ---------- |
| Board                              | `D-Robotics X5 MD V0.2`, Ubuntu 22.04.5, kernel 6.1.83             | 2026-07-25 |
| ALSA capture device                | `plughw:0,0` — card 0 `duplexaudio`, codec **ES8326**              | 2026-07-25 |
| ALSA playback device               | `plughw:0,0` — same duplex card, one device for both               | 2026-07-25 |
| Headset wiring (CTIA/OMTP)         | **CTIA, mic works** — −43.6 dBFS ambient, not silence              | 2026-07-25 |
| Raw echo coupling                  | **+5.5 dB** above the noise floor (`CROSSTALK=0`, DAC 0 dB)        | 2026-07-25 |
| Coupling with `module-echo-cancel` | not measured — PipeWire runs in the `sunrise` user session         |            |
| AEC path chosen                    | **software AEC**; coupling is mild enough that ladder step 1 fits  | 2026-07-25 |
| Full duplex                        | **works** — simultaneous `arecord` + `aplay`, no device contention | 2026-07-25 |
| Camera front port index            | **MIPI host 2** (`vcon@2`, i2c bus 4) — see "Camera findings"      | 2026-07-25 |
| Camera rear port index             | **MIPI host 0** (`vcon@0`, i2c bus 6) — separate bus, no collision | 2026-07-25 |
| BPU                                | present, idle, 500–1000 MHz; `pyeasy_dnn` + `libsrcampy` OK        | 2026-07-25 |
| Node.js                            | **v22.23.1** installed from NodeSource; npm 10.9.8                 | 2026-07-25 |
| First live session                 | **works** — 656 KB mic PCM up, 3 device.result round trips         | 2026-07-25 |
| pytest                             | 6.2.5 installed; board runs the vision suite 104 passed, 1 skipped | 2026-07-25 |

### AEC spike result — gate passed, with one required mixer change

Measured 2026-07-25 with `rdk/vision/../../scripts` style throwaway script: a
200–8000 Hz log sweep at 0.3 FS played through the headset while recording, with
a silent reference for the noise floor.

**The ES8326's `CROSSTALK1`/`CROSSTALK2` controls default to 10 and act as a
hardware duck, not an echo canceller.** Holding the DAC at 0 dB and changing only
that control:

| `CROSSTALK`  | noise floor | during playback | outcome                          |
| ------------ | ----------- | --------------- | -------------------------------- |
| 10 (default) | −35.5 dBFS  | −47.8 dBFS      | capture pushed **below** ambient |
| 0            | −43.7 dBFS  | −38.1 dBFS      | echo audible at **+5.5 dB**      |

At the default it attenuates _everything_ during playback, including room noise —
so the rider's voice would be suppressed exactly while Max is speaking. **Leave
`CROSSTALK1`/`CROSSTALK2` at 0**, or barge-in cannot work. The board has been set
that way and the state saved with `alsactl store`.

With the duck disabled, coupling is only **+5.5 dB above the noise floor** —
mild. WebRTC-class cancellers routinely handle far worse, so **ladder step 1
(`module-echo-cancel`) should be sufficient and the half-duplex fallback is not
needed.** That was the decision gate; barge-in survives.

Honest limits of this measurement:

- RMS over the whole capture, not a true ERL against a calibrated reference.
- The ambient floor drifted between runs (−43.7 vs −35.5 dBFS), so treat the
  numbers as indicative rather than precise.
- Sweep was 0.3 FS; speech at full playback volume will couple more.
- **Not yet tested: a person talking while Max speaks** — the definitive barge-in
  check. That needs someone at the bench, and it is the one result that could
  still overturn this.
- `module-echo-cancel` itself is unmeasured: PipeWire runs in the `sunrise` user
  session and the spike ran as root.

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

### OV5647 is unsupported — decided, not pending

**Use IMX219.** OV5647 is treated as unsupported on this platform. The cause is a
vendor-side ISP bug we cannot fix, and the diagnosis is recorded here so nobody
spends another afternoon on it:

```
isp_video_set_inter_attr ... sensor_cali_name = .../ov5647_1920x1080_tuning.json
                    ↓ 5.05 s
ctx_id 0, inst id 0, sensor .../ov5647_1920x1080_tuning.json   → teardown
create_and_run_vflow failed, ret -10
```

Ruled out, each by measurement:

- **Not the sensor driver.** `imx219` and `ov5647` in
  [x5-libcam-sensor](https://github.com/D-Robotics/x5-libcam-sensor) are
  structurally identical — same GPIO power-on, register init, and stream-on. A
  BSP rebuild of `libov5647.so` would change nothing.
- **Not signal integrity or lane config.** Every `mipi_host*/status/icnt`
  counter reads 0 and the D-PHY never leaves reset, so the sensor is never asked
  to stream.
- **Not our code.** The vendor's own `mipi_cam` fails identically.
- **Not a stale image.** `hobot-camera 3.1.1` is the newest available; `apt` has
  no upgrade.
- **Not a version gate.** `CAMERA_CALVER_NOCHECK=1` and `CAMERA_CONFIG_NOCHECK=1`
  make no difference.

The failure is in the shipped ISP tuning/camsys handling of
`ov5647_1920x1080_tuning.json`. If you want to pursue it upstream, the relevant
repo is [x5-drv-camsys](https://github.com/D-Robotics/x5-drv-camsys) — not the
sensor tree — and the block above is the bug report. One cheap local test first:
diff your BSP's `ov5647_1920x1080_tuning.json` against the board's copy
(343293 bytes); if the BSP has a newer one, dropping it in is a one-file
experiment.

`tools/record_ride.py` runs an i2c preflight before opening anything, so an
unsupported or unseated module fails in under a second with a specific message
instead of a five-second ISP timeout that points at the wrong layer. Override
with `--skip-preflight` if you are deliberately testing an unsupported module.

Known-good reference command, for confirming the camera outside our stack:

```bash
source /opt/tros/humble/setup.bash
ros2 run mipi_cam mipi_cam --ros-args \
  -p video_device:=IMX219 -p channel:=2 -p image_width:=1920 -p image_height:=1080
```

**Front+rear is NOT blocked by an address collision** — an earlier note here
claimed it was, based on only ever seeing one camera at a time. With two modules
attached, both enumerate simultaneously on **different i2c buses**:

| Connector | VCON                | i2c bus | mipi channel |
| --------- | ------------------- | ------- | ------------ |
| A         | `vcon@0` / `vcon@1` | 6       | 0 / 1        |
| B         | `vcon@2` / `vcon@3` | 4       | 2 / 3        |

So a front+rear pair uses **channel 0 and channel 2**, needing no
`gpio_enable_bit` / `gpio_level_bit` multiplexing. (Those fields would only
matter for two modules sharing one bus, which is not the arrangement here.)

Still untested with modules that stream — both cameras on the bench are OV5647,
which produce no frames.

## Running

```bash
sudo mkdir -p /etc/max
sudo tee /etc/max/agent.env >/dev/null <<'ENV'
MAX_RELAY_URL=ws://<lan-ip>:8787/agent
MAX_RELAY_TOKEN=                           # required once the relay has accounts
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

## ADAS M0 — recording a corpus

See `docs/superpowers/specs/2026-07-25-embedded-adas-bpu-design.md`.

Record on the board (Ctrl-C or SIGTERM to stop):

```bash
systemctl restart cam-service && sleep 3
source /opt/tros/humble/setup.bash
cd /opt/max/rdk/vision
python3 -m tools.record_ride --root /var/lib/max/corpus --fps 10 \
  --sensor IMX219 --front-vcon 2 --rear-vcon 3
```

**Two frame sources**, selected with `--source`:

| `--source`           | Camera path                                    | Segment format |
| -------------------- | ---------------------------------------------- | -------------- |
| `mipi_cam` (default) | the vendor's ROS node — **the one that works** | `.mjpeg`       |
| `binding`            | our ctypes `hbn_camera_create` + hw encoder    | `.h264`        |

`mipi_cam` is the default because our binding cannot open a camera yet:
`hbn_camera_create` returns -1 even with a matching sensor spec and the correct
VCON. The binding path is kept so switching back is a flag flip once that is
solved. Using `mipi_cam` costs a ROS dependency in the recording path only —
nothing else in the sidecar imports it.

Because `mipi_cam` publishes decoded frames on `/image_raw`, the recorder
JPEG-encodes them, so a segment is concatenated JPEG rather than an H.264
stream. `corpus/library.py` accepts both.

Segments are 60 s plus a `.jsonl` metadata sidecar, so a power cut costs at most
one minute. A camera that will not open is logged and skipped — front-only rides
are expected on current hardware, and only a ride with no cameras at all is an
error.

Copy the corpus off the board, then label hazard windows on a laptop:

```bash
python3 -m tools.label list --root ./corpus
python3 -m tools.label add --ride ./corpus/ride-20260725-141900 \
  rear_approach:rear:12000:15000:"car closed fast"
python3 -m tools.label show --ride ./corpus/ride-20260725-141900
```

Offsets are milliseconds from the ride start, matching `wall_ms` in the
sidecars. Only the four M1 threats are accepted: `forward_collision`,
`pedestrian_ahead`, `rear_approach`, `tailgating` — anything else is rejected
rather than written, so the corpus stays interpretable.

Storage: roughly **10 GB per hour per camera** for `.mjpeg` at 10 fps / 1080p
(JPEG q85). The `binding` path would be ~1.8 GB/hour once it works, since H.264
exploits inter-frame redundancy that per-frame JPEG cannot.

**Not yet verified on hardware:** a recording that actually captures frames.
The full `mipi_cam` path is exercised — subprocess launch, rclpy node,
subscription, settle timeout, clean teardown — but no sensor that streams has
been attached since it landed. Board-verified so far:

- `cam-service` survives a failed camera open (previously any open crashed it)
- both cameras report unavailable with a specific reason and the CLI exits cleanly
- a per-node rclpy executor, without which two cameras raise
  `ValueError: generator already executing`

**Use IMX219.** The OV5647 produces zero frames even under the vendor's own
`mipi_cam`, so no source can record from it.

The two modules are visually near-identical (they are Raspberry Pi Camera v1 vs
v2). Identify one in seconds by plugging it in alone and scanning:

```bash
for b in 4 6; do echo "bus $b:"; i2cdetect -y -r $b | sed -n '3p'; done
# 0x10 => IMX219  (works)
# 0x36 => OV5647  (does not stream on this image)
```
