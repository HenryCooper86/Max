import signal
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mipi_camera import (
    FrameBuffer,
    MipiCamera,
    _signal_group,
    init_ros,
    launch_command,
    reap_orphans,
)


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


def test_reap_orphans_returns_empty_when_nothing_holds_the_isp():
    killed = []
    assert reap_orphans(
        holders=lambda: [], kill=lambda p, s: killed.append((p, s)), sleep=lambda s: None
    ) == []
    assert killed == []


def test_reap_orphans_terminates_every_holder():
    # The measured failure: an orphaned mipi_cam holding /dev/vs-isp0_* makes
    # every later open fail with a message about sensor detection.
    killed = []
    pids = reap_orphans(
        holders=lambda: [17363, 17400],
        kill=lambda p, s: killed.append((p, s)),
        sleep=lambda s: None,
    )
    assert pids == [17363, 17400]
    assert (17363, signal.SIGTERM) in killed
    assert (17400, signal.SIGTERM) in killed


def test_reap_orphans_escalates_to_sigkill_for_survivors():
    killed = []
    rounds = iter([[17363], [17363]])
    reap_orphans(
        holders=lambda: next(rounds),
        kill=lambda p, s: killed.append((p, s)),
        sleep=lambda s: None,
    )
    assert killed == [(17363, signal.SIGTERM), (17363, signal.SIGKILL)]


def test_reap_orphans_tolerates_a_process_that_already_exited():
    def kill(pid, sig):
        raise ProcessLookupError

    assert reap_orphans(holders=lambda: [1], kill=kill, sleep=lambda s: None) == [1]


class FakeProc:
    def __init__(self, pid=4242):
        self.pid = pid


def test_signal_group_signals_the_group_not_the_process():
    # ros2 run execs the real node as a child. Signalling only the wrapper
    # leaves that node holding the ISP, reparented to init — measured.
    sent = []
    _signal_group(
        FakeProc(),
        signal.SIGTERM,
        killpg=lambda pgid, sig: sent.append((pgid, sig)),
        getpgid=lambda pid: 999,
    )
    assert sent == [(999, signal.SIGTERM)]


def test_signal_group_tolerates_a_group_that_is_already_gone():
    def killpg(pgid, sig):
        raise ProcessLookupError

    _signal_group(FakeProc(), signal.SIGTERM, killpg=killpg, getpgid=lambda pid: 1)


def test_each_camera_gets_its_own_topic():
    # Two mipi_cam nodes sharing one /image_raw is the measured dual-camera
    # flicker: with two publishers on the topic (confirmed 2026-08-01, ~50 Hz
    # combined), every subscriber drinks both sensors' frames interleaved.
    front = MipiCamera(channel=0, sensor="OV5647", camera="front", width=4, height=2)
    rear = MipiCamera(channel=2, sensor="IMX219", camera="rear", width=4, height=2)
    assert front.topic == "/front/image_raw"
    assert rear.topic == "/rear/image_raw"
    assert front.topic != rear.topic


def test_launch_command_remaps_topic_and_node_per_camera():
    # The remap must ride the ros2 command line: the vendor node publishes a
    # hardcoded /image_raw, and two nodes also share the name "mipi_cam".
    # Verified against the real node: -r moves the topic and renames the node.
    cmd = launch_command(
        sensor="OV5647", channel=0, width=1920, height=1080,
        topic="/front/image_raw", node_name="mipi_cam_front",
    )
    text = " ".join(cmd)
    assert "-r /image_raw:=/front/image_raw" in text
    assert "-r __node:=mipi_cam_front" in text
    # The existing capture parameters must survive the change.
    assert "video_device:=OV5647" in text
    assert "channel:=0" in text
    assert "out_format:=nv12" in text


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


def test_age_is_none_before_any_frame():
    buffer = FrameBuffer("front", 4, 4, encode=lambda n, w, h: b"jpeg")
    assert buffer.age_seconds() is None


def test_age_measures_from_the_last_put():
    clock = iter([100.0, 103.5]).__next__
    buffer = FrameBuffer("front", 4, 4, encode=lambda n, w, h: b"jpeg", clock=clock)
    buffer.put(b"\x00" * 24, t_ms=0)
    assert buffer.age_seconds() == 3.5


