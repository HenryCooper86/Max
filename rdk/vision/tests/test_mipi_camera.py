import signal
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mipi_camera import FrameBuffer, MipiCamera, _signal_group, reap_orphans


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
