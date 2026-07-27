# CAM1 Live Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the max-vision sidecar onto `mipi_cam` so the camera in CAM1 feeds photo capture, MJPEG preview and the ADAS runtime live.

**Architecture:** max-vision owns exactly one `mipi_cam` child process per populated connector — the board permits only one holder of the ISP. A per-camera `FrameBuffer` keeps the latest nv12 frame plus a JPEG encoded on demand; photo, preview, recording and ADAS all read from it. ADAS reaches frames through the existing `FrameSource` protocol, so offline-replay parity is structural.

**Tech Stack:** Python 3.10 on Ubuntu 22.04 (aarch64), ROS 2 Humble (`ros2 run mipi_cam`), `rclpy`, OpenCV 4.11, NumPy 1.26, pytest 6.2.5.

**Spec:** `docs/superpowers/specs/2026-07-27-rdk-cam1-live-design.md`

## Global Constraints

- **The test suite runs on the board.** There is no pytest or numpy on the dev Mac. Every test step below deploys first. Set `BOARD` once per shell: `export BOARD=10.42.0.11` — the address is network-dependent and was `10.42.0.11` on 2026-07-27. If it does not answer, find it with `arp -a` plus `nc -G 2 -z <ip> 22`, then confirm with `ssh root@<ip> 'ls /usr/hobot'`.
- **Deploy + test, one line:** `scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'`
- **Exactly one process may hold the camera.** A second opener fails with `The detected sensors are 1 less than expected`, which names sensor detection when the real cause is a busy device. Never open a camera outside max-vision while it is running.
- **The sidecar takes no new third-party dependencies.** `cv2`, `numpy` and `rclpy` are already on the board. pytest is dev-only; nothing under `rdk/vision/` may import it at runtime.
- **Board-only imports are lazy.** `cv2`, `numpy`, `rclpy` and `hobot_vio` are imported inside functions, never at module scope, so the unit suite runs without hardware. Existing code marks these `# noqa: PLC0415`.
- **House style:** module docstrings explain *why* a thing exists, not what it does. Comments justify decisions that would otherwise look arbitrary. Tests use `sys.path.insert(0, str(Path(__file__).resolve().parents[1]))` and import modules directly.
- **Every task ends with a commit** on branch `docs/rdk-cam1-live` (already created; the spec is committed there).

---

### Task 1: Confirm `out_format:=nv12`, and correct the hardware facts

The spec flags one unverified assumption: `nv12` appears as an `out_format` string in `libmipi_cam_plugin.so`, but only `bgr8` has been run. Everything downstream assumes nv12 comes out of the node directly. Settle it before building on it.

**Files:**
- Modify: `rdk/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a confirmed answer to "does `out_format:=nv12` work?", which decides whether `FrameBuffer` (Task 3) stores nv12 as delivered or converts from bgr8.

- [ ] **Step 1: Verify no camera holder is running**

```bash
ssh root@$BOARD 'systemctl stop max-vision; sleep 1; ps -eo pid,args | grep "[m]ipi_cam/mipi_cam" || echo "(clear)"'
```

Expected: `(clear)`. If a PID is listed, kill it — a leftover holder makes every result below a false negative.

- [ ] **Step 2: Probe the nv12 output**

```bash
ssh root@$BOARD 'cat > /tmp/probe_nv12.py <<"PY"
import subprocess, sys, threading, time
import rclpy
from sensor_msgs.msg import Image
from rclpy.executors import SingleThreadedExecutor

