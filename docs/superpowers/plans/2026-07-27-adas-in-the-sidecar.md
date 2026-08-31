# ADAS in the Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give max-vision a ride that starts continuous segment recording and the shadow-mode ADAS threads together, so `start_adas` finally has a caller and every alert it logs has evidence on disk.

**Architecture:** A `RideSession` owns a `RideRecorder` over the already-open cameras plus one ADAS thread per camera; both read the shared `FrameBuffer`, so nothing opens hardware twice. An `EventBus` holds the connected control-socket clients and gives `emit` somewhere to go. A `RebasedSource` rewrites frame timestamps relative to ride start and bounds the ADAS loop's lifetime.

**Tech Stack:** Python 3.10 on Ubuntu 22.04 (aarch64), ROS 2 Humble via `mipi_cam`, `hobot_dnn` (BPU), pytest 6.2.5.

**Spec:** `docs/superpowers/specs/2026-07-27-adas-in-the-sidecar-design.md`

## Global Constraints

- **The test suite runs on the board.** No pytest or numpy on the dev Mac. `export BOARD=10.42.0.11` — network-dependent; find it with `arp -a`, narrow with `nc -G 2 -z <ip> 22`, confirm with `ssh root@<ip> 'ls /usr/hobot'`.
- **Deploy + test:** `scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'`
- **`MAX_ADAS_AUDIO` is not touched and stays `0`.** This work makes no sound. Arming is a human decision against shadow numbers meeting the M1 gate.
- **`MAX_ADAS_SHADOW` defaults to `0`.** Only the exact string `1` enables it, matching how `MAX_RELAY_INSECURE_TLS` is read. Nothing changes for an existing board until opted in.
- **Exactly one process may hold the camera.** `RideSession` receives cameras that `CameraPair.open()` already opened; it must never open one itself.
- **Board-only imports are lazy** — `hobot_dnn`, `cv2`, `numpy`, `rclpy` inside functions, marked `# noqa: PLC0415`, so the unit suite runs without hardware.
- **House style:** module docstrings explain _why_. Tests use `sys.path.insert(0, str(Path(__file__).resolve().parents[1]))` and import modules directly.
- Work on branch `feat/adas-in-the-sidecar` (already created; the spec is committed there).

---

### Task 1: `EventBus` — the push half of the control socket

Nothing can report a hazard today, ADAS or not: `ControlHandler` only answers the connection that asked. This task is independently useful and lands first.

**Files:**

- Create: `rdk/vision/events.py`
- Modify: `rdk/vision/service.py`
- Test: `rdk/vision/tests/test_events.py`

**Interfaces:**

- Consumes: `encode_event(name, **fields) -> str` from `rpc`.
- Produces: `EventBus()` with `register(write: Callable[[str], None]) -> None`, `unregister(write) -> None`, `broadcast(payload: dict) -> int` returning the number of clients delivered to. `payload` must carry an `"event"` key.

- [ ] **Step 1: Write the failing tests**

Create `rdk/vision/tests/test_events.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import json

from events import EventBus


def collector():
    lines = []
    return lines.append, lines


def test_broadcast_with_no_clients_delivers_to_nobody():
    assert EventBus().broadcast({"event": "hazard"}) == 0


def test_broadcast_reaches_every_registered_client():
    bus = EventBus()
    first_write, first = collector()
    second_write, second = collector()
    bus.register(first_write)
    bus.register(second_write)

    assert bus.broadcast({"event": "hazard", "severity": "warn"}) == 2
    assert json.loads(first[0]) == {"event": "hazard", "severity": "warn"}
    assert first == second


def test_each_broadcast_is_one_newline_terminated_line():
    # The agent frames on newlines; a line without one merges into the next.
    bus = EventBus()
    write, lines = collector()
    bus.register(write)
    bus.broadcast({"event": "hazard"})
    assert lines[0].endswith("\n")
    assert lines[0].count("\n") == 1


def test_an_unregistered_client_stops_receiving():
    bus = EventBus()
    write, lines = collector()
    bus.register(write)
    bus.unregister(write)
    assert bus.broadcast({"event": "hazard"}) == 0
    assert lines == []


def test_a_client_that_raises_is_dropped_and_the_others_still_get_it():
    # A rider's socket dying must not cost the others their alert.
    bus = EventBus()
    def dead(_line):
        raise BrokenPipeError

    good_write, good = collector()
    bus.register(dead)
    bus.register(good_write)

    assert bus.broadcast({"event": "hazard"}) == 1
    assert len(good) == 1
    # The dead client is gone, not retried forever.
    assert bus.broadcast({"event": "hazard"}) == 1


def test_unregistering_an_unknown_client_is_not_an_error():
    EventBus().unregister(lambda _line: None)
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_events.py -q'
```

