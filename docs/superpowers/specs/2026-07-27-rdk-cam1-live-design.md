# CAM1 Live — Routing max-vision Through `mipi_cam`

## Summary

A camera is connected to the **CAM1** connector. It works. The vision sidecar
cannot open it, because `camera.py` opens cameras through a ctypes binding that
does not work and hardcodes a sensor that is not attached.

This spec routes max-vision onto `mipi_cam` — the one path measured to stream on
this board — and corrects the hardware facts the codebase encodes wrongly. When
it lands, `camera.photo`, the MJPEG preview, and the ADAS runtime all run off a
live camera for the first time.

Related: `docs/superpowers/specs/2026-07-25-rdk-x5-embedded-client-design.md`,
`docs/superpowers/specs/2026-07-26-adas-m1-measure-design.md`,
`docs/superpowers/specs/2026-07-26-adas-m2-ride-design.md`.

## What the hardware actually does

Measured against the board on 2026-07-27. Every claim below is an observation,
not an inference from documentation.

**The board is at `10.42.0.11`.** `rdk/README.md` hardcodes `192.168.50.9`; the
hotspot address `172.20.10.6` is also dead. Neither responds.

**CAM1 is i2c bus 6 — `vcon@0` / `vcon@1`.** Read from the device tree at
`/sys/firmware/devicetree/base/soc/cam/vcon@N`:

| vcon     | i2c bus | MIPI host (`rx_phy`) |
| -------- | ------- | -------------------- |
| `vcon@0` | 6       | 0                    |
| `vcon@1` | 6       | 1                    |
| `vcon@2` | 4       | 2                    |
| `vcon@3` | 4       | 3                    |

**Only hosts 0 and 2 exist.** `mipi_cam` prints `this board support mipi: host
0, host 2` at startup. So each connector carries exactly one usable camera:
CAM1 is channel 0, the other connector is channel 2. Any config offering
channels 1 or 3 is offering something the board does not have.

**The attached module is an OV5647**, identified positively by chip ID rather
than by i2c address: `i2ctransfer -y 6 w2@0x36 0x30 0x0a r2` returns `0x56
0x47`.

**It streams.** The vendor's known-good command on channel 0 produced 784 frames
in one 30 s run and 648 in a 25 s run, at 1920×1080, ~41 ms apart (≈24 fps). The
kernel logs the full bring-up — `sensor_start ov5647 flow0 start done`, `vin
mipi0: entry hs reception`. A captured frame is a real image: correct colour,
exposure and focus, full dynamic range, balanced channel means.

**The ctypes binding is still dead.** `hbn_camera_create` returns `-1` for every
combination tried:

```
OV5647 vcon=0: ret=-1     IMX219 vcon=0: ret=-1
OV5647 vcon=1: ret=-1     IMX219 vcon=1: ret=-1
```

(vcon 2/3 were not tried — that connector is empty, so a failure there would
prove nothing.) This confirms the note already in `tools/record_ride.py`.

**Exactly one process may hold the camera.** An orphaned `mipi_cam` left holding
`/dev/vs-isp0_*` made every subsequent open fail with `The detected sensors are
1 less than expected` — a message that points at sensor detection when the real
cause is a busy device. This is a load-bearing constraint, not a footnote: it
dictates the architecture below, and it will be the most likely field failure.

## What this overturns

**`rdk/README.md` says "OV5647 is unsupported — decided, not pending". That is
wrong.** The verdict rests on an A/B the README itself scopes as _"Measured on
the same port"_ — **MIPI host 2**. Nobody tried host 0. On host 0 the same
sensor model streams cleanly. The variable is the port, not the sensor.

The ruled-out list in that section stays valid and stays useful; what changes is
the conclusion drawn from it. The honest statement is now:

| Sensor | host 0     | host 2                            |
| ------ | ---------- | --------------------------------- |
| OV5647 | streams ✅ | `create_and_run_vflow ret -10` ❌ |
| IMX219 | untested   | streams ✅                        |