W, H = 1920, 1080
proc = subprocess.Popen(
    ["ros2","run","mipi_cam","mipi_cam","--ros-args",
     "-p","video_device:=OV5647","-p","channel:=0",
     f"-p","image_width:={W}", "-p", f"image_height:={H}",
     "-p","out_format:=nv12"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

seen = {}
lock = threading.Lock()

def on_image(msg):
    with lock:
        seen["encoding"] = msg.encoding
        seen["len"] = len(msg.data)
        seen["wh"] = (msg.width, msg.height)

rclpy.init()
node = rclpy.create_node("probe_nv12")
node.create_subscription(Image, "/image_raw", on_image, 10)
ex = SingleThreadedExecutor(); ex.add_node(node)

deadline = time.monotonic() + 25
while time.monotonic() < deadline:
    ex.spin_once(timeout_sec=0.1)
    with lock:
        if seen:
            break

with lock:
    if not seen:
        print("NO FRAME")
    else:
        expected = W * H * 3 // 2
        print(f"encoding={seen[\"encoding\"]} len={seen[\"len\"]} expected_nv12={expected} "
              f"match={seen[\"len\"] == expected} wh={seen[\"wh\"]}")

ex.shutdown(); node.destroy_node(); rclpy.shutdown()
proc.terminate()
try:
    proc.wait(timeout=5)
except subprocess.TimeoutExpired:
    proc.kill()
PY
source /opt/tros/humble/setup.bash 2>/dev/null
timeout 60 python3 /tmp/probe_nv12.py 2>&1 | grep -vE "^\[INFO|^\[WARN" | tail -5'
```

Expected if nv12 works: `encoding=nv12 len=3110400 expected_nv12=3110400 match=True wh=(1920, 1080)`.

- [ ] **Step 3: Clean up the probe, and confirm nothing was orphaned**

```bash
ssh root@$BOARD 'rm -f /tmp/probe_nv12.py; sleep 2; ps -eo pid,args | grep "[m]ipi_cam/mipi_cam" || echo "(clear)"; systemctl start max-vision'
```

Expected: `(clear)`. This step is not optional — an orphan here silently breaks every later task.

- [ ] **Step 4: Record the outcome**

If `match=True`, add this row to the bench-findings table in `rdk/README.md` (the table starting `| Board  ` around line 57):

```markdown
| `mipi_cam` nv12 output     | **works** — `out_format:=nv12`, 3110400 B/frame at 1920×1080         | 2026-07-27 |
```

If nv12 does **not** work, record that instead and note that `FrameBuffer` must convert from `bgr8` via `cv2.cvtColor(..., cv2.COLOR_BGR2YUV_I420)` per frame — then flag the CPU cost to the user before continuing, because the board already plateaus near 90 °C under ADAS load.

- [ ] **Step 5: Correct the OV5647 verdict**

In `rdk/README.md`, replace the `### OV5647 is unsupported — decided, not pending` heading and its opening paragraph with:

```markdown
### OV5647 works on host 0, and fails on host 2

**The port is the variable, not the sensor.** An earlier version of this section
declared OV5647 unsupported "decided, not pending". That verdict rested on the
A/B directly above, which this file itself scopes to **MIPI host 2**. Nobody had
tried host 0. On host 0 the same sensor model streams 1920×1080 at ~24 fps with
a correctly exposed, in-focus image, and the kernel logs the full bring-up
(`sensor_start ov5647 flow0 start done`, `vin mipi0: entry hs reception`).

| Sensor | host 0     | host 2                            |
| ------ | ---------- | --------------------------------- |
| OV5647 | streams ✅  | `create_and_run_vflow ret -10` ❌ |
| IMX219 | untested   | streams ✅                        |

Two of four cells are measured — too few to encode a support matrix in code,
which is why `sensors.preflight()` reports rather than vetoes. The ruled-out
list below stays valid and stays useful; only the conclusion drawn from it
changed.
```

Keep the existing "Ruled out, each by measurement" block that follows — it is still accurate about host 2.

- [ ] **Step 6: Correct the port-index rows and the connector table**

In the bench-findings table, replace the two camera port rows:

```markdown
| Camera front port index    | **MIPI channel 0** (`vcon@0`/`vcon@1`, i2c bus 6) — the CAM1 connector | 2026-07-27 |
| Camera rear port index     | **MIPI channel 2** (`vcon@2`/`vcon@3`, i2c bus 4) — separate bus       | 2026-07-27 |
```

And replace the connector table (the one with `| Connector | VCON | i2c bus | mipi channel |`) with:

```markdown
| Connector | VCON                | i2c bus | mipi channel |
| --------- | ------------------- | ------- | ------------ |
| CAM1      | `vcon@0` / `vcon@1` | 6       | **0**        |
| the other | `vcon@2` / `vcon@3` | 4       | **2**        |

`mipi_cam` prints `this board support mipi: host 0, host 2` at startup — hosts 1
and 3 do not exist. So each connector carries exactly **one** usable camera, and
a front+rear pair is channel 0 plus channel 2. Verified from the device tree at
`/sys/firmware/devicetree/base/soc/cam/vcon@N` (`bus` and `rx_phy` properties).
```

Delete the sentence "Still untested with modules that stream — both cameras on the bench are OV5647, which produce no frames." It is now false.

- [ ] **Step 7: Note that the board IP moves**

Immediately under the `## Bench findings` heading, add:

```markdown
> The board's IP is network-dependent. It was `10.42.0.11` on 2026-07-27; the
> `192.168.50.9` used in commands throughout this file is a stale example. Find
> the current one with `arp -a`, narrow with `nc -G 2 -z <ip> 22`, and confirm
> with `ssh root@<ip> 'ls /usr/hobot'`.
```

- [ ] **Step 8: Commit**

```bash
git add rdk/README.md
git commit -m "docs(rdk): OV5647 works on host 0; correct the port map"
```

---

### Task 2: Sensor discovery by bus, and preflight that reports

`sensors.py` currently vetoes anything that is not an IMX219, which would reject the working camera in CAM1. Replace the veto with discovery.

**Files:**
- Modify: `rdk/vision/sensors.py`
- Test: `rdk/vision/tests/test_sensors.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `BUS_CHANNEL: dict[int, int]`; `discover(scan=scan_bus) -> dict[int, str]` mapping MIPI channel to the `video_device` name `mipi_cam` expects (`"OV5647"`, `"IMX219"`); `preflight(scan=scan_bus) -> None` raising `UnsupportedSensor` only when nothing is attached. `SUPPORTED_ADDRS` is **removed**.

- [ ] **Step 1: Write the failing tests**

Add to `rdk/vision/tests/test_sensors.py`, and change the import block at the top to drop `SUPPORTED_ADDRS` and add `BUS_CHANNEL, discover`:

```python
def test_bus_channel_maps_each_connector_to_its_one_host():
    # The board reports "support mipi: host 0, host 2" — hosts 1 and 3 do not
    # exist, so a connector carries one camera, not two.
    assert BUS_CHANNEL == {6: 0, 4: 2}


def test_discover_names_the_sensor_on_each_channel():
    found = discover(fake_scan({6: [0x36], 4: [0x10]}))
    assert found == {0: "OV5647", 2: "IMX219"}


def test_discover_reports_only_populated_channels():
    assert discover(fake_scan({6: [0x36]})) == {0: "OV5647"}


def test_discover_ignores_unknown_addresses():
    assert discover(fake_scan({6: [0x0C, 0x36]})) == {0: "OV5647"}


def test_discover_is_empty_when_nothing_is_attached():
    assert discover(fake_scan({})) == {}


def test_preflight_passes_with_an_ov5647():
    # The regression that motivated this change: the old preflight vetoed 0x36
    # and would have rejected the camera now streaming in CAM1.
    preflight(fake_scan({6: [0x36]}))


def test_preflight_still_fails_on_an_empty_bus():
    with pytest.raises(UnsupportedSensor) as error:
        preflight(fake_scan({}))
    assert "not seated" in str(error.value)
```

Delete the now-wrong tests `test_only_imx219_is_supported` and any test asserting that an OV5647-only scan raises.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_sensors.py -q'
```

Expected: FAIL — `ImportError: cannot import name 'BUS_CHANNEL'`.

- [ ] **Step 3: Implement discovery**

In `rdk/vision/sensors.py`, replace `SUPPORTED_ADDRS` with `BUS_CHANNEL` and add `discover`:

```python
#: Each connector's one usable MIPI channel. mipi_cam prints "this board support
#: mipi: host 0, host 2" — hosts 1 and 3 do not exist, so a connector carries one
#: camera. Bus 6 is the CAM1 connector (vcon@0/@1); bus 4 is the other (vcon@2/@3).
BUS_CHANNEL = {6: 0, 4: 2}


def discover(scan: Callable[[int], list[int]] = scan_bus) -> dict[int, str]:
    """MIPI channel -> the ``video_device`` name mipi_cam wants, per attached module.

    Discovering the sensor is what lets the sidecar stop hardcoding one. A
    hardcoded IMX219 is why the working OV5647 in CAM1 could not be opened.
    """
    found: dict[int, str] = {}
    for bus, channel in BUS_CHANNEL.items():
        for addr in scan(bus):
            sensor = identify(addr)
            if sensor is not None:
                found[channel] = sensor.name.upper()
                break
    return found
```

- [ ] **Step 4: Turn preflight from veto into report**

Replace the whole body of `preflight` in `rdk/vision/sensors.py`:

```python
def preflight(scan: Callable[[int], list[int]] = scan_bus) -> None:
    """Raise only when no known camera module is attached at all.

    This used to reject any sensor outside a supported list. That was wrong in
    the most expensive way: the list held only IMX219, so it vetoed the OV5647
    that streams fine on host 0. With two of four port x sensor combinations
    measured, refusing to try is likelier to be wrong than the hardware is. An
    open that cannot work now fails loudly, with the vendor's own error.

    The fast-failure this function was written for is kept: an empty bus still
    fails in under a second with the ribbon-seating message, rather than after a
    five-second ISP timeout that points at the wrong layer.
    """
    addrs = [addr for bus in CAMERA_BUSES for addr in scan(bus)]
    if any(identify(a) is not None for a in addrs):
        return

    raise UnsupportedSensor(
        "no camera answering on either connector bus:\n"
        f"{describe_scan(scan)}\n"
        "An entirely empty bus usually means the ribbon is not seated — the metal\n"
        "contacts must face the PCB, and it must be pushed fully home before the\n"
        "latch closes. See 'Camera findings' in rdk/README.md."
    )
```

Also update the module docstring: replace the paragraph beginning "OV5647 is deliberately unsupported" with:

```python
"""...
OV5647 is supported on host 0 and fails on host 2 — the port is the variable,
not the sensor. See "Camera findings" in rdk/README.md. This module reports what
is attached; deciding whether a combination can stream is the opener's job.
"""
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_sensors.py -q'
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add rdk/vision/sensors.py rdk/vision/tests/test_sensors.py
git commit -m "feat(vision): discover camera sensors per bus; preflight reports"
```

---

### Task 3: `FrameBuffer` — one latest frame, one JPEG cache

The unit-testable core of camera ownership, split from the ROS plumbing so it can be tested without hardware.

**Files:**
- Create: `rdk/vision/mipi_camera.py`
- Test: `rdk/vision/tests/test_mipi_camera.py`

**Interfaces:**
- Consumes: `Frame` from `perception.frame_source`.
- Produces: `FrameBuffer(camera: str, width: int, height: int, encode=None)` with `put(nv12: bytes, t_ms: int) -> None`, `latest() -> Frame | None`, `jpeg() -> bytes | None`. The `encode` argument is `Callable[[bytes, int, int], bytes | None]` taking `(nv12, width, height)`.

- [ ] **Step 1: Write the failing tests**

Create `rdk/vision/tests/test_mipi_camera.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mipi_camera import FrameBuffer


def counting_encoder():
    """Stand-in for the cv2 JPEG encoder, so the suite needs no hardware."""
    calls = []

    def encode(nv12: bytes, width: int, height: int):
        calls.append((len(nv12), width, height))
        return b"\xff\xd8" + nv12[:4] + b"\xff\xd9"

    return encode, calls


def test_latest_is_none_before_any_frame_arrives():
    buffer = FrameBuffer("front", 4, 2)
    assert buffer.latest() is None
    assert buffer.jpeg() is None


def test_latest_returns_the_frame_that_was_put():
    buffer = FrameBuffer("front", 4, 2)
    buffer.put(b"abcdefghijkl", t_ms=17)
    frame = buffer.latest()
    assert frame.nv12 == b"abcdefghijkl"
    assert frame.t_ms == 17
    assert frame.camera == "front"
    assert (frame.width, frame.height) == (4, 2)


def test_jpeg_encodes_on_demand_and_caches_per_frame():
    encode, calls = counting_encoder()
    buffer = FrameBuffer("front", 4, 2, encode=encode)
    buffer.put(b"abcdefghijkl", t_ms=1)
    first = buffer.jpeg()
    second = buffer.jpeg()
    assert first == second
    # Encoding a 3 MB frame nobody asked for is pure waste: preview pulls at
    # 10 fps while ADAS pulls nv12, so most frames are never encoded at all.
    assert len(calls) == 1


def test_a_new_frame_invalidates_the_cached_jpeg():
    encode, calls = counting_encoder()
    buffer = FrameBuffer("front", 4, 2, encode=encode)
    buffer.put(b"aaaaaaaaaaaa", t_ms=1)
    buffer.jpeg()
    buffer.put(b"bbbbbbbbbbbb", t_ms=2)
    assert buffer.jpeg() == b"\xff\xd8bbbb\xff\xd9"
    assert len(calls) == 2


def test_jpeg_is_none_when_the_encoder_fails():
    buffer = FrameBuffer("front", 4, 2, encode=lambda nv12, w, h: None)
    buffer.put(b"abcdefghijkl", t_ms=1)
    assert buffer.jpeg() is None
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_mipi_camera.py -q'
```

Expected: FAIL — `ModuleNotFoundError: No module named 'mipi_camera'`.

- [ ] **Step 3: Implement `FrameBuffer`**

Create `rdk/vision/mipi_camera.py`:

```python
"""One camera, one ``mipi_cam`` process, one holder.

Exactly one process on this board may hold the ISP. A second opener fails with
``The detected sensors are 1 less than expected``, which names sensor detection
when the real cause is a busy device — an hour of debugging pointed at the wrong
layer before that was understood. So the sidecar owns the camera, and every
consumer (photo, preview, recording, ADAS) reads the same latest frame from here.

The ctypes binding in ``camera_binding.py`` remains the alternative, and remains
non-functional: ``hbn_camera_create`` returns -1 for every sensor and VCON tried.
"""

from __future__ import annotations

import threading

from perception.frame_source import Frame


def _encode_jpeg(nv12: bytes, width: int, height: int) -> bytes | None:
    """NV12 -> JPEG. Board-only: cv2 and numpy are not on the dev machine."""
    import cv2  # noqa: PLC0415 - board-only
    import numpy as np  # noqa: PLC0415

    planar = np.frombuffer(nv12, dtype=np.uint8).reshape(height * 3 // 2, width)
    bgr = cv2.cvtColor(planar, cv2.COLOR_YUV2BGR_NV12)
    ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    return buf.tobytes() if ok else None


class FrameBuffer:
    """The latest frame, plus a JPEG of it encoded only if someone asks.

    Encoding eagerly would burn CPU on frames nobody reads: ADAS consumes nv12
    directly, and preview pulls at 10 fps from a 24 fps stream.
    """

    def __init__(self, camera: str, width: int, height: int, encode=None) -> None:
        self.camera = camera
        self.width = width
        self.height = height
        self._encode = encode or _encode_jpeg
        self._lock = threading.Lock()
        self._frame: Frame | None = None
        self._jpeg: bytes | None = None

    def put(self, nv12: bytes, t_ms: int) -> None:
        with self._lock:
            self._frame = Frame(
                nv12=nv12,
                t_ms=t_ms,
                camera=self.camera,
                width=self.width,
                height=self.height,
            )
            self._jpeg = None

    def latest(self) -> Frame | None:
        with self._lock:
            return self._frame

    def jpeg(self) -> bytes | None:
        with self._lock:
            if self._jpeg is not None:
                return self._jpeg
            frame = self._frame
        if frame is None:
            return None

        # Encode outside the lock: a 3 MB frame takes long enough that holding
        # it would stall the subscriber thread and drop frames.
        data = self._encode(frame.nv12, frame.width, frame.height)
        with self._lock:
            if self._frame is frame:
                self._jpeg = data
        return data
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_mipi_camera.py -q'
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/mipi_camera.py rdk/vision/tests/test_mipi_camera.py
git commit -m "feat(vision): add FrameBuffer, one latest frame with a lazy JPEG"
```

---

### Task 4: `MipiCamera` — process ownership, orphan reaping, `frames()`

**Files:**
- Modify: `rdk/vision/mipi_camera.py`
- Test: `rdk/vision/tests/test_mipi_camera.py`

**Interfaces:**
- Consumes: `FrameBuffer` (Task 3).
- Produces: `reap_orphans(holders=_isp_holders, kill=os.kill, sleep=time.sleep) -> list[int]`; `MipiCamera(channel: int, sensor: str, camera: str, width: int = 1920, height: int = 1080)` with `start(settle_seconds: float = 8.0) -> None`, `stop() -> None`, `latest() -> Frame | None`, `jpeg() -> bytes | None`, `frames(fps: float = 10.0) -> Iterator[Frame]`. `MipiCamera.buffer` is the `FrameBuffer`.

- [ ] **Step 1: Write the failing tests**

Append to `rdk/vision/tests/test_mipi_camera.py`:

```python
import signal

from mipi_camera import MipiCamera, reap_orphans


def test_reap_orphans_returns_empty_when_nothing_holds_the_isp():
    killed = []
    assert reap_orphans(holders=lambda: [], kill=lambda p, s: killed.append((p, s)),
                        sleep=lambda s: None) == []
    assert killed == []


def test_reap_orphans_terminates_every_holder():
    # The measured failure: an orphaned mipi_cam holding /dev/vs-isp0_* makes
    # every later open fail with a message about sensor detection.
    killed = []
    pids = reap_orphans(holders=lambda: [17363, 17400],
                        kill=lambda p, s: killed.append((p, s)),
                        sleep=lambda s: None)
    assert pids == [17363, 17400]
    assert (17363, signal.SIGTERM) in killed
    assert (17400, signal.SIGTERM) in killed


def test_reap_orphans_escalates_to_sigkill_for_survivors():
    killed = []
    rounds = iter([[17363], [17363]])
    reap_orphans(holders=lambda: next(rounds),
                 kill=lambda p, s: killed.append((p, s)),
                 sleep=lambda s: None)
    assert killed == [(17363, signal.SIGTERM), (17363, signal.SIGKILL)]


def test_reap_orphans_tolerates_a_process_that_already_exited():
    def kill(pid, sig):
        raise ProcessLookupError

    assert reap_orphans(holders=lambda: [1], kill=kill, sleep=lambda s: None) == [1]


def test_frames_yields_each_new_frame_once():
    camera = MipiCamera(channel=0, sensor="OV5647", camera="front", width=4, height=2)
    camera.buffer.put(b"aaaaaaaaaaaa", t_ms=100)

    stream = camera.frames(fps=1000.0)
    first = next(stream)
    assert first.t_ms == 100

    camera.buffer.put(b"bbbbbbbbbbbb", t_ms=200)
    second = next(stream)
    assert second.t_ms == 200
    # A repeated frame must never be yielded twice: everything downstream
    # derives dt from t_ms, and a duplicate would read as zero elapsed time.
    camera.stop()


def test_frames_stops_when_the_camera_stops():
    camera = MipiCamera(channel=0, sensor="OV5647", camera="front", width=4, height=2)
    camera.buffer.put(b"aaaaaaaaaaaa", t_ms=1)
    camera.stop()
    assert list(camera.frames(fps=1000.0)) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_mipi_camera.py -q'
```

Expected: FAIL — `ImportError: cannot import name 'MipiCamera'`.

- [ ] **Step 3: Implement orphan reaping**

Add to `rdk/vision/mipi_camera.py`, after the imports (add `contextlib`, `os`, `signal`, `subprocess`, `time`, and `from typing import Iterator` to the import block):

```python
TOPIC = "/image_raw"
#: One of the nodes a live mipi_cam holds. Checking one is enough — they are
#: acquired together — and it is the one whose holder blocks the next open.
ISP_DEVICE = "/dev/vs-isp0_cap"


def _isp_holders(run=subprocess.run) -> list[int]:
    """PIDs holding the ISP capture node, via fuser. Empty if fuser is absent."""
    try:
        out = run(["fuser", ISP_DEVICE], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [int(token) for token in out.split() if token.isdigit()]


def reap_orphans(holders=_isp_holders, kill=os.kill, sleep=time.sleep) -> list[int]:
    """Clear any process still holding the camera, and report what was killed.

    Without this a max-vision restart can never reacquire the camera: the dead
    service's child keeps the ISP, and the next open fails with a message about
    sensor detection that sends you looking at i2c. Measured, not hypothesised.
    """
    pids = holders()
    if not pids:
        return []

    for pid in pids:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            kill(pid, signal.SIGTERM)
    sleep(2.0)
    for pid in holders():
        with contextlib.suppress(ProcessLookupError, PermissionError):
            kill(pid, signal.SIGKILL)
    return pids
```

- [ ] **Step 4: Implement `MipiCamera`**

Append to `rdk/vision/mipi_camera.py`:

```python
class MipiCamera:
    """Owns one mipi_cam process and the subscriber that drains it."""

    def __init__(self, channel: int, sensor: str, camera: str,
                 width: int = 1920, height: int = 1080) -> None:
        self.channel = channel
        self.sensor = sensor
        self.width = width
        self.height = height
        self.buffer = FrameBuffer(camera, width, height)
        self._proc: subprocess.Popen | None = None
        self._node = None
        self._executor = None
        self._spin_thread: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self, settle_seconds: float = 8.0) -> None:
        import rclpy  # noqa: PLC0415 - board-only
        from rclpy.executors import SingleThreadedExecutor  # noqa: PLC0415
        from sensor_msgs.msg import Image  # noqa: PLC0415

        reap_orphans()

        self._proc = subprocess.Popen(
            [
                "ros2", "run", "mipi_cam", "mipi_cam", "--ros-args",
                "-p", f"video_device:={self.sensor}",
                "-p", f"channel:={self.channel}",
                "-p", f"image_width:={self.width}",
                "-p", f"image_height:={self.height}",
                "-p", "out_format:=nv12",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        def on_image(msg) -> None:
            self.buffer.put(bytes(msg.data), int(msg.header.stamp.sec * 1000
                                                 + msg.header.stamp.nanosec // 1_000_000))

        if not rclpy.ok():
            rclpy.init()
        self._node = rclpy.create_node(f"max_vision_ch{self.channel}")
        self._node.create_subscription(Image, TOPIC, on_image, 10)

        # Each camera gets its own executor. rclpy.spin_once() drives a global
        # one, so two cameras spinning concurrently raise "generator already
        # executing" — exactly what front+rear would hit.
        self._executor = SingleThreadedExecutor()
        self._executor.add_node(self._node)

        def spin() -> None:
            while not self._stop.is_set() and rclpy.ok():
                self._executor.spin_once(timeout_sec=0.1)

        self._spin_thread = threading.Thread(target=spin, daemon=True)
        self._spin_thread.start()

        # mipi_cam needs several seconds to probe the sensor and start the flow.
        # Paying it here, once at service start, is what keeps a capture a frame
        # grab — and so inside the relay's 8 s DEVICE_RESULT_TIMEOUT_MS.
        deadline = time.monotonic() + settle_seconds
        while time.monotonic() < deadline:
            if self.buffer.latest() is not None:
                return
            if self._proc.poll() is not None:
                raise RuntimeError(f"mipi_cam exited early on channel {self.channel}")
            time.sleep(0.2)
        raise RuntimeError(
            f"no frame on {TOPIC} within {settle_seconds:.0f}s (channel {self.channel})"
        )

    def latest(self) -> Frame | None:
        return self.buffer.latest()

    def jpeg(self) -> bytes | None:
        return self.buffer.jpeg()

    def frames(self, fps: float = 10.0) -> Iterator[Frame]:
        """Satisfies the FrameSource protocol, so ADAS reaches live frames through
        the same seam as FileSource and replay parity stays structural."""
        interval = 1.0 / fps
        last_t: int | None = None
        while not self._stop.is_set():
            frame = self.buffer.latest()
            if frame is not None and frame.t_ms != last_t:
                last_t = frame.t_ms
                yield frame
            time.sleep(interval / 2)

    def stop(self) -> None:
        self._stop.set()
        if self._spin_thread is not None:
            self._spin_thread.join(timeout=2.0)
            self._spin_thread = None
        if self._executor is not None:
            self._executor.remove_node(self._node)
            self._executor.shutdown()
            self._executor = None
        if self._node is not None:
            self._node.destroy_node()
            self._node = None
        if self._proc is not None:
            # terminate -> wait -> kill. Skipping the wait is how an orphan gets
            # created, and an orphan makes the camera unopenable until reaped.
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            self._proc = None
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_mipi_camera.py -q'
```

Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add rdk/vision/mipi_camera.py rdk/vision/tests/test_mipi_camera.py
git commit -m "feat(vision): MipiCamera owns the process, reaps orphans, yields frames"
```

---

### Task 5: `CameraPair` on `MipiCamera` — photo, preview, real `.mjpeg` recording

`camera.py` opens through the dead binding and hardcodes IMX219. Replace both, and make `camera.record` actually write a file — today it names `front.h264` in a manifest that nothing ever creates.

**Files:**
- Modify: `rdk/vision/camera.py`
- Test: `rdk/vision/tests/test_camera_policy.py`

**Interfaces:**
- Consumes: `MipiCamera` (Task 4), `discover` (Task 2), `Gallery` (unchanged).
- Produces: `CameraPair(front_channel: int, rear_channel: int)` with `open()`, `capture_photo(gallery)`, `start_recording(gallery)`, `stop_recording(gallery)`, `serve_preview(port)` — the RPC-facing contract is unchanged. `CameraPair.front` / `.rear` are `MipiCamera | None`.

- [ ] **Step 1: Write the failing tests**

Replace the `FakeSensor` class and `pair` fixture at the top of `rdk/vision/tests/test_camera_policy.py` with:

```python
class FakeCamera:
    """Stands in for MipiCamera: the pair only ever asks it for a JPEG."""

    def __init__(self, works=True):
        self.works = works
        self.frames = 0

    def jpeg(self):
        if not self.works:
            return None
        self.frames += 1
        return b"\xff\xd8fake-jpeg\xff\xd9"

    def stop(self):
        pass


@pytest.fixture()
def pair():
    cameras = CameraPair(front_channel=0, rear_channel=2)
    cameras.front = FakeCamera()
    cameras.rear = FakeCamera()
    cameras.opened = True
    return cameras
```

Then update every remaining `FakeSensor(...)` in the file to `FakeCamera(...)`, and any `works=False` sensor expectations stay as they are — a camera whose `jpeg()` returns `None` is the "dead sensor" case the existing tests already cover.

Add these tests:

```python
def test_recording_names_mjpeg_not_h264(pair, gallery):
    # h264 was aspirational: no code ever wrote those files. Naming a file that
    # will not exist is the same class of lie as reporting a false success.
    result = pair.start_recording(gallery, drive=False)
    assert result["status"] == "ok"
    pair.stop_recording(gallery)
    manifest = json.loads(
        (Path(gallery.root) / result["detail"] / "manifest.json").read_text()
    )
    assert manifest["front"] == "front.mjpeg"
    assert manifest["rear"] == "rear.mjpeg"


def test_recording_writes_frames_to_the_segment(pair, gallery):
    # drive=False so the test owns the clock. With the writer thread running,
    # counting frames would race it and flake.
    result = pair.start_recording(gallery, drive=False)
    pair.write_recording_frame()
    pair.write_recording_frame()
    pair.stop_recording(gallery)
    written = (Path(gallery.root) / result["detail"] / "front.mjpeg").read_bytes()
    assert written.count(b"\xff\xd8") == 2


def test_recording_only_writes_cameras_the_manifest_claims(pair, gallery):
    pair.rear = FakeCamera(works=False)
    result = pair.start_recording(gallery, drive=False)
    pair.write_recording_frame()
    pair.stop_recording(gallery)
    directory = Path(gallery.root) / result["detail"]
    assert (directory / "front.mjpeg").exists()
    assert not (directory / "rear.mjpeg").exists()
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_camera_policy.py -q'
```

Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'front_channel'`.

- [ ] **Step 3: Rewrite the opener and the grab**

In `rdk/vision/camera.py`, replace the module docstring's second paragraph and the `__init__` / `open` / `_grab` methods:

```python
class CameraPair:
    def __init__(self, front_channel: int, rear_channel: int) -> None:
        self.front_channel = front_channel
        self.rear_channel = rear_channel
        self.front = None
        self.rear = None
        self.opened = False
        self.recording_id: str | None = None
        self.recording_started_at: float | None = None
        self.recording_sides: dict[str, str | None] = {"front": None, "rear": None}
        self._recording_dir: Path | None = None
        self._recording_stop = threading.Event()
        self._recording_thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._stop_timer: threading.Timer | None = None

    def open(self) -> None:
        from mipi_camera import MipiCamera  # noqa: PLC0415 - board-only
        from sensors import discover  # noqa: PLC0415

        # Never hardcode a sensor: an assumed IMX219 is why the OV5647 in CAM1
        # could not be opened, and the binding path cannot open either one.
        attached = discover()
        for attr, channel in (("front", self.front_channel), ("rear", self.rear_channel)):
            sensor = attached.get(channel)
            if sensor is None:
                print(f"[vision] no camera on channel {channel} ({attr})", flush=True)
                continue
            camera = MipiCamera(channel=channel, sensor=sensor, camera=attr,
                                width=WIDTH, height=HEIGHT)
            try:
                camera.start()
                setattr(self, attr, camera)
                print(f"[vision] {attr}: {sensor} on channel {channel}", flush=True)
            except Exception as error:  # noqa: BLE001 - one camera is enough
                camera.stop()
                print(f"[vision] {attr} camera unavailable on channel {channel}: {error}",
                      flush=True)
        self.opened = self.front is not None or self.rear is not None

    def _grab(self, camera) -> bytes | None:
        """Latest frame as JPEG, or None if this camera is absent or has no frame."""
        if camera is None:
            return None
        try:
            return camera.jpeg()
        except Exception:  # noqa: BLE001 - one dead camera must not fail the pair
            return None
```

Add `from pathlib import Path` to the imports at the top of the file.

- [ ] **Step 4: Make recording write real files**

In `rdk/vision/camera.py`, change the suffix in `start_recording` from `.h264` to `.mjpeg`, record the directory, and add the writer. Replace the `sides` block inside `start_recording`:

```python
            sides: dict[str, str | None] = {
                "front": "front.mjpeg" if self._grab(self.front) is not None else None,
                "rear": "rear.mjpeg" if self._grab(self.rear) is not None else None,
            }
```

and, after `self.recording_sides = sides`, add:

```python
            self._recording_dir = gallery.pair_dir(pair_id)
```

In `stop_recording`, add `self._recording_dir = None` alongside the other resets inside the lock.

Then add this method to `CameraPair`:

```python
    def write_recording_frame(self) -> None:
        """Append one JPEG per recording camera. Appending JPEGs is what makes the
        segment an .mjpeg, which corpus/library.py already reads."""
        with self._lock:
            directory = self._recording_dir
            sides = dict(self.recording_sides)
        if directory is None:
            return

        for side, filename in sides.items():
            if filename is None:
                continue
            data = self._grab(self.front if side == "front" else self.rear)
            if data is None:
                continue
            directory.mkdir(parents=True, exist_ok=True)
            with (directory / filename).open("ab") as handle:
                handle.write(data)
```

- [ ] **Step 5: Drive the writer from a thread**

Add `RECORDING_FPS = 10.0` next to `WIDTH`/`HEIGHT`, change the signature to `def start_recording(self, gallery: Gallery, drive: bool = True) -> dict:`, and in `start_recording`, after the existing `self._stop_timer` block, start the writer:

```python
        # drive=False lets a test own the clock and call write_recording_frame
        # itself; counting frames against a live thread would flake.
        if drive:
            self._recording_stop = threading.Event()

            def write_loop() -> None:
                while not self._recording_stop.wait(1.0 / RECORDING_FPS):
                    self.write_recording_frame()

            self._recording_thread = threading.Thread(target=write_loop, daemon=True)
            self._recording_thread.start()
```

In `stop_recording` — after the lock block, next to the timer cancel — add:

```python
        self._recording_stop.set()
        if self._recording_thread is not None:
            self._recording_thread.join(timeout=2.0)
            self._recording_thread = None
```

- [ ] **Step 6: Point preview at the new grab**

In `serve_preview`, replace the sensor selection line so it uses the pair's cameras:

```python
                camera = pair.front if self.path.endswith("front") else pair.rear
```

and replace `data = pair._grab(sensor)` with `data = pair._grab(camera)`.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_camera_policy.py -q'
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add rdk/vision/camera.py rdk/vision/tests/test_camera_policy.py
git commit -m "feat(vision): open cameras via mipi_cam; record real .mjpeg segments"
```

---

### Task 6: Wire the service to channels

**Files:**
- Modify: `rdk/vision/service.py`
- Modify: `rdk/README.md`

**Interfaces:**
- Consumes: `CameraPair(front_channel=..., rear_channel=...)` (Task 5).
- Produces: `RDK_CAMERA_FRONT` / `RDK_CAMERA_REAR` as MIPI channels defaulting to `0` and `2`.

- [ ] **Step 1: Change the construction**

In `rdk/vision/service.py`, replace the `cameras = CameraPair(...)` block:

```python
# MIPI channels, not VCON indices. CAM1 is channel 0 (i2c bus 6, vcon@0/@1) and
# the other connector is channel 2 (bus 4, vcon@2/@3). Channels 1 and 3 are not
# offered because this board does not have hosts 1 and 3 — the previous default
# of front=0 rear=1 named the same connector twice, one of them nonexistent.
cameras = CameraPair(
    front_channel=int(os.environ.get("RDK_CAMERA_FRONT", "0")),
    rear_channel=int(os.environ.get("RDK_CAMERA_REAR", "2")),
)
```

- [ ] **Step 2: Stop the cameras on shutdown**

In `main()`, wrap the serve loop so children are never orphaned:

```python
    with ControlServer(SOCKET_PATH, ControlHandler) as server:
        os.chmod(SOCKET_PATH, 0o660)
        try:
            server.serve_forever()
        finally:
            # An orphaned mipi_cam holds the ISP, and the next start cannot open
            # the camera at all. Reaping at startup covers a crash; this covers
            # every ordinary stop.
            for camera in (cameras.front, cameras.rear):
                if camera is not None:
                    camera.stop()
```

- [ ] **Step 3: Document the environment variables**

In `rdk/README.md`, add these two lines to the `/etc/max/agent.env` heredoc, after `MAX_VISION_SOCKET=/run/max/vision.sock`:

```bash
RDK_CAMERA_FRONT=0                         # MIPI channel; CAM1 connector
RDK_CAMERA_REAR=2                          # MIPI channel; the other connector
```

- [ ] **Step 4: Run the full suite**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'
```

Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/service.py rdk/README.md
git commit -m "feat(vision): configure cameras by MIPI channel, defaulting 0 and 2"
```

---

### Task 7: Collapse the recorder onto `MipiCamera`, and stop calling channels VCONs

`recorder/mipi_source.py` is a second implementation of the same ownership. `CameraSlot.vcon` holds a channel — exactly the conflation this work exists to end.

**Files:**
- Modify: `rdk/vision/recorder/mipi_source.py`
- Modify: `rdk/vision/recorder/session.py:22-24`
- Modify: `rdk/vision/tools/record_ride.py`
- Modify: `rdk/vision/camera_binding.py:1-11`
- Test: `rdk/vision/tests/test_session.py:41`

**Interfaces:**
- Consumes: `MipiCamera` (Task 4), `discover` (Task 2).
- Produces: `CameraSlot(name: str, channel: int)`; `MipiCamSource` is removed and `write_jpeg(camera: MipiCamera, out_path: Path) -> None` stays, now taking a `MipiCamera`.

- [ ] **Step 1: Rename the field**

In `rdk/vision/recorder/session.py`, change `CameraSlot`:

```python
@dataclass(frozen=True)
class CameraSlot:
    name: str
    #: MIPI channel, not a VCON index — 0 is the CAM1 connector, 2 is the other.
    channel: int
```

Update `rdk/vision/tests/test_session.py:41` from `CameraSlot("front", 2), CameraSlot("rear", 3)` to `CameraSlot("front", 0), CameraSlot("rear", 2)`.

- [ ] **Step 2: Collapse the duplicate source**

Replace the whole body of `rdk/vision/recorder/mipi_source.py` with:

```python
"""Recording-side adapter over the sidecar's camera.

This used to hold a second implementation of mipi_cam ownership. One is enough:
the board allows one holder, so two classes that each spawn a process were two
ways to produce the same orphan. MipiCamera is that one implementation.

Frames are appended as JPEG, so a segment is concatenated JPEG (``.mjpeg``)
rather than an encoded H.264 stream.
"""

from __future__ import annotations

from pathlib import Path

from mipi_camera import MipiCamera


def write_jpeg(camera: MipiCamera, out_path: Path) -> None:
    """Append one JPEG to the segment. Raising propagates to RideRecorder, which
    drops this camera and keeps the ride going."""
    frame = camera.jpeg()
    if frame is None:
        raise RuntimeError(f"no frame available on channel {camera.channel}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("ab") as handle:
        handle.write(frame)
```

- [ ] **Step 3: Update the ride recorder**

In `rdk/vision/tools/record_ride.py`, replace `_make_mipi_opener` with a discovery-driven opener:

```python
def _open_mipi(slot: CameraSlot):
    from mipi_camera import MipiCamera  # noqa: PLC0415
    from sensors import discover  # noqa: PLC0415

    sensor = discover().get(slot.channel)
    if sensor is None:
        raise RuntimeError(f"no camera on channel {slot.channel}")
    camera = MipiCamera(channel=slot.channel, sensor=sensor, camera=slot.name,
                        width=WIDTH, height=HEIGHT)
    camera.start()
    return camera
```

Change `_open_binding` to use `slot.channel`, and change the argument parser:

```python
    parser.add_argument("--front-channel", type=int, default=0)
    parser.add_argument("--rear-channel", type=int, default=2)
```

Delete the `--sensor` argument — the sensor is discovered now. Update the two source lines:

```python
    if args.source == "mipi_cam":
        from recorder.mipi_source import write_jpeg  # noqa: PLC0415

        open_fn, encode_fn, suffix = _open_mipi, write_jpeg, ".mjpeg"
```

and the slots:

```python
        slots=[CameraSlot("front", args.front_channel), CameraSlot("rear", args.rear_channel)],
```

- [ ] **Step 4: Fix the module docstring**

Replace the paragraph in `rdk/vision/tools/record_ride.py` beginning "Front camera is VCON 2 and rear is VCON 3":

```python
Front is MIPI channel 0 (the CAM1 connector, i2c bus 6) and rear is channel 2
(the other connector, bus 4). The sensor on each is discovered, not configured.
A camera that will not open is logged and skipped — front-only rides are
expected on current hardware, which has one module.
```

- [ ] **Step 5: Correct the binding's docstring**

`rdk/vision/camera_binding.py` opens by asserting `vcon@0` "has no connector". It is the CAM1 connector. Replace the first paragraph of the module docstring:

```python
"""Explicit MIPI port selection for RDK X5 cameras.

The stock ``libsrcampy.open_cam(port, -1, ...)`` auto-detect is unusable on this
board: it always searches ``vcon@0`` (i2c bus 6) and reports a phantom ov5647
there — the log line lists *supported* sensors, not detected ones — then
``cam-service`` NULL-dereferences initialising a sensor it never confirmed,
taking the whole pipeline down.

``vcon@0`` is the CAM1 connector and can hold a real camera; an earlier version
of this note claimed it had none, which was only true of the bench at the time.
"""
```

Also correct the `OV5647` comment above the sensor specs — replace `#: Measured on hardware: IMX219 streams, OV5647 fails at video-flow start.` with:

```python
#: Measured on hardware: IMX219 streams on host 2; OV5647 streams on host 0 and
#: fails at video-flow start on host 2. The port is the variable, not the sensor.
```

Leave the rest of the module alone — `hbn_camera_create` still returns -1, and that part of the docstring is accurate.

- [ ] **Step 6: Run the full suite**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add rdk/vision/recorder/ rdk/vision/tools/record_ride.py rdk/vision/tests/test_session.py rdk/vision/camera_binding.py
git commit -m "refactor(vision): one camera owner; slots carry channels, not VCONs"
```

---

### Task 8: Verify it live on the board

Unit tests cannot prove any of this. The deliverable is a camera that works.

**Files:**
- Modify: `rdk/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: recorded evidence in the bench-findings table.

- [ ] **Step 1: Deploy and restart**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'systemctl restart max-vision && sleep 12 && journalctl -u max-vision -n 20 --no-pager | tail -8'
```

Expected: a line like `[vision] front: OV5647 on channel 0`, and `[vision] no camera on channel 2 (rear)`.

- [ ] **Step 2: Confirm the preview serves real frames**

```bash
curl -s --max-time 8 "http://$BOARD:8081/front" --output /tmp/preview.mjpeg; ls -l /tmp/preview.mjpeg
python3 -c "d=open('/tmp/preview.mjpeg','rb').read(); print('jpeg frames:', d.count(b'\xff\xd8'))"
```

Expected: a file of non-trivial size, several JPEG start markers.

- [ ] **Step 3: Capture a photo through the control socket**

```bash
ssh root@$BOARD 'printf %s\\n "{\"id\":\"t1\",\"method\":\"camera.photo\",\"args\":{}}" | socat - UNIX-CONNECT:/run/max/vision.sock'
ssh root@$BOARD 'ls -lR /var/lib/max/gallery | tail -12'
```

Expected: `"status":"ok"`, and a pair directory containing a `front.jpg` of realistic size (100 KB+). If `socat` is missing, use `python3 -c` with a `socket.AF_UNIX` client.

- [ ] **Step 4: Look at the photo**

```bash
scp root@$BOARD:/var/lib/max/gallery/<pair-id>/front.jpg /tmp/check.jpg
```

Open it. A file of the right size that decodes to a black or noise image is a failure — this step exists because "it streamed" is not the same as "it produced a picture".

- [ ] **Step 5: Record a short clip**

```bash
ssh root@$BOARD 'printf %s\\n "{\"id\":\"t2\",\"method\":\"camera.record\",\"args\":{\"start\":true}}" | socat - UNIX-CONNECT:/run/max/vision.sock; sleep 5; printf %s\\n "{\"id\":\"t3\",\"method\":\"camera.record\",\"args\":{\"start\":false}}" | socat - UNIX-CONNECT:/run/max/vision.sock'
ssh root@$BOARD 'ls -l /var/lib/max/gallery/*/front.mjpeg | tail -2'
```

Expected: a `front.mjpeg` of roughly 40–60 frames' worth of JPEG at 10 fps. Confirm it decodes: `ffprobe` it on the board, or `ffmpeg -i front.mjpeg -frames:v 1 /tmp/first.jpg`.

- [ ] **Step 6: The orphan regression — restart twice**

```bash
ssh root@$BOARD 'systemctl restart max-vision && sleep 12 && systemctl restart max-vision && sleep 12 && journalctl -u max-vision -n 10 --no-pager | tail -4'
```

Expected: the second restart also logs `[vision] front: OV5647 on channel 0`. **This is the test most likely to fail** — if the second start reports no camera or `The detected sensors are 1 less than expected`, orphan reaping is not working, and nothing else in this task matters.

- [ ] **Step 7: Confirm ADAS sees live frames**

```bash
ssh root@$BOARD 'journalctl -u max-vision -n 60 --no-pager | grep -i "adas" | tail -5'
```

Expected: the shadow-mode runtime logging progress rather than a `RecordingRequired` or source error. ADAS stays in shadow mode — `MAX_ADAS_AUDIO` is untouched by this work.

- [ ] **Step 8: Record the results**

Add to the bench-findings table in `rdk/README.md`, with real measured values rather than the placeholders below:

```markdown
| CAM1 live capture          | **works** — OV5647 ch 0, photo + preview + .mjpeg via max-vision      | 2026-07-27 |
| max-vision restart         | **reacquires** — two consecutive restarts, orphan reaped each time    | 2026-07-27 |
```

- [ ] **Step 9: Run the full suite, and confirm offline parity**

```bash
ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q | tail -3'
ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_replay.py tests/test_frame_source.py tests/test_runtime.py -q | tail -3'
```

Expected: PASS. Report the count — the README records 200 passing as of 2026-07-26, so the number should have grown.

The second command is the parity check the spec asks for: replay and the runtime reach frames through the same `FrameSource` seam as the new live source, so if adding `MipiCamera.frames()` changed anything about how frames are consumed, these fail. They must be **unchanged** — not merely passing, but passing for the same reasons. If any of them needed editing during this work, say so explicitly rather than treating a green run as parity.

- [ ] **Step 10: Commit**

```bash
git add rdk/README.md
git commit -m "docs(rdk): record CAM1 live capture working end to end"
```

---

## Notes for the implementer

- **Do not open a camera outside max-vision while it is running.** Stop the service first, and check `ps -eo pid,args | grep "[m]ipi_cam/mipi_cam"` afterwards. Every confusing camera failure in this codebase's history traces back to a second holder.
- **`hbn_camera_create` returning -1 is expected**, not a regression to chase. The binding path stays behind `--source binding` for the day someone fixes it.
- **If a test needs numpy or cv2 to pass, the design is wrong.** Inject an encoder instead, as `FrameBuffer` does — the suite must stay runnable without a camera attached.