Expected: FAIL — `ModuleNotFoundError: No module named 'events'`.

- [ ] **Step 3: Implement `EventBus`**

Create `rdk/vision/events.py`:

```python
"""Who is listening on the control socket.

The protocol has always been bidirectional — `rpc.encode_event` and the module
docstring in `agent/src/vision-client.ts` both describe unsolicited `event`
messages — but the server half was never built: `ControlHandler` writes only to
the connection that made a request. An ADAS thread has no such connection, so
without this registry a hazard has nowhere to go.
"""

from __future__ import annotations

import threading
from typing import Callable

from rpc import encode_event


class EventBus:
    """Fan one event out to every connected client.

    A client is just a callable that takes a line. Keeping it that narrow means
    the bus never touches sockets, so it tests without one.
    """

    def __init__(self) -> None:
        self._clients: list[Callable[[str], None]] = []
        self._lock = threading.Lock()

    def register(self, write: Callable[[str], None]) -> None:
        with self._lock:
            self._clients.append(write)

    def unregister(self, write: Callable[[str], None]) -> None:
        with self._lock:
            if write in self._clients:
                self._clients.remove(write)

    def broadcast(self, payload: dict) -> int:
        """Deliver one event, returning how many clients took it.

        A client whose write raises is dropped rather than retried: the socket is
        gone, and one dead rider's connection must not cost the others theirs.
        """
        fields = {key: value for key, value in payload.items() if key != "event"}
        line = encode_event(payload["event"], **fields)

        with self._lock:
            clients = list(self._clients)

        delivered = 0
        dead: list[Callable[[str], None]] = []
        for write in clients:
            try:
                write(line)
                delivered += 1
            except Exception:  # noqa: BLE001 - a broken client is expected, not exceptional
                dead.append(write)

        if dead:
            with self._lock:
                self._clients = [c for c in self._clients if c not in dead]
        return delivered
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_events.py -q'
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Register control-socket clients with the bus**

In `rdk/vision/service.py`, add `from events import EventBus` to the imports and create the bus next to `gallery`:

```python
events = EventBus()
```

Then make `ControlHandler` register and unregister itself. Replace the `handle` method:

```python
class ControlHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        def write(line: str) -> None:
            self.wfile.write(line.encode("utf-8"))
            self.wfile.flush()

        events.register(write)
        try:
            buffer = ""
            while True:
                chunk = self.rfile.readline()
                if not chunk:
                    return
                buffer += chunk.decode("utf-8", errors="replace")
                messages, buffer = decode_lines(buffer)
                for message in messages:
                    line = dispatch(message, HANDLERS)
                    if line:
                        write(line)
        finally:
            # ThreadingUnixStreamServer gives each connection its own thread, so
            # a client that goes away leaves a closure behind unless we say so.
            events.unregister(write)
```

- [ ] **Step 6: Run the full suite**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'
```

Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add rdk/vision/events.py rdk/vision/tests/test_events.py rdk/vision/service.py
git commit -m "feat(vision): add the event bus the control socket always promised"
```

---

### Task 2: `RebasedSource` — ride-relative timestamps, bounded lifetime

**Files:**

- Create: `rdk/vision/adas/rebase.py`
- Test: `rdk/vision/tests/test_rebase.py`

**Interfaces:**

- Consumes: `Frame` from `perception.frame_source`.
- Produces: `RebasedSource(source, stop: threading.Event | None = None)` with `frames() -> Iterator[Frame]`, satisfying the `FrameSource` protocol.

- [ ] **Step 1: Write the failing tests**

Create `rdk/vision/tests/test_rebase.py`:

```python
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.rebase import RebasedSource
from perception.frame_source import Frame


class FakeSource:
    def __init__(self, stamps, camera="front"):
        self.stamps = stamps
        self.camera = camera

    def frames(self):
        for t_ms in self.stamps:
            yield Frame(nv12=b"xy", t_ms=t_ms, camera=self.camera, width=4, height=2)


