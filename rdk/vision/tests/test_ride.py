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
        cameras={},
        corpus_dir="/tmp",
        min_free_mb=0,
        broadcast=lambda p: None,
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
        cameras={
            "front": FakeCamera(camera="front"),
            "rear": FakeCamera(channel=2, camera="rear"),
        },
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
                    nv12=bytes(64 * 64 * 3 // 2),
                    t_ms=2_992_848 + i * 100,
                    camera="front",
                    width=64,
                    height=64,
                )
                i += 1
                time.sleep(0.01)

    session = make_session(tmp_path, cameras={"front": Endless()})
    session.start()
    # Captured before stop(), which clears the list — asserting over the emptied
    # list would pass vacuously and prove nothing.
    threads = list(session.adas_threads)
    time.sleep(0.3)
    session.stop()
    assert threads, "no ADAS thread was started"
    assert all(not thread.is_alive() for thread in threads)


def test_stop_is_safe_before_start(tmp_path):
    make_session(tmp_path).stop()
