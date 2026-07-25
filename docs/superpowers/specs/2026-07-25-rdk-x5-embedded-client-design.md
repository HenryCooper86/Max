# Max on RDK X5 — Embedded Voice & Camera Client Design

## Summary

Put Max in the helmet. A D-Robotics **RDK X5** board becomes a fourth client of
the existing `/agent` relay, alongside web, iOS, and Android: a 4-pole headset
plugs into the board's 3.5 mm jack for hands-free voice, and two IMX219 MIPI CSI
cameras cover front and rear for voice-triggered capture.

Nothing about the relay's shape changes. The board speaks the same
`session.start` / binary-PCM / `device.command` / `device.result` protocol every
other client speaks, so Doubao integration, wake word, weather, ride
intelligence, session memory, and QA telemetry all work unmodified. The only
server-side edits are one new `TestingPlatform` value and three new spoken
failure lines.

This is the first of several embedded specs. It covers the voice path and camera
capture. Real ADAS on the BPU — the reason this board was chosen — is deferred,
but the architecture here deliberately leaves its door open.

## Scope

### Goals

- Hands-free voice on the board: ALSA capture → `/agent` relay → headset
  playback, with barge-in, reconnect, and session memory at parity with the
  other clients.
- Acoustic echo cancellation, so Max does not hear and answer itself.
- Voice-triggered `camera.photo` and `camera.record` across **both** cameras,
  dispatched through the existing device-action spine.
- A bench dev HUD on HDMI (or any browser on the LAN) showing turn state,
  transcript, telemetry, and both camera previews.
- Boot-to-ready as a systemd appliance, with no rider-facing controls.
- Honest capability reporting: every action the helmet cannot perform returns
  `unsupported` with a truthful spoken line.

### Non-goals

Each is deferred to its own spec.

- **Real ADAS / BPU inference.** Hazards stay simulated via
  `server/hazard-injector.ts`, exactly as today. The IPC seam is shaped to accept
  them later without redesign.
- **LTE/5G modem.** WiFi only; the board talks to a LAN relay or the Lightsail
  test server.
- **Navigation** (`navigation.start` / `navigation.stop` / `destination.show`).
- **Phone-dependent actions** — `sms.compose`, `call.dial`, `music.control`.
- **Torch.** A GPIO helmet light is future hardware.
- **A rider-facing screen.** The dev HUD is a bench instrument only.
- **Bluetooth headset support.** Wired 3.5 mm only in v1.
- **OTA updates.** Provisioning is by hand.

## Hardware baseline

| Element | Choice                                                                          |
| ------- | ------------------------------------------------------------------------------- |
| Board   | D-Robotics RDK X5 — Sunrise 5, 8× Cortex-A55, ~10 TOPS BPU                      |
| OS      | Ubuntu 22.04 aarch64 (RDK OS) + NodeSource Node 22                              |
| Audio   | 3.5 mm 4-pole jack on the IO carrier board, **ES8326B** codec (I²S → DAC & ADC) |
| Cameras | 2× IMX219 on MIPI CSI, via D-Robotics VIN/ISP (`libsrcampy`)                    |
| Network | WiFi                                                                            |

Two hardware facts must be confirmed on the bench before implementation, both in
the manual checklist below: the headset's **CTIA vs OMTP** mic wiring, and the
measured **echo return loss** between helmet speaker and mic.

## Architecture

Two systemd services. The seam between them is **vision owns frames, agent owns
protocol and session** — and the control socket is bidirectional and
event-shaped from day one, so a future BPU inference loop pushes hazards up an
existing channel rather than forcing the boundary to be redrawn around the most
interesting part of the product.

