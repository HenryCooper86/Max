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
5. **Cameras** — confirm both IMX219 sensors enumerate and note their VIN port
   indices for `RDK_CAMERA_FRONT` / `RDK_CAMERA_REAR`.

## Bench findings

| Item                               | Value | Date |
| ---------------------------------- | ----- | ---- |
| ALSA capture device                |       |      |
| ALSA playback device               |       |      |
| Headset wiring (CTIA/OMTP)         |       |      |
| Raw echo coupling                  |       |      |
| Coupling with `module-echo-cancel` |       |      |
| AEC path chosen                    |       |      |
| Camera front / rear port index     |       |      |

> **Step 4 is a decision gate, not a formality.** If `module-echo-cancel` does
> not suppress the coupling adequately, stop before implementing the audio path.
> The fallback — half-duplex ducking — costs barge-in, which is a shipped
> feature on the web, iOS, and Android clients. That is a product decision, not
> an implementation detail.

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