def test_the_first_frame_becomes_time_zero():
    # A live camera reports board uptime — 2,992,848 ms when measured. run_camera
    # divides t_ms by the segment length to pick a segment, so unrebased stamps
    # name segment ~49,880, which will never exist.
    frames = list(RebasedSource(FakeSource([2_992_848])).frames())
    assert frames[0].t_ms == 0


def test_spacing_between_frames_is_preserved():
    frames = list(RebasedSource(FakeSource([2_992_848, 2_992_948, 2_993_048])).frames())
    assert [f.t_ms for f in frames] == [0, 100, 200]


def test_everything_except_the_stamp_passes_through():
    frame = next(iter(RebasedSource(FakeSource([500], camera="rear")).frames()))
    assert frame.nv12 == b"xy"
    assert frame.camera == "rear"
    assert (frame.width, frame.height) == (4, 2)


def test_a_set_stop_event_ends_the_stream():
    # Without this a ride cannot end: MipiCamera.frames() runs until the camera
    # stops, so an ADAS thread would outlive the ride that started it.
    stop = threading.Event()
    stop.set()
    assert list(RebasedSource(FakeSource([1, 2, 3]), stop=stop).frames()) == []


def test_setting_stop_midway_ends_the_stream_there():
    stop = threading.Event()
    source = RebasedSource(FakeSource([0, 100, 200, 300]), stop=stop)
    seen = []
    for frame in source.frames():
        seen.append(frame.t_ms)
        if len(seen) == 2:
            stop.set()
    assert seen == [0, 100]


def test_an_empty_source_yields_nothing():
    assert list(RebasedSource(FakeSource([])).frames()) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_rebase.py -q'
```

Expected: FAIL — `ModuleNotFoundError: No module named 'adas.rebase'`.

- [ ] **Step 3: Implement `RebasedSource`**

Create `rdk/vision/adas/rebase.py`:

```python
"""Ride-relative frame timestamps, and an end to the stream.

``run_camera`` picks a segment with ``frame.t_ms / 1000 / segment_seconds``,
which assumes t_ms starts near zero at ride start. ``FileSource`` satisfies that.
A live camera does not: frames carry the ROS header stamp, which is board uptime
— 2,992,848 ms measured on 2026-07-27. Unrebased, every shadow record would cite
a segment index in the tens of thousands and ``tools/clip.py`` would find nothing.

Rebasing here rather than in ``MipiCamera`` keeps the camera reporting absolute
capture time, which is what every other consumer wants.

The stop event is the other half: ``MipiCamera.frames()`` runs until the camera
itself stops, so without it an ADAS thread would outlive the ride that started it.
"""

from __future__ import annotations

import threading
from dataclasses import replace
from typing import Iterator

from perception.frame_source import Frame


class RebasedSource:
    def __init__(self, source, stop: threading.Event | None = None) -> None:
        self.source = source
        self.stop = stop

    def frames(self) -> Iterator[Frame]:
        base: int | None = None
        for frame in self.source.frames():
            if self.stop is not None and self.stop.is_set():
                return
            if base is None:
                base = frame.t_ms
            yield replace(frame, t_ms=frame.t_ms - base)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_rebase.py -q'
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add rdk/vision/adas/rebase.py rdk/vision/tests/test_rebase.py
git commit -m "feat(adas): rebase live frame stamps to ride start"
```

---

### Task 3: `RideSession` — recording and ADAS as one unit

**Files:**

- Create: `rdk/vision/ride.py`
- Test: `rdk/vision/tests/test_ride.py`

**Interfaces:**

- Consumes: `RideRecorder`, `CameraSlot` from `recorder.session`; `write_jpeg` from `recorder.mipi_source`; `SEGMENT_SECONDS` from `recorder.segmenter`; `RuntimeConfig` from `adas.runtime`; `RebasedSource` from `adas.rebase` (Task 2); `start_adas` from `service`.
- Produces: `SEGMENT_PATTERN = "{camera}/seg-{index:06d}.mjpeg"`; `RideSession(cameras: dict[str, object], corpus_dir, min_free_mb: int, broadcast, detect_factory=None, fps: float = 10.0, free_mb=None)` with `start() -> str | None` and `stop() -> None`. After a successful `start()`: `ride_id: str`, `shadow_paths: dict[str, Path]` keyed by camera name, and `adas_threads: list[Thread]`.

Each camera object must provide `.channel`, `.jpeg()` and `.frames(fps)` — the `MipiCamera` surface.

- [ ] **Step 1: Write the failing tests**

Create `rdk/vision/tests/test_ride.py`:

```python
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.shadow import read_shadow
from perception.frame_source import Frame
from perception.types import Detection
from ride import SEGMENT_PATTERN, RideSession