```text
Helmet headset (4-pole 3.5 mm) ──► RDK X5 ES8326B codec ──► ALSA card
                                        │
      ┌─────────────────────────────────┴──────────────────────────────┐
      │  max-agent.service   (Node 22 + tsx, imports shared/ directly) │
      │    relay.ts     WS /agent, reconnect + exponential backoff     │
      │    audio/       arecord 48k → ÷3 → 16k PCM16, 320-smp frames   │
      │                 24k PCM16 from relay → ×2 → 48k → limiter →aplay│
      │                 RMS voice gate: re-arms session after idle 4001│
      │    device/      device.command dispatch + capability matrix    │
      │    hud/         local HTTP + WS dev HUD on :8080               │
      └──────────────┬─────────────────────────────────┬───────────────┘
                     │ unix socket (control)           │ WiFi
                     │ NDJSON, bidirectional           │
      ┌──────────────┴───────────────┐                 ▼
      │  max-vision.service (Python) │        existing relay, unchanged
      │    libsrcampy VIN/ISP        │        ws(s)://…/agent
      │    2× IMX219, front + rear   │        (server/index.ts)
      │    photo / H.264 record      │                 │
      │    gallery storage rules     │                 ▼
      │    MJPEG preview on :8081    │        Doubao realtime dialogue
      │    ← future: BPU ADAS pushes │
      │      hazard events up here   │
      └──────────────────────────────┘
```

### Units

- **`relay.ts`** — owns the `/agent` WebSocket: `session.start` with embedded
  attribution, session-memory echo, reconnect with exponential backoff, and
  idle-close (4001) handling. Gates outbound PCM on `session.started`.
- **`audio/capture.ts`** — spawns `arecord`, low-passes, decimates to 16 kHz,
  slices 320-sample frames.
- **`audio/playback.ts`** — upsamples 24 kHz to 48 kHz, soft-limits, feeds
  `aplay`; flushes and respawns on barge-in.
- **`audio/dsp.ts`** — pure: FIR low-pass, decimator, interpolator, soft limiter,
  frame slicer.
- **`audio/voice-gate.ts`** — pure: RMS + hysteresis. Decides when to re-arm a
  session after an idle close.
- **`device/dispatch.ts`** — routes `device.command` to a handler or returns
  `unsupported` per the capability matrix; guarantees exactly one
  `device.result` per command.
- **`vision-client.ts`** — NDJSON codec and request/response correlation over the
  unix socket; surfaces unsolicited events.
- **`hud/`** — static page plus a WebSocket mirror of agent state.
- **`vision/service.py`** — the sidecar: camera lifecycle, capture, gallery
  rules, MJPEG preview, RPC.

### Reused unchanged

The `device.command` / `device.result` protocol, the relay's zh+en command
grammar, reconciliation and truthful-failure speech, the wake word
(`shared/wake.ts`, server-enforced), ride intelligence, weather, session memory,
latency telemetry, and the generated protocol contracts.

## Audio pipeline

**Echo cancellation is a device-name concern, not a code concern.** The client
opens whatever ALSA device `RDK_ALSA_CAPTURE` names. If the spike shows
PipeWire/PulseAudio `module-echo-cancel` (`aec_method=webrtc`) is sufficient,
that variable points at the virtual source and no client code changes. If we must
supply our own APM, it still presents as a device. This keeps the largest unknown
out of the codebase's structure.

Fallback ladder, in order of preference:

1. `module-echo-cancel` with the WebRTC AEC — configuration only.
2. In-process WebRTC APM — more work, but also yields noise suppression and AGC,
   both wanted at speed.
3. Half-duplex ducking — mute the mic while Max speaks. This **kills barge-in**,
   which is a shipped feature on all three existing clients. Emergency only.

**Capture**

```
arecord -D $RDK_ALSA_CAPTURE -f S16_LE -r 48000 -c 1 -t raw
  → 31-tap windowed-sinc low-pass @ 7.5 kHz
  → decimate ÷3 → 16 kHz PCM16
  → slice to 320-sample / 640-byte frames
  → WebSocket binary
```

The low-pass is required, not optional: naive ÷3 decimation folds everything
above 8 kHz back into the band and degrades ASR. 320-sample 20 ms frames match
`public/pcm-worklet.js` exactly, so the relay sees an identical stream from every
client.

**Playback**

```
24 kHz PCM16 → ×2 interpolate → 48 kHz → per-sample soft limiter → aplay stdin
```

The soft limiter matches the iOS/Android per-sample limiter, so the helmet
speaker is loud without hard-clipping.