def test_stale_jpeg_served_within_max_age():
    encodes = []
    times = iter([0.0, 0.0, 0.05, 0.05])  # put, encode-stamp, put, read
    buffer = FrameBuffer(
        "front", 4, 4,
        encode=lambda n, w, h: encodes.append(1) or b"jpeg",
        clock=lambda: next(times),
    )
    buffer.put(b"\x00" * 24, t_ms=0)
    assert buffer.jpeg(max_age_ms=100) == b"jpeg"
    buffer.put(b"\x01" * 24, t_ms=42)  # invalidates the exact cache
    # 50 ms later, still inside the window: the stale encode is served.
    assert buffer.jpeg(max_age_ms=100) == b"jpeg"
    assert len(encodes) == 1


def test_stale_jpeg_expires_past_max_age():
    encodes = []
    times = iter([0.0, 0.0, 0.5, 0.5, 0.5])
    buffer = FrameBuffer(
        "front", 4, 4,
        encode=lambda n, w, h: encodes.append(1) or b"jpeg",
        clock=lambda: next(times),
    )
    buffer.put(b"\x00" * 24, t_ms=0)
    assert buffer.jpeg(max_age_ms=100) == b"jpeg"
    buffer.put(b"\x01" * 24, t_ms=42)
    # 500 ms later: past the window, a fresh encode happens.
    assert buffer.jpeg(max_age_ms=100) == b"jpeg"
    assert len(encodes) == 2


def test_default_keeps_exact_frame_semantics():
    encodes = []
    buffer = FrameBuffer(
        "front", 4, 4,
        encode=lambda n, w, h: encodes.append(1) or b"jpeg",
        clock=lambda: 0.0,
    )
    buffer.put(b"\x00" * 24, t_ms=0)
    buffer.jpeg()
    buffer.put(b"\x01" * 24, t_ms=42)
    buffer.jpeg()  # no max_age_ms: must re-encode despite zero elapsed time
    assert len(encodes) == 2


class FakeRclpy:
    """The slice of rclpy that init_ros touches."""

    def __init__(self, running=False, reject_keyword=False):
        self.running = running
        self.reject_keyword = reject_keyword
        self.calls = []

    def ok(self):
        return self.running

    def init(self, **kwargs):
        if self.reject_keyword and kwargs:
            raise TypeError("init() got an unexpected keyword argument")
        self.calls.append(kwargs)
        self.running = True


class FakeSignalOptions:
    NO = "NO"
    ALL = "ALL"


def test_ros_init_asks_rclpy_not_to_take_the_signal_handlers():
    """rclpy.init() installs its own SIGTERM handler by default.

    That is what made `systemctl stop max-vision` during camera acquisition
    look like a crash: our handler was replaced, rclpy shut its context down
    instead of exiting, the mipi_cam children died with the cgroup, and the
    open then failed its way to require_cameras' exit 1 — a deliberate stop
    reported as a failure.
    """
    rclpy = FakeRclpy()
    init_ros(rclpy, signal_options=FakeSignalOptions)
    assert rclpy.calls == [{"signal_handler_options": "NO"}]


def test_ros_init_leaves_a_running_context_alone():
    # The second camera must not re-init: "Context.init() must only be called
    # once" is what the rear camera reported once the front one had already
    # brought the context up.
    rclpy = FakeRclpy(running=True)
    init_ros(rclpy, signal_options=FakeSignalOptions)
    assert rclpy.calls == []


def test_ros_init_falls_back_when_the_option_does_not_exist():
    # Older rclpy has no SignalHandlerOptions. Starting with the pre-existing
    # behaviour beats refusing to open the cameras at all.
    rclpy = FakeRclpy()
    init_ros(rclpy, signal_options=None)
    assert rclpy.calls == [{}]


def test_ros_init_falls_back_when_rclpy_rejects_the_keyword():
    rclpy = FakeRclpy(reject_keyword=True)
    init_ros(rclpy, signal_options=FakeSignalOptions)
    assert rclpy.calls == [{}]
