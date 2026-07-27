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