Both conversions are explicit in Node rather than delegated to `plughw:`. ALSA's
plug layer would hide the rate mismatch, but its resampler quality is mediocre
and it costs exact frame alignment. Both ratios (÷3, ×2 against 48 kHz) are exact
integers, so the cost is trivial.

**Barge-in.** `aplay`'s ALSA buffer cannot be drained from outside the process,
so a default ~500 ms buffer would leave Max talking over the rider for half a
second. `--buffer-size` is capped near 120 ms; on barge-in the agent stops
feeding and respawns `aplay`. Residual is bounded at ~120 ms. If respawn glitches
audibly, a native ALSA addon is the escape hatch, at the cost of a `node-gyp`
toolchain on aarch64.

**Local voice gate.** The helmet has no button, which creates a problem the other
clients do not have. The relay idle-closes with `IDLE_CLOSE_CODE` 4001, and
web/iOS/Android simply stay offline until the rider taps something; here there is
nothing to tap. So on 4001 the agent keeps `arecord` running locally, stops
streaming, and reconnects when an RMS-plus-hysteresis gate observes sustained
speech.

This is **not** wake-word detection — that stays server-side in `shared/wake.ts`.
It answers only "is anyone talking at all", so a parked helmet does not hold a
Doubao upstream slot indefinitely.

## Vision service and IPC

Control plane and data plane are separate. The NDJSON unix socket carries
commands and events only — low volume, human-readable, easy to log and test.
Preview frames never touch it: the vision service serves MJPEG on a local HTTP
port and the dev HUD's `<img>` elements point straight at it, so the agent never
proxies image bytes.

```
agent → vision   {"id":"c7","op":"camera.photo","args":{}}
vision → agent   {"id":"c7","status":"ok","detail":"pair-20260725-142233"}
vision → agent   {"event":"hazard", ...}      ← unsolicited; the ADAS door
```

Every request carries an `id`; every response echoes it. Unsolicited messages
carry `event` instead and have no `id`. A request with no response inside the
agent's timeout resolves as `failed` so the `device.result` contract is never
violated.

**Cameras stay open from service start.** `DEVICE_RESULT_TIMEOUT_MS` is 8 s
(`server/device-actions.ts`); a capture that had to cold-start the VIN/ISP
pipeline could exceed it and make Max report a failure that did not happen.
Continuous streaming reduces a capture to a frame grab.

## Capture behavior

**拍照 captures both cameras as one paired item.** A "photo" that silently chose
one of two cameras would be arbitrary, and front-plus-rear is the product's whole
point. Today's relay grammar carries no camera selector, so pairing is also the
honest reading of the current contract. Adding "拍前面 / 拍后面" later is a regex
addition to `extractDeviceCommand`, not a redesign.

**录像 records both cameras** to H.264 via the SoC hardware encoder. A 10-minute
cap and a low-space refusal match the iOS rules. Budget roughly 1 MB/s for the
pair, so a full clip is ~600 MB.

Storage defaults to `/var/lib/max/gallery`, keep-until-deleted; nothing
auto-deletes. Captures are refused when free space falls below
`MAX_GALLERY_MIN_FREE_MB`. A paired capture is one directory containing the front
and rear files plus a small JSON manifest, so a pair is atomic on disk.

## Capability matrix

| Action                                 | Behavior                            | Reason code on refusal                                    |
| -------------------------------------- | ----------------------------------- | --------------------------------------------------------- |
| `camera.photo`                         | ok — front+rear pair                | `storage.full`, `capture.failed`                          |
| `camera.record`                        | ok — both cameras, 10 min cap       | `camera.recording`, `camera.notRecording`, `storage.full` |
| `volume.set`                           | ok — ALSA mixer on ES8326B playback | —                                                         |
| `gallery.open`                         | unsupported                         | `device.noScreen`                                         |
| `torch.set`                            | unsupported                         | `torch.unavailable`                                       |
| `music.control`                        | unsupported                         | `device.noPhone`                                          |
| `sms.compose`                          | unsupported                         | `device.noPhone`                                          |
| `call.dial`                            | unsupported                         | `device.noPhone`                                          |
| `navigation.start` / `navigation.stop` | unsupported                         | `device.notYet`                                           |
| `destination.show`                     | unsupported                         | `device.noScreen`                                         |