Two of four cells are measured. That is not enough to encode a support matrix
in code, which is why discovery below reports rather than vetoes.

**This unblocks the ADAS M1 gate.** The M2 spec states M1's numbers are unmet
because "the bench cameras are OV5647, which the vendor ISP cannot drive" — that
was the stated blocker on building a labelled corpus. A streaming OV5647 removes
it. Acting on that is separate work; this spec only clears the path.

**Code that encodes the stale facts:**

- `sensors.py` — `SUPPORTED_ADDRS = (0x10,)`, so `preflight()` would reject the
  working camera now in CAM1.
- `camera.py` — hardcodes `IMX219`, and opens via the dead binding. Two
  independent reasons it cannot work.
- `service.py` — defaults `RDK_CAMERA_FRONT=0`, `RDK_CAMERA_REAR=1`: the same
  connector twice, and host 1 does not exist.
- `camera_binding.py` and `tools/record_ride.py` docstrings — "vcon@0 has no
  connector", "VCON 0/1 have no connector on this board". `vcon@0` _is_ CAM1.
- `README.md` bench table — front/rear port index rows, and the connector table
  offering channels 1 and 3.

## Architecture

max-vision owns **one `mipi_cam` child process per populated connector**, and
nothing else touches the hardware. One ROS subscriber per camera keeps the
latest nv12 frame and its capture timestamp in memory; photo, preview and ADAS
all read that shared latest frame.

This is not a preference. Given that exactly one process can hold the ISP, any
design where consumers open their own camera is broken by construction — and
fails with a message pointing at the wrong layer.

```text
rdk/vision/
  mipi_camera.py            NEW — owns process + subscriber for one camera
  camera.py                 CameraPair delegates here instead of the binding
  sensors.py                bus -> channel discovery; preflight reports
  recorder/mipi_source.py   collapses onto MipiCamera
```

`MipiCamera` exposes three views of the same frame:

- `latest() -> Frame | None` — nv12 plus `t_ms`; the primitive the other two
  are built on
- `jpeg() -> bytes | None` — encoded on demand, cached per frame, for photo,
  preview and `.mjpeg` recording
- `frames() -> Iterator[Frame]` — satisfies the existing `FrameSource`
  protocol; this is what ADAS consumes

That third one matters more than it looks. ADAS reaches frames through the
_same_ seam as `FileSource`, so offline-replay parity stays a property of the
structure rather than something maintained by discipline — which is exactly the
argument `perception/frame_source.py` already makes for itself.

**Assumption to confirm first:** `nv12` and `bgr8` both appear as `out_format`
strings in `libmipi_cam_plugin.so`, but only `bgr8` has been run. If
`out_format:=nv12` does not work, the fallback is to keep `bgr8` and convert;
that costs CPU per frame on a board already near 90 °C under ADAS load, so it
is worth confirming before building on it. **Verify this in task one.**

## Camera discovery

`sensors.py` stops naming a sensor and starts reporting what is attached:

- map bus → channel (bus 6 → 0, bus 4 → 2), omitting the hosts this board
  does not have
- scan each bus, identify by i2c address, return the `video_device` name
  `mipi_cam` expects (`OV5647`, `IMX219`)
- `SUPPORTED_ADDRS` grows to include `0x36`

**`preflight()` changes from veto to report.** It fails only when nothing at all
is attached. A hard "this sensor is unsupported" block is precisely what would
reject the working camera in CAM1 today; with two of four port×sensor cells
measured, code that refuses to try is more likely to be wrong than the hardware.
The fast-failure value that motivated `preflight` is kept — an empty bus still
fails in under a second with the ribbon-seating message.

Where a combination is known to fail, the open surfaces it as a specific error
after the fact. Failing loudly beats refusing to try.

## Configuration

`RDK_CAMERA_FRONT` and `RDK_CAMERA_REAR` become **MIPI channels**, defaulting to
`0` and `2`. Sensor names are discovered, never configured.

