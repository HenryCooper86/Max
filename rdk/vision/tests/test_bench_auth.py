"""Who may reach the sidecar's HTTP surface.

The bench server binds 0.0.0.0 and the sidecar runs as root. Before this, the
``MAX_VISION_SHARE`` consent gate covered exactly one route (``/frame/*``),
while ``/preview/*`` streamed the live helmet camera to anyone on the network,
``/gallery/*`` served every recorded clip, and ``POST /gallery/<id>/delete``
destroyed captures — none of it authenticated. On a phone tether or a cafe
network that is the rider's camera, not a bench instrument.
"""

import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from bench_server import authorized, peer_is_local, serve
from camera import CameraPair
from gallery import Gallery

TOKEN = "s3cret-bench-token"
PHOTO = b"\xff\xd8\xff photo \xff\xd9"


class FakeCamera:
    def jpeg(self, max_age_ms=None):
        return b"\xff\xd8fake-jpeg\xff\xd9"

    def stop(self):
        pass


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def lan_ipv4() -> str | None:
    """A non-loopback IPv4 of this machine, so a request can arrive as a peer
    the sidecar must actually authenticate."""
    for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
        address = info[4][0]
        if not address.startswith("127."):
            return address
    return None


def make_photo(gallery, pair_id="pair-20260727-100000"):
    directory = gallery.pair_dir(pair_id)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.jpg").write_bytes(PHOTO)
    gallery.write_manifest(pair_id, "front.jpg", None, "photo")
    return pair_id


def running(tmp_path, token=TOKEN, share=True):
    port = free_port()
    pair = CameraPair(front_channel=0, rear_channel=2)
    pair.front = FakeCamera()
    gallery = Gallery(str(tmp_path), min_free_mb=0)
    threading.Thread(
        target=serve,
        args=(pair, gallery, port),
        kwargs={"share_frames": share, "token": token},
        daemon=True,
    ).start()
    time.sleep(0.5)
    return port, gallery


def status(url: str, method="GET") -> int:
    request = urllib.request.Request(url, method=method)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


# --- the decision itself -----------------------------------------------------


def test_loopback_is_local():
    assert peer_is_local("127.0.0.1")
    assert peer_is_local("127.0.0.53")
    assert peer_is_local("::1")


def test_an_ipv4_mapped_loopback_peer_is_still_local():
    # A dual-stack listener reports v4 peers this way; missing it would make
    # the agent's own camera.look fetch look like a stranger.
    assert peer_is_local("::ffff:127.0.0.1")


def test_a_lan_peer_is_not_local():
    assert not peer_is_local("192.168.50.9")
    assert not peer_is_local("10.42.0.11")
    assert not peer_is_local("nonsense")


def test_the_board_talking_to_itself_needs_no_token():
    # camera.look fetches /frame/front over 127.0.0.1 on every "看看前面".
    assert authorized("127.0.0.1", "", TOKEN)


def test_a_lan_peer_needs_the_right_token():
    assert authorized("192.168.50.9", f"t={TOKEN}", TOKEN)
    assert not authorized("192.168.50.9", "", TOKEN)
    assert not authorized("192.168.50.9", "t=wrong", TOKEN)


def test_no_configured_token_refuses_every_off_box_peer():
    # Fail closed: forgetting the env var must not publish the helmet camera.
    assert not authorized("192.168.50.9", "t=anything", "")
    assert not authorized("192.168.50.9", "", "")
    assert authorized("127.0.0.1", "", "")


# --- the routes --------------------------------------------------------------


def test_loopback_still_reaches_the_gallery_without_a_token(tmp_path):
    port, gallery = running(tmp_path)
    make_photo(gallery)
    assert status(f"http://127.0.0.1:{port}/gallery") == 200


def test_preview_is_refused_when_sharing_is_off(tmp_path):
    port, _ = running(tmp_path, share=False)
    # Same consent rule /frame already obeyed: with sharing off, no image
    # leaves the board at all — a LAN MJPEG stream is an image leaving.
    assert status(f"http://127.0.0.1:{port}/preview/front") == 403


@pytest.mark.parametrize(
    "path",
    ["/gallery", "/preview/front", "/frame/front", "/gallery/pair-20260727-100000/front.jpg"],
)
def test_a_lan_peer_without_a_token_is_refused(tmp_path, path):
    address = lan_ipv4()
    if address is None:
        pytest.skip("no non-loopback IPv4 on this host")
    port, gallery = running(tmp_path)
    make_photo(gallery)
    assert status(f"http://{address}:{port}{path}") == 401


def body_of(url: str) -> str:
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            return response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.read().decode("utf-8", "replace")


def test_a_refused_peer_is_told_how_to_get_in(tmp_path):
    address = lan_ipv4()
    if address is None:
        pytest.skip("no non-loopback IPv4 on this host")
    port, _ = running(tmp_path)
    text = body_of(f"http://{address}:{port}/gallery")
    # A bare "bench token required" is true and useless: the person reading it
    # is in a browser with no other clue what to do.
    assert "?t=" in text
    assert "MAX_VISION_TOKEN" in text
    assert "ssh -N -L 8080:127.0.0.1:8080" in text
    # Never the answer itself.
    assert TOKEN not in text


def test_a_lan_peer_with_the_token_is_served(tmp_path):
    address = lan_ipv4()
    if address is None:
        pytest.skip("no non-loopback IPv4 on this host")
    port, gallery = running(tmp_path)
    make_photo(gallery)
    assert status(f"http://{address}:{port}/gallery?t={TOKEN}") == 200


def test_a_lan_delete_without_a_token_refuses_and_keeps_the_capture(tmp_path):
    address = lan_ipv4()
    if address is None:
        pytest.skip("no non-loopback IPv4 on this host")
    port, gallery = running(tmp_path)
    pair_id = make_photo(gallery)
    # No token, and no custom header either: exactly the cross-origin POST any
    # page the rider visits on this network could make.
    assert status(f"http://{address}:{port}/gallery/{pair_id}/delete", method="POST") == 401
    assert gallery.pair_dir(pair_id).exists()