Navigation gets its own code rather than borrowing `device.noPhone`: audio-only
turn-by-turn needs neither a phone nor a screen, so claiming either would be a
false explanation. It is simply not built yet.

`gallery.open` returning `unsupported` is deliberate. The dev HUD can display the
gallery, but it is a bench tool the rider cannot see; replying `ok` would have
Max claim the rider is looking at photos that are not in front of them.

## Server-side changes

Deliberately minimal.

1. **`TestingPlatform` gains `"embedded"`** — `shared/testing.ts:6`, plus the
   hard-coded validators at `server/testing-store.ts:620`, `server/index.ts:385`,
   and `inferTestingPlatform` (`server/testing-store.ts:1136`).

2. **`REQUIRED_TESTING_PLATFORMS` (`shared/testing.ts:342`) is left alone.** That
   array drives release-gate coverage; adding a fourth required platform would
   fail every existing release run the moment the enum changes. Embedded opts in
   when it is genuinely a release target.

3. **Three new `FAILURE_SPEECH` entries** in `server/device-actions.ts`, because
   today an `unsupported` gallery command falls back to the vague
   "相册操作没成功". `device.noScreen` is worded generically because it serves both
   `gallery.open` and `destination.show`:

   ```ts
   "device.noScreen": "头盔上没有屏幕，看不了。",
   "device.noPhone":  "头盔上没有手机功能，这个我做不了。",
   "device.notYet":   "这个功能头盔上还没上线。",
   ```

No new event types. No provider changes. No relay protocol changes.

## Repository layout

```text
rdk/
├── agent/                 # Node client (TypeScript, run under tsx)
│   ├── src/
│   │   ├── main.ts
│   │   ├── relay.ts
│   │   ├── audio/         # capture, playback, dsp, voice-gate
│   │   ├── device/        # dispatch + capability matrix
│   │   ├── vision-client.ts
│   │   └── hud/
│   └── tsconfig.json      # extends root, no DOM lib
├── vision/                # Python camera service
│   ├── service.py
│   ├── camera.py          # libsrcampy
│   ├── gallery.py         # storage rules
│   └── rpc.py
├── systemd/
│   ├── max-agent.service
│   └── max-vision.service
└── README.md              # provisioning + manual hardware checklist
```

`rdk/agent` runs under `tsx` — already a root dependency, already how
`dev:server` runs — and imports `../../shared/*` directly, so the embedded client
and the relay share one copy of the contracts with no build step. The repo has no
npm workspaces, so `rdk/agent` carries its own `tsconfig.json` extending the root
without the DOM lib.

## Configuration

```bash
MAX_RELAY_URL=ws://<lan-ip>:8787/agent     # or wss://3.35.135.136/agent
MAX_RELAY_INSECURE_TLS=0                   # self-signed test server; debug-only, default off
RDK_ALSA_CAPTURE=plughw:0,0                # set from step 1 of the manual checklist;
RDK_ALSA_PLAYBACK=plughw:0,0               # capture points at the AEC source once chosen
RDK_CAMERA_FRONT=0                         # VIN port index, confirmed on the bench
RDK_CAMERA_REAR=1
MAX_GALLERY_DIR=/var/lib/max/gallery
MAX_GALLERY_MIN_FREE_MB=1024
MAX_HUD_PORT=8080
MAX_VISION_PREVIEW_PORT=8081
MAX_VISION_SOCKET=/run/max/vision.sock
MAX_VOICE_GATE_RMS=900                     # int16 RMS, ≈ -31 dBFS
MAX_VOICE_GATE_MS=400                      # sustained speech before re-arming
```

Three of these are seeded with defaults that the bench replaces rather than
values to trust blindly. The ALSA device names come from step 1 of the manual
checklist, and `RDK_ALSA_CAPTURE` is repointed at the echo-cancelled source once
the spike picks a path. The camera port indices are whatever D-Robotics'
enumeration actually reports for the two CSI connectors in use. The voice-gate
numbers are a starting point for a helmet at speed; wind noise will move them.

`MAX_RELAY_INSECURE_TLS` mirrors the mobile posture: the shared test server is
self-signed, so the escape hatch exists, defaults off, and is debug-only.