class FakeCamera:
    """The MipiCamera surface RideSession uses: channel, jpeg(), frames()."""

    def __init__(self, channel=0, camera="front", count=40):
        self.channel = channel
        self.camera = camera
        self.count = count

    def jpeg(self):
        return b"\xff\xd8fake\xff\xd9"

    def frames(self, fps=10.0):
        for i in range(self.count):
            yield Frame(
                nv12=bytes(64 * 64 * 3 // 2),
                # Board uptime, not zero — the case the rebase exists for.
                t_ms=2_992_848 + i * 100,
                camera=self.camera,
                width=64,
                height=64,
            )


def approaching(frame, i):
    """A car filling more of the frame each tick, so a threat actually fires."""
    h = 0.10 + 0.03 * i
    return [Detection(cls="car", score=0.9, x1=0.4, y1=0.5 - h / 2, x2=0.6, y2=0.5 + h / 2)]


def make_session(tmp_path, cameras=None, min_free_mb=0, free_mb=None):
    return RideSession(
        cameras=cameras if cameras is not None else {"front": FakeCamera()},
        corpus_dir=tmp_path,
        min_free_mb=min_free_mb,
        broadcast=lambda payload: None,
        detect_factory=lambda: approaching,
        free_mb=free_mb,
    )


def test_a_ride_with_no_cameras_does_not_start():
    session = RideSession(
        cameras={}, corpus_dir="/tmp", min_free_mb=0, broadcast=lambda p: None,
        detect_factory=lambda: approaching,
    )
    assert session.start() is None


def test_start_returns_a_ride_id_and_makes_the_ride_directory(tmp_path):
    session = make_session(tmp_path)
    ride = session.start()
    try:
        assert ride is not None and ride.startswith("ride-")
        assert (Path(tmp_path) / ride).is_dir()
    finally:
        session.stop()


def test_the_recorder_writes_segments(tmp_path):
    session = make_session(tmp_path)
    ride = session.start()
    time.sleep(0.4)
    session.stop()
    written = list((Path(tmp_path) / ride / "front").glob("seg-*.mjpeg"))
    assert written, "the ride wrote no segment"


def test_the_segment_pattern_resolves_to_a_file_that_exists(tmp_path):
    # The defect this catches: RuntimeConfig's default pattern is
    # "{camera}_{index:06d}.h264" while the recorder writes seg-000000.mjpeg, so
    # every shadow record would cite a path that was never written.
    session = make_session(tmp_path)
    ride = session.start()
    time.sleep(0.4)
    session.stop()
    named = SEGMENT_PATTERN.format(camera="front", index=0)
    assert (Path(tmp_path) / ride / named).exists()


def test_alerts_land_in_the_shadow_log_citing_a_real_segment(tmp_path):
    session = make_session(tmp_path)
    ride = session.start()
    log = session.shadow_paths["front"]
    for _ in range(50):
        if log.exists() and read_shadow(log):
            break
        time.sleep(0.1)
    session.stop()

    records = read_shadow(log)
    assert records, "no alert reached the shadow log"
    assert (Path(tmp_path) / ride / records[0].segment).exists()


def test_each_camera_gets_its_own_shadow_log(tmp_path):
    # start_adas opens its own ShadowLog per call; two of them appending to one
    # file is a race with nothing to gain.
    session = make_session(
        tmp_path,
        cameras={"front": FakeCamera(camera="front"), "rear": FakeCamera(channel=2, camera="rear")},
    )
    session.start()
    session.stop()
    assert set(session.shadow_paths) == {"front", "rear"}
    assert session.shadow_paths["front"] != session.shadow_paths["rear"]


def test_a_hazard_is_broadcast(tmp_path):
    seen = []
    session = RideSession(
        cameras={"front": FakeCamera()},
        corpus_dir=tmp_path,
        min_free_mb=0,
        broadcast=seen.append,
        detect_factory=lambda: approaching,
    )
    session.start()
    for _ in range(50):
        if seen:
            break
        time.sleep(0.1)
    session.stop()
    assert seen and seen[0]["event"] == "hazard"


def test_a_ride_refuses_to_start_below_the_disk_floor(tmp_path):
    session = make_session(tmp_path, min_free_mb=1000, free_mb=lambda path: 10.0)
    assert session.start() is None


def test_stop_ends_the_adas_threads(tmp_path):
    # A camera that never runs out of frames: only the stop event can end this.
    class Endless(FakeCamera):
        def frames(self, fps=10.0):
            i = 0
            while True:
                yield Frame(
                    nv12=bytes(64 * 64 * 3 // 2), t_ms=2_992_848 + i * 100,
                    camera="front", width=64, height=64,
                )
                i += 1
                time.sleep(0.01)

    session = make_session(tmp_path, cameras={"front": Endless()})
    session.start()
    time.sleep(0.3)
    session.stop()
    assert all(not thread.is_alive() for thread in session.adas_threads)


def test_stop_is_safe_before_start(tmp_path):
    make_session(tmp_path).stop()
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_ride.py -q'
```

Expected: FAIL — `ModuleNotFoundError: No module named 'ride'`.

- [ ] **Step 3: Implement `RideSession`**

Create `rdk/vision/ride.py`:

```python
"""A ride: continuous segments and the shadow runtime, started as one thing.

M2 requires shadow mode to have evidence — ``run_camera`` refuses to start
without a recorder, because an unreviewable false-alarm rate is the measurement
that misleads. The obvious way to satisfy that, running ``tools/record_ride.py``
alongside, is impossible: the board permits exactly one holder of the ISP, so a
recorder process and the sidecar cannot both have the camera.

So the sidecar records. Binding the recorder and the ADAS threads into one
object means they start together and stop together, and the requirement holds by
construction rather than by a flag someone can set wrong.

Nothing here opens a camera. It is handed the ones CameraPair already opened.
"""

from __future__ import annotations

import shutil
import threading
import time
from pathlib import Path
from typing import Callable

from adas.rebase import RebasedSource
from adas.runtime import RuntimeConfig
from recorder.mipi_source import write_jpeg
from recorder.segmenter import SEGMENT_SECONDS
from recorder.session import CameraSlot, RideRecorder

#: Matches what RideRecorder writes: <ride>/<camera>/seg-NNNNNN.mjpeg. The
#: RuntimeConfig default ("{camera}_{index:06d}.h264") matches nothing.
SEGMENT_PATTERN = "{camera}/seg-{index:06d}.mjpeg"

#: Disk is checked every this many ticks rather than every frame — statvfs at
#: 10 Hz for the whole ride buys nothing.
DISK_CHECK_TICKS = 50


def _free_mb(path) -> float:
    return shutil.disk_usage(str(path)).free / (1024 * 1024)


def _bpu_detect_factory() -> Callable:
    """A detect callable backed by the BPU. Board-only: hobot_dnn lives there."""
    import os  # noqa: PLC0415

    from perception.detector import Detector  # noqa: PLC0415

    model = os.environ.get(
        "MAX_ADAS_MODEL",
        "/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/yolov5s_672x672_nv12.bin",
    )
    detector = Detector(model)

    def detect(frame, _index):
        return detector.infer(frame.nv12, frame.width, frame.height)

    return detect


class RideSession:
    def __init__(
        self,
        cameras: dict,
        corpus_dir,
        min_free_mb: int,
        broadcast: Callable[[dict], None],
        detect_factory: Callable[[], Callable] | None = None,
        fps: float = 10.0,
        free_mb: Callable[[object], float] | None = None,
    ) -> None:
        self.cameras = dict(cameras)
        self.corpus_dir = Path(corpus_dir)
        self.min_free_mb = min_free_mb
        self.broadcast = broadcast
        self.fps = fps
        self._detect_factory = detect_factory or _bpu_detect_factory
        self._free_mb = free_mb or _free_mb
        self.ride_id: str | None = None
        self.shadow_paths: dict[str, Path] = {}
        self.adas_threads: list[threading.Thread] = []
        self._recorder: RideRecorder | None = None
        self._stop = threading.Event()
        self._tick_thread: threading.Thread | None = None

    def start(self) -> str | None:
        """Begin a ride. Returns its id, or None if one must not start."""
        if not self.cameras:
            print("[ride] no camera open; not starting a ride", flush=True)
            return None

        self.corpus_dir.mkdir(parents=True, exist_ok=True)
        if self._free_mb(self.corpus_dir) < self.min_free_mb:
            print(
                f"[ride] refusing to start: free space below {self.min_free_mb} MB",
                flush=True,
            )
            return None

        self._stop = threading.Event()
        self._recorder = RideRecorder(
            root=self.corpus_dir,
            slots=[CameraSlot(name, camera.channel) for name, camera in self.cameras.items()],
            # The cameras are already open. Handing them back is what keeps this
            # process the only holder of the ISP.
            open_fn=lambda slot: self.cameras[slot.name],
            encode_fn=write_jpeg,
            video_suffix=".mjpeg",
        )
        self.ride_id = self._recorder.start(now_wall_ms=int(time.time() * 1000))
        print(f"[ride] {self.ride_id}: {', '.join(self.cameras)}", flush=True)

        self._tick_thread = threading.Thread(
            target=self._record_loop, name=f"record-{self.ride_id}", daemon=True
        )
        self._tick_thread.start()
        self._start_adas_threads()
        return self.ride_id

    def _start_adas_threads(self) -> None:
        from service import start_adas  # noqa: PLC0415 - service imports this module

        assert self.ride_id is not None
        ride_dir = self.corpus_dir / self.ride_id
        for name, camera in self.cameras.items():
            # One shadow file per camera: start_adas opens its own ShadowLog, and
            # two of them appending to one file is a race nobody needs.
            shadow_path = ride_dir / f"shadow-{name}.jsonl"
            self.shadow_paths[name] = shadow_path

            config = RuntimeConfig(
                ride_id=self.ride_id,
                camera=name,
                recording=True,
                detect=self._detect_factory(),
                segment_pattern=SEGMENT_PATTERN,
                # Must match the Segmenter the recorder uses, or the shadow
                # record's segment index drifts away from the files on disk.
                segment_seconds=SEGMENT_SECONDS,
            )

            def source_factory(cam=camera):
                return RebasedSource(cam.frames(self.fps), stop=self._stop)

            self.adas_threads.append(
                start_adas(config, shadow_path, self.broadcast, source_factory)
            )

    def _record_loop(self) -> None:
        interval = 1.0 / self.fps
        next_at = time.monotonic() + interval
        ticks = 0
        while not self._stop.wait(max(0.0, next_at - time.monotonic())):
            assert self._recorder is not None
            try:
                self._recorder.tick(time.monotonic(), int(time.time() * 1000))
            except Exception as error:  # noqa: BLE001 - a ride ending is not a crash
                print(f"[ride] recording stopped: {error}", flush=True)
                return

            ticks += 1
            if ticks % DISK_CHECK_TICKS == 0 and self._free_mb(self.corpus_dir) < self.min_free_mb:
                # No alerts whose evidence cannot be written. Stopping from
                # another thread so this one can exit its own join.
                print("[ride] free space exhausted; stopping the ride", flush=True)
                threading.Thread(target=self.stop, daemon=True).start()
                return

            next_at += interval
            if next_at < time.monotonic():
                next_at = time.monotonic() + interval

    def stop(self) -> None:
        self._stop.set()
        if self._tick_thread is not None:
            self._tick_thread.join(timeout=3.0)
            self._tick_thread = None
        for thread in self.adas_threads:
            thread.join(timeout=5.0)
        self.adas_threads = []
        if self._recorder is not None:
            self._recorder.stop()
            self._recorder = None
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/test_ride.py -q'
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Run the full suite**

```bash
ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add rdk/vision/ride.py rdk/vision/tests/test_ride.py
git commit -m "feat(adas): a ride starts recording and the shadow runtime together"
```

---

### Task 4: Wire the ride into the service

**Files:**

- Modify: `rdk/vision/service.py`
- Modify: `rdk/README.md`

**Interfaces:**

- Consumes: `RideSession` (Task 3), `EventBus` (Task 1).
- Produces: `MAX_ADAS_SHADOW`, `MAX_CORPUS_DIR` environment variables.

- [ ] **Step 1: Read the new configuration**

In `rdk/vision/service.py`, next to the other environment reads:

```python
CORPUS_DIR = os.environ.get("MAX_CORPUS_DIR", "/var/lib/max/corpus")
#: Only the exact string "1" enables shadow mode, matching MAX_RELAY_INSECURE_TLS.
ADAS_SHADOW = os.environ.get("MAX_ADAS_SHADOW", "0") == "1"
```

- [ ] **Step 2: Start the ride after the cameras open**

In `main()`, after the preview thread starts and before the signal handler:

```python
    ride = None
    if ADAS_SHADOW:
        # Imported here, not at module scope: ride.py imports start_adas from
        # this module, and a top-level import would be circular.
        from ride import RideSession  # noqa: PLC0415

        open_cameras = {
            name: camera
            for name, camera in (("front", cameras.front), ("rear", cameras.rear))
            if camera is not None
        }
        ride = RideSession(
            cameras=open_cameras,
            corpus_dir=CORPUS_DIR,
            min_free_mb=MIN_FREE_MB,
            broadcast=events.broadcast,
        )
        if ride.start() is None:
            ride = None
    else:
        print("[vision] MAX_ADAS_SHADOW is not 1; no ride, no ADAS", flush=True)
```

- [ ] **Step 3: Stop the ride before the cameras**

In the `finally` block of `main()`, ahead of the camera stops:

```python
        finally:
            # Ride first: its threads read from the cameras, so stopping the
            # cameras out from under them would raise on the way down.
            if ride is not None:
                ride.stop()
            for camera in (cameras.front, cameras.rear):
                if camera is not None:
                    camera.stop()
```

- [ ] **Step 4: Run the full suite**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'
```

Expected: PASS.

- [ ] **Step 5: Document the variables**

In `rdk/README.md`, add to the `/etc/max/agent.env` heredoc after `RDK_CAMERA_REAR=2`:

```bash
MAX_ADAS_SHADOW=0                          # 1 starts a ride: segments + shadow ADAS
MAX_CORPUS_DIR=/var/lib/max/corpus         # where ride segments are written
```

And add a subsection to the ADAS part of the README, after the `--source` table:

```markdown
### Shadow mode in the sidecar

`MAX_ADAS_SHADOW=1` makes max-vision start a **ride** at service start: it writes
continuous `.mjpeg` segments under `MAX_CORPUS_DIR` and runs one shadow-mode ADAS
thread per open camera. Alerts go to `<ride>/shadow-<camera>.jsonl` and are pushed
to any connected control-socket client as `event: hazard`.

Recording and ADAS start together on purpose. Shadow mode without evidence is the
measurement that misleads, so the runtime refuses to run without a recorder — and
since the board allows exactly one holder of the ISP, `tools/record_ride.py`
cannot supply that while the sidecar has the camera. The sidecar records instead.

**This makes no sound.** `MAX_ADAS_AUDIO` is untouched and still defaults to `0`;
arming remains a human decision against shadow numbers meeting the M1 gate.

Segments are large — roughly 3 MB/s at 1080p, so about 5 GB for a half-hour ride.
The ride refuses to start, and stops itself, below `MAX_GALLERY_MIN_FREE_MB` free.
```

- [ ] **Step 6: Commit**

```bash
git add rdk/vision/service.py rdk/README.md
git commit -m "feat(vision): start a shadow ride when MAX_ADAS_SHADOW=1"
```

---

### Task 5: Verify on the board

Unit tests prove the wiring; only the board proves the BPU, the frame rate and the thermals.

**Files:**

- Modify: `rdk/README.md`

- [ ] **Step 1: Enable shadow mode and restart**

```bash
ssh root@$BOARD 'grep -q MAX_ADAS_SHADOW /etc/max/agent.env || printf "MAX_ADAS_SHADOW=1\nMAX_CORPUS_DIR=/var/lib/max/corpus\n" >> /etc/max/agent.env
sed -i "s/^MAX_ADAS_SHADOW=.*/MAX_ADAS_SHADOW=1/" /etc/max/agent.env
systemctl restart max-vision && sleep 20
journalctl -u max-vision -n 30 --no-pager | grep -E "\[vision\]|\[ride\]|\[adas\]|\[recorder\]"'
```

Expected: `[vision] front: OV5647 on channel 0` then `[ride] ride-YYYYMMDD-HHMMSS: front`.

- [ ] **Step 2: Confirm segments accumulate**

```bash
ssh root@$BOARD 'sleep 30; RIDE=$(ls -t /var/lib/max/corpus | head -1); echo "ride: $RIDE"
ls -l /var/lib/max/corpus/$RIDE/front/ | head -5
du -sh /var/lib/max/corpus/$RIDE'
```

Expected: `seg-000000.mjpeg` growing, plus a `seg-000000.jsonl` of frame metadata.

- [ ] **Step 3: Confirm a hazard reaches a socket client**

```bash
ssh root@$BOARD 'timeout 60 python3 -c "
import socket
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(\"/run/max/vision.sock\")
s.settimeout(55)
try:
    while True:
        data = s.recv(4096)
        if not data:
            break
        print(data.decode().strip())
except socket.timeout:
    print(\"(no event in 55 s)\")
"'
```

Expected: at least one `{"event": "hazard", ...}` line if anything car-shaped is in frame. **If nothing appears, that is not automatically a failure** — point the camera at a vehicle or a picture of one before concluding the path is broken. Check `shadow-front.jsonl` in the same window to tell "no detections" from "detections not delivered".

- [ ] **Step 4: Confirm the shadow log cites a file that exists**

```bash
ssh root@$BOARD 'RIDE=$(ls -t /var/lib/max/corpus | head -1)
python3 -c "
import json, pathlib, sys
ride = pathlib.Path(\"/var/lib/max/corpus/$RIDE\")
log = ride / \"shadow-front.jsonl\"
if not log.exists():
    print(\"no shadow log yet\"); sys.exit(0)
rows = [json.loads(l) for l in log.read_text().splitlines() if l.strip()]
print(f\"{len(rows)} shadow records\")
for row in rows[:5]:
    target = ride / row[\"segment\"]
    print(row[\"segment\"], \"EXISTS\" if target.exists() else \"MISSING\")
"'
```

Expected: every cited segment `EXISTS`. A `MISSING` means the pattern or the rebase is wrong — stop and fix before going further.

- [ ] **Step 5: Measure frame rate and temperature**

```bash
ssh root@$BOARD 'for i in 1 2 3 4 5 6; do
  printf "temp %s C  " "$(awk "{print \$1/1000}" /sys/class/thermal/thermal_zone0/temp)"
  printf "load %s\n" "$(cut -d" " -f1-3 /proc/loadavg)"
  sleep 10
done
RIDE=$(ls -t /var/lib/max/corpus | head -1)
python3 -c "
import pathlib
seg = sorted(pathlib.Path(\"/var/lib/max/corpus/$RIDE/front\").glob(\"seg-*.mjpeg\"))[0]
print(\"frames in first segment:\", seg.read_bytes().count(b\"\xff\xd8\xff\"))
"'
```

Record both numbers. M1 measured 52.4 ms/frame and a ~90 °C plateau under two-camera load; ADAS plus a segment stream is a load nobody has run, so this is a measurement, not a confirmation. **If the plateau exceeds ~95 °C or the frame count is far below 10 fps × segment seconds, stop and report rather than pressing on.**

- [ ] **Step 6: Turn shadow mode back off and clean up**

```bash
ssh root@$BOARD 'sed -i "s/^MAX_ADAS_SHADOW=.*/MAX_ADAS_SHADOW=0/" /etc/max/agent.env
systemctl restart max-vision && sleep 15
journalctl -u max-vision -n 10 --no-pager | grep -E "\[vision\]|\[ride\]"
du -sh /var/lib/max/corpus/* 2>/dev/null | tail -3'
```

Leaving it on would fill the disk unattended. Delete the test rides once their numbers are recorded.

- [ ] **Step 7: Record the results**

Add to the bench-findings table in `rdk/README.md`, with the real measured values:

```markdown
| ADAS shadow ride | **works** — segments + shadow log + hazard on the socket | 2026-07-27 |
| Thermal under shadow ride | **NN.N °C** plateau over 60 s, one camera, shadow ADAS + segments | 2026-07-27 |
| Shadow ride frame rate | **N.N fps** measured (frames in the first segment / segment seconds) | 2026-07-27 |
```

Put the numbers Step 5 actually printed in place of `NN.N` and `N.N`. A row
recording that a measurement happened, without the measurement, is worth less
than no row.

Replace the `ADAS in the sidecar | **not wired**` row added by the previous plan
— it is no longer true.

- [ ] **Step 8: Run the full suite one last time**

```bash
ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q | tail -3'
```

Expected: PASS. Report the count; it should have grown by roughly 22.

- [ ] **Step 9: Commit**

```bash
git add rdk/README.md
git commit -m "docs(adas): record the shadow ride working on the board"
```

---

## Notes for the implementer

- **`ride.py` imports `start_adas` from `service.py`, and `service.py` imports `RideSession` from `ride.py`.** Both imports are inside functions for that reason. Moving either to module scope makes the import circular.
- **Never open a camera in `RideSession`.** It is handed the ones `CameraPair.open()` opened. A second opener fails with `The detected sensors are 1 less than expected`, which points at the wrong layer entirely.
- **If a test needs the BPU to pass, the design is wrong.** Inject `detect_factory`, as the tests do.
- **`MAX_ADAS_AUDIO` is not part of this work.** If you find yourself editing anything that plays a sound, stop.