So **CAM1 (channel 0) is the front camera** and the other connector (channel 2)
is rear. Single-camera operation is first-class, because that is the hardware:
one camera in CAM1 means front works, rear is absent, and the pair reports
`degraded` rather than failing. This preserves the existing rule that one dead
camera never fails the pair.

## Data flow

```text
mipi_cam (nv12) -> /image_raw -> subscriber -> latest Frame
   |-- camera.photo   -> jpeg() -> gallery pair dir / front.jpg
   |-- camera.record  -> jpeg() per frame appended -> pair dir / front.mjpeg
   |-- preview :8081  -> jpeg() -> multipart MJPEG
   `-- ADAS runtime   -> frames() -> detector / tracker / threat  (unchanged)
```

## Recording

Gallery video recording is implemented for the first time, as `.mjpeg`.

Today `camera.py` writes a manifest naming `front.h264` / `rear.h264` and **no
code ever writes those files** — it probes a sensor, names a file, and returns
`ok`. That is the same class of lie the file's own comments warn against.

`.mjpeg` costs nothing downstream: `corpus/library.py` already lists both
suffixes in `VIDEO_SUFFIXES`, `recorder/session.py` already takes a
`video_suffix`, and `gallery.open` is `supported: false` on the device, so no
web or iOS client reads these manifests. Hardware h264 encode stays out of
scope; it belongs with the binding work.

## Error handling

1. **Reap orphans at startup.** Before opening, kill any pre-existing
   `mipi_cam` holding `/dev/vs-isp0_*`. Without this a max-vision restart can
   never reacquire the camera — measured, not hypothesised.
2. **Deterministic child shutdown.** terminate → `wait(5s)` → kill, on `stop()`
   and via a signal handler, so we never create the orphan ourselves. The
   existing `MipiCamSource.stop()` already does this; the bug was in ad-hoc code
   that did not.
3. **Settle at boot, not mid-capture.** `mipi_cam` needs several seconds to
   probe and start the flow. Paying that at service start preserves the property
   that a capture is a frame grab, keeping it under the relay's 8 s
   `DEVICE_RESULT_TIMEOUT_MS` — the reason `camera.py` holds sensors open for
   the life of the service.
4. **A camera that never delivers a frame is marked unavailable and the service
   still starts.** Preview and ADAS degrade; voice is a separate process and is
   unaffected.

## Testing

**Unit — runs anywhere, no hardware**, following `rdk/vision/tests/`:

- bus → channel mapping, including that channels 1 and 3 are never offered
- discovery identifies OV5647 and IMX219; `preflight` fails only on an empty bus
- orphan-reap logic against faked process/holder listings
- latest-frame fan-out; JPEG cache invalidates when a new frame arrives
- degraded single-camera paths: manifest names only files that will exist

**On-board verification:**

- camera opens on channel 0 and delivers frames
- `camera.photo` writes a JPEG that is a real image
- preview serves frames on `:8081`
- ADAS runtime yields live detections
- **restart max-vision twice in a row and confirm it reacquires** — the
  regression test for the orphan constraint, and the one most likely to break

**Parity:** existing replay and soak runs over the corpus must be unchanged,
since ADAS reaches frames through the same `FrameSource` seam.

## Out of scope

- Fixing the ctypes binding. It stays available behind `--source binding` for
  the day it works.
- Hardware h264 encode.
- Rear-camera work beyond supporting it in config — no second module is
  attached.
- Acting on the unblocked M1 corpus gate.

## Documentation to correct

`rdk/README.md`: the OV5647 verdict (port-specific, not sensor-unsupported) and
its new measured table; the bench-findings port-index rows; the connector table,
to show only hosts 0 and 2; and a note that the board IP is network-dependent
and was `10.42.0.11` on 2026-07-27.

Docstrings in `camera_binding.py` and `tools/record_ride.py` claiming vcon@0/@1
have no connector.