## Boot and field behavior

Both units are `Restart=always`. `max-vision.service` starts first and creates the
socket; `max-agent.service` is `After=network-online.target`.

Ordering is intentionally soft: if vision is down, the agent still runs and
camera actions fail truthfully rather than taking the voice path down with them.

## Error and edge handling

| Condition                                | Behavior                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Vision sidecar dead or socket refused    | Camera actions → `failed` / `capture.failed`; systemd restarts it; agent reconnects with backoff                                 |
| Vision response exceeds timeout          | Resolve `failed` so exactly one `device.result` is always sent                                                                   |
| Free space below threshold               | `storage.full`; no auto-delete                                                                                                   |
| Record start while recording             | `camera.recording`                                                                                                               |
| Record stop while idle                   | `camera.notRecording`                                                                                                            |
| Headset unplugged / ALSA device vanishes | Respawn `arecord`/`aplay` with backoff; dev HUD shows degraded audio                                                             |
| Relay unreachable                        | Exponential backoff; no spoken error spam                                                                                        |
| Relay idle-close 4001                    | Stop streaming, keep listening locally, re-arm on the voice gate                                                                 |
| One camera fails, one works              | Capture proceeds on the working camera; manifest records the missing side; result is `ok` with a detail noting the degraded pair |

## Verification

### Automated

Everything below runs without the board attached.

- **Vitest, pure functions** — FIR low-pass and ÷3 decimator (including an
  alias-rejection case), ×2 interpolator, soft limiter, 320-sample frame slicer,
  voice-gate hysteresis, capability-matrix mapping, NDJSON codec and id
  correlation. Driven from PCM and JSON literals.
- **Fake vision sidecar** — a test double speaking the same NDJSON over a temp
  socket, exercising `device.command` → `device.result` end to end, including
  timeout, crash mid-request, and unsolicited-event delivery.
- **pytest** — vision RPC framing, gallery storage rules (space refusal, 10-minute
  cap, pair naming and manifest atomicity). Camera-free.
- **`npm run check` stays green** — the new directory must satisfy knip, eslint,
  prettier, and the protocol check.

### Manual (physical board)

Recorded in `rdk/README.md`.

1. `arecord -l` / `aplay -l` — confirm the ES8326B card and record its device names.
2. Headset **CTIA vs OMTP** — verify mic capture is present, not silent.
3. Loopback — record and play back a phrase at 48 kHz.
4. **Echo return loss** — play a sweep, capture, measure. This is the spike that
   selects the AEC path.
5. Both cameras stream; preview visible on the dev HUD.
6. End-to-end: boot the board, say "Max，现在天气怎么样", hear a reply.
7. Barge-in: interrupt a reply mid-sentence, confirm speech cuts within ~120 ms.
8. "拍照" then "开始录像" / "停止录像"; confirm a paired capture and a clip on disk.
9. Pull the headset mid-session; confirm recovery without a service restart.

## Acceptance criteria

- The board boots into a live hands-free session with no rider interaction.
- A rider addressing "Max" gets a spoken reply through the headset, with
  barge-in, over the same relay the other clients use.
- Max does not answer its own voice.
- "拍照" produces a front+rear pair on disk; "开始录像" / "停止录像" produce two
  H.264 clips; both confirmations match reality.
- Every unsupported action produces a truthful spoken refusal, never a false
  success.
- The dev HUD shows turn state, transcript, telemetry, and both previews.
- Killing either service degrades that capability only, and it recovers without
  a reboot.
- `npm run check` passes.
- No changes to the relay protocol, providers, or the existing three clients
  beyond the enum value and three speech lines listed above.

## Follow-on specs

1. **Real ADAS on the BPU** — `hobot_dnn` inference in the vision service,
   pushing `hazard` events up the existing control socket; replaces the simulated
   injector for embedded. Needs its own false-alarm tuning and safety review.
2. **Mobile connectivity** — LTE/5G modem, offline behavior, degraded-link policy.
3. **Rider I/O hardware** — GPIO button, status LED, helmet torch.
4. **Embedded navigation** — audio-only turn-by-turn, reusing the `GuidanceEngine`
   contract from the iOS spec.
