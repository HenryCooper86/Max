"""The bench-facing HTTP surface: camera preview and the capture gallery.

Served by the sidecar rather than the agent, because image bytes must never pass
through the process that owns the voice path — the same reason the preview has
always lived here rather than on the control socket.

Everything here exists for the dev HUD, which the rider cannot see.

**Threaded, and that is load-bearing.** An MJPEG handler never returns, and the
HUD opens two preview <img> tags at once. Single-threaded, the first connection
owned the server for its whole life: the second panel stayed blank forever and
the listen backlog filled with clients nobody would accept.
"""

from __future__ import annotations

import hmac
import ipaddress
import json
import shutil
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from camera import RECORDING_FPS
from mipi_camera import JPEG_MAX_AGE_MS

#: JPEG start-of-image. A .mjpeg segment is these, concatenated.
SOI = b"\xff\xd8\xff"

#: How much of a segment to pull in at a time. A 1080p q85 frame measured
#: ~330 KB on the board, so one chunk almost always holds the first frame.
SEGMENT_CHUNK = 1024 * 1024
#: Hard ceiling on a thumbnail slice. Without one, a segment holding no second
#: SOI would be read whole — and a real clip on the board reached 835 MB, more
#: RAM than an X5 has to give a thumbnail.
THUMB_MAX_BYTES = 16 * 1024 * 1024

#: Longest edge of a shared frame. Enough for a model to describe a scene and
#: cheap to upload from a board that usually lives on a phone tether.
DEFAULT_FRAME_WIDTH = 640
MAX_FRAME_WIDTH = 1920

#: Playback pacing ceiling. Beyond this every frame is on the wire for a
#: blink, and the board streams work nobody can see.
MAX_PLAY_FPS = 30
#: Fastest speed multiplier the viewer may ask for.
MAX_PLAY_SPEED = 4.0


def stamped_fps(target: Path) -> float:
    """The rate the clip's writer actually achieved, from its manifest.

    Pacing playback at the nominal RECORDING_FPS lied about time: the measured
    pair-20260801-000444-2 wrote 1820 frames over 498.5 s — 3.65 fps — and the
    nominal 10 compressed that 8.3-minute ride into a 3-minute timelapse the
    rider read as "I recorded 3 minutes, it says 8". Clips from before the
    stamp existed (and reconciled ones) fall back to the nominal rate — the
    only honest guess left.
    """
    try:
        manifest = json.loads((target.parent / "manifest.json").read_text(encoding="utf-8"))
        fps = float(manifest.get("fps"))
    except (OSError, TypeError, ValueError):
        return float(RECORDING_FPS)
    return fps if fps > 0 else float(RECORDING_FPS)


def first_frame(data: bytes) -> bytes | None:
    """The first JPEG in a concatenated-JPEG segment.

    This is what gives a recording a thumbnail without transcoding, on a board
    that plateaus near 94 °C with a ride running.
    """
    if not data.startswith(SOI):
        return None
    nxt = data.find(SOI, len(SOI))
    return data if nxt == -1 else data[:nxt]


def read_first_frame(path: Path) -> bytes | None:
    """The first JPEG of a segment, without reading the segment whole.

    ``first_frame`` needs bytes in hand; handing it a whole file is what made a
    thumbnail cost the size of the clip. A ride segment measured 835 MB on the
    board, so this walks the file a chunk at a time and stops at frame two.
    """
    try:
        with path.open("rb") as handle:
            buffer = handle.read(SEGMENT_CHUNK)
            if not buffer.startswith(SOI):
                return None
            while True:
                nxt = buffer.find(SOI, len(SOI))
                if nxt != -1:
                    return buffer[:nxt]
                if len(buffer) >= THUMB_MAX_BYTES:
                    return buffer[:THUMB_MAX_BYTES]
                more = handle.read(SEGMENT_CHUNK)
                if not more:
                    return buffer  # a single-frame file is its own first frame
                buffer += more
    except OSError:
        return None


def iter_frames(path: Path):
    """Each JPEG in a concatenated-JPEG segment, one frame in RAM at a time.

    The playback twin of ``read_first_frame``: same chunked walk, same
    ceiling, for the same reason — a clip on the board reached 835 MB.
    """
    buffer = b""
    try:
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(SEGMENT_CHUNK)
                if not chunk:
                    break
                buffer += chunk
                if not buffer.startswith(SOI):
                    return  # not a JPEG segment
                while True:
                    nxt = buffer.find(SOI, len(SOI))
                    if nxt == -1:
                        break
                    yield buffer[:nxt]
                    buffer = buffer[nxt:]
                if len(buffer) > THUMB_MAX_BYTES:
                    # No frame boundary within the ceiling means corrupt
                    # trailing data. Emit what there is and stop, rather than
                    # buffering the rest of the file hunting for one.
                    yield buffer[:THUMB_MAX_BYTES]
                    return
    except OSError:
        return
    if buffer.startswith(SOI):
        yield buffer  # the last frame has no marker after it


#: Ids minted before NTP steps the clock parse happily — to 2000-01-01, or to
#: a systemd build epoch in mid-2025 (this board has no RTC). Nothing in this
#: gallery predates 2026, so an earlier stamp is the boot clock, not a capture
#: time. A floor rather than an id-vs-mtime comparison, because copies reset
#: mtimes and the id must keep naming a copied capture truthfully.
ID_CLOCK_FLOOR = datetime(2026, 1, 1)


def created_at(pair_id: str, directory: Path) -> str | None:
    """When the capture happened, read from the pair id's own timestamp.

    The id is the primary source because it survives copies, and for a video
    it names the start rather than the stop. The manifest's mtime (the sort
    key, stamped after NTP has landed) stands in for ids that do not parse or
    that the boot clock stamped before ``ID_CLOCK_FLOOR`` — measured
    2026-08-01, when a clip recorded one minute after power-on was labelled
    01-01 08:01.
    """
    parts = pair_id.split("-")
    try:
        started = datetime.strptime("-".join(parts[1:3]), "%Y%m%d-%H%M%S")
    except ValueError:
        started = None
    if started is not None and started >= ID_CLOCK_FLOOR:
        return started.isoformat(timespec="seconds")
    for candidate in (directory / "manifest.json", directory):
        try:
            return datetime.fromtimestamp(candidate.stat().st_mtime).isoformat(timespec="seconds")
        except OSError:
            continue
    return None


def safe_path(root, relative: str):
    """Resolve ``relative`` inside ``root``, or return None.

    Load-bearing: this server binds 0.0.0.0 and the sidecar runs as root, so a
    path that escapes the gallery reads whatever root can read. The check is on
    the *resolved* result, not the spelling, so "..", absolute paths and encoded
    variants are all covered by one rule.
    """
    root = Path(root).resolve()
    try:
        candidate = (root / relative).resolve()
    except (OSError, ValueError, RuntimeError):
        return None
    if candidate == root or root not in candidate.parents:
        return None
    return candidate


#: Query parameter carrying the bench token.
#:
#: A parameter rather than a header because the HUD reaches ``/preview`` and
#: the gallery thumbnails through ``<img src>``, which cannot set one. The
#: cost is the token appearing in URLs; ``log_message`` below is already a
#: no-op, so it is not written to the journal.
TOKEN_PARAM = "t"


#: What a refused peer is told.
#:
#: "bench token required" alone is true and useless: whoever reads it is in a
#: browser address bar with no other clue, and the two ways in suit different
#: jobs. The query parameter is the ordinary bench look; the forward is exempt
#: from the token and is the only route that shows pairing codes, because
#: redaction keys off the peer address rather than the token. Kept word-for-word
#: in sync with hud/server.ts's REFUSAL_TEXT, so it does not matter which port
#: you hit first.
REFUSAL_TEXT = """Append the board's token to the URL:
  ?t=<MAX_VISION_TOKEN>

Or reach the board over an SSH local forward, which is exempt from the token
and is the only route that shows pairing codes:
  ssh -N -L 8080:127.0.0.1:8080 -L 8081:127.0.0.1:8081 root@<board>
  then open http://127.0.0.1:8080

Both ports must map to the same numbers: the HUD page asks the browser for
<host>:8081, so a forward on any other local port leaves its camera and
gallery panels dead. See rdk/README.md "Bench access - MAX_VISION_TOKEN"."""


def peer_is_local(address: str) -> bool:
    """Is this peer the board itself?

    IPv4-mapped IPv6 (``::ffff:127.0.0.1``) counts: a dual-stack listener
    reports v4 peers that way, and missing it would make the agent's own
    ``camera.look`` fetch look like a stranger.
    """
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    return ip.is_loopback


def authorized(peer: str, query: str, token: str) -> bool:
    """Whether a request from ``peer`` may be served.

    Loopback is exempt. The agent fetches ``/frame/front`` over 127.0.0.1 for
    every ``camera.look``, and a board talking to itself is not the exposure
    this guards — a stranger on the LAN is.

    With no token configured, nothing off-box is served at all. That is the
    fail-closed direction on purpose: the alternative is a helmet camera and a
    ride's worth of footage open to whatever network the bike is near, because
    someone forgot an env var. A dark HUD is a visible, fixable symptom.
    """
    if peer_is_local(peer):
        return True
    if not token:
        return False
    supplied = parse_qs(query).get(TOKEN_PARAM, [""])[0]
    # Constant-time: the token is short and an attacker can retry freely.
    return hmac.compare_digest(supplied, token)


def listing(gallery) -> dict:
    """Every capture, newest first, with the byte size of each side.

    Sizes let the page label a recording and mark a manifest whose file is not
    on disk, rather than rendering a broken image and leaving you to guess.
    """
    pairs = []
    for manifest in gallery.list_pairs():
        directory = gallery.pair_dir(manifest["id"])
        sizes: dict[str, int | None] = {}
        for side in ("front", "rear"):
            name = manifest.get(side)
            path = directory / name if name else None
            sizes[side] = path.stat().st_size if path is not None and path.exists() else None
        pairs.append(
            {**manifest, "sizes": sizes, "created": created_at(manifest["id"], directory)}
        )
    free_mb = shutil.disk_usage(gallery.root).free // (1024 * 1024)
    # The floor rides along so the page can say how close the disk is to
    # refusing the next capture, not just quote a number.
    return {"pairs": pairs, "disk": {"free_mb": free_mb, "min_free_mb": gallery.min_free_mb}}


def downscale(jpeg: bytes, width: int) -> bytes | None:
    """Re-encode a JPEG with its longest edge at ``width``. None if undecodable.

    Never upscales: enlarging invents detail the sensor did not capture, and the
    only thing that buys is a bigger upload.
    """
    import cv2  # noqa: PLC0415 - board-only
    import numpy as np  # noqa: PLC0415

    image = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return None

    height, source_width = image.shape[:2]
    longest = max(source_width, height)
    if longest > width:
        scale = width / longest
        image = cv2.resize(
            image,
            (max(1, round(source_width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    ok, buf = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
    return buf.tobytes() if ok else None


def serve(pair, gallery, port: int, share_frames: bool = False, token: str = "") -> None:
    """Serve preview and gallery on one port. Blocks forever."""

    class BenchHandler(BaseHTTPRequestHandler):
        def _allowed(self, query: str) -> bool:
            if authorized(self.client_address[0], query, token):
                return True
            # 401 rather than 404: that this port serves something is not the
            # secret — the frames and the gallery behind it are.
            self.send_error(401, "bench token required", REFUSAL_TEXT)
            return False

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            # Parsed once, and dispatched on the path alone: with a token in
            # the query string, `self.path` is "/gallery?t=…" and every
            # startswith/endswith/== against the raw path silently stops
            # matching.
            parsed = urlparse(self.path)
            if not self._allowed(parsed.query):
                return
            if parsed.path.startswith("/preview/"):
                self._preview(parsed)
            elif parsed.path == "/gallery":
                self._listing()
            elif parsed.path.startswith("/gallery/"):
                self._capture(parsed)
            elif parsed.path.startswith("/frame/"):
                self._frame(parsed)
            else:
                self.send_error(404)

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            parsed = urlparse(self.path)
            if not self._allowed(parsed.query):
                return
            if parsed.path.startswith("/gallery/") and parsed.path.endswith("/delete"):
                self._delete(unquote(parsed.path[len("/gallery/") : -len("/delete")]))
            else:
                self.send_error(404)

        def _json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            # The page lives on the agent's port, so every outcome here is a
            # cross-origin read — errors included, or the page could not tell
            # "still recording" apart from the sidecar being down.
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _delete(self, pair_id: str) -> None:
            try:
                outcome = gallery.delete_pair(pair_id)
            except OSError as error:
                # Reporting a delete that did not happen would be the same
                # class of lie as a false capture success.
                self._json(500, {"error": f"delete failed: {error}"})
                return
            if outcome == "deleted":
                self._json(200, {"deleted": pair_id})
            elif outcome == "recording":
                self._json(409, {"error": "still recording; stop the recording first"})
            else:
                self._json(404, {"error": "no such capture"})

        def _play(self, target: Path, query: str) -> None:
            """Replay a segment as the multipart stream the live preview uses.

            No transcoding on a board that plateaus near 90 °C with a ride
            running; the HUD's <img> plays this the way it already plays
            /preview/*. The stream simply ends with the file — a clip still
            being written plays what is on disk and stops.
            """
            params = parse_qs(query)
            raw_fps = params.get("fps", [None])[0]
            if raw_fps is not None:
                # An absolute override, for tools that want exact pacing.
                try:
                    fps = float(raw_fps)
                except ValueError:
                    self.send_error(400, "bad fps")
                    return
                if not 1 <= fps <= MAX_PLAY_FPS:
                    self.send_error(400, "fps out of range")
                    return
            else:
                # Default: the rate the writer achieved, times the viewer's
                # speed. Half/double relative to the clip's own rate — scaling
                # the nominal rate is exactly the lie the stamp exists to end.
                try:
                    speed = float(params.get("speed", ["1"])[0])
                except ValueError:
                    self.send_error(400, "bad speed")
                    return
                if not 0 < speed <= MAX_PLAY_SPEED:
                    self.send_error(400, "speed out of range")
                    return
                fps = min(stamped_fps(target) * speed, MAX_PLAY_FPS)

            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.end_headers()
            try:
                for frame in iter_frames(target):
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n\r\n")
                    self.wfile.write(frame)
                    self.wfile.write(b"\r\n")
                    time.sleep(1.0 / fps)
            except (BrokenPipeError, ConnectionResetError):
                return  # the viewer was closed mid-clip; ordinary

        def _capture(self, parsed) -> None:
            relative = unquote(parsed.path[len("/gallery/") :])
            thumb = relative.endswith("/thumb")
            play = relative.endswith("/play")
            if thumb:
                relative = relative[: -len("/thumb")]
            elif play:
                relative = relative[: -len("/play")]

            target = safe_path(gallery.root, relative)
            # 404 rather than 403 for a refused path: a distinct code would
            # confirm which files exist.
            if target is None or not target.is_file():
                self.send_error(404)
                return

            if play:
                # Only a segment has frames to pace; a photo is already
                # viewable inline.
                if target.suffix != ".mjpeg":
                    self.send_error(404)
                    return
                self._play(target, parsed.query)
                return

            if thumb:
                data = read_first_frame(target)
                if data is None:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return

            self.send_response(200)
            if target.suffix == ".jpg":
                self.send_header("Content-Type", "image/jpeg")
            else:
                # A .mjpeg is concatenated JPEG; no browser plays it inline, so
                # offering it as a download beats rendering a broken tile.
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header(
                    "Content-Disposition", f'attachment; filename="{target.name}"'
                )
            self.send_header("Content-Length", str(target.stat().st_size))
            self.end_headers()
            # Streamed, not read whole: a clip on the board reached 835 MB, and
            # buffering that to serve one download would be most of the board's
            # RAM for as long as the transfer lasts.
            try:
                with target.open("rb") as handle:
                    while True:
                        chunk = handle.read(SEGMENT_CHUNK)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                return  # the download was cancelled; ordinary

        def _listing(self) -> None:
            self._json(200, listing(gallery))

        def _preview(self, parsed) -> None:
            # The same consent rule /frame has always obeyed. A continuous
            # MJPEG stream of the helmet camera to a LAN peer is an image
            # leaving the board, so "sharing off means no image leaves" has to
            # cover it too — it is the larger leak of the two, not the smaller.
            if not share_frames:
                self.send_error(403, "frame sharing is off")
                return

            camera = pair.front if parsed.path.endswith("front") else pair.rear
            if camera is None:
                # Answer, rather than holding the connection open forever
                # writing nothing — which is what a blank panel used to mean,
                # and is indistinguishable from a broken server.
                self.send_response(503)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(b"camera not available\n")
                return

            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.end_headers()
            try:
                while True:
                    data = pair._grab(camera, max_age_ms=JPEG_MAX_AGE_MS)
                    if data is None:
                        time.sleep(0.5)
                        continue
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n\r\n")
                    self.wfile.write(data)
                    self.wfile.write(b"\r\n")
                    time.sleep(1 / 10)
            except (BrokenPipeError, ConnectionResetError):
                # The tab was closed. Ordinary, not worth a traceback in the
                # journal on every page reload.
                return

        def _frame(self, parsed) -> None:
            # Consent, not capability: with sharing off no image leaves the
            # board at all, whatever the relay is configured to do.
            if not share_frames:
                self.send_error(403, "frame sharing is off")
                return

            raw_width = parse_qs(parsed.query).get("w", [str(DEFAULT_FRAME_WIDTH)])[0]
            try:
                width = int(raw_width)
            except ValueError:
                self.send_error(400, "bad width")
                return
            if not 64 <= width <= MAX_FRAME_WIDTH:
                self.send_error(400, "width out of range")
                return

            camera = pair.front if parsed.path.endswith("front") else pair.rear
            data = pair._grab(camera, max_age_ms=JPEG_MAX_AGE_MS)
            if data is None:
                self.send_error(503, "camera not available")
                return

            shrunk = downscale(data, width)
            if shrunk is None:
                self.send_error(503, "frame not decodable")
                return

            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(shrunk)))
            self.end_headers()
            self.wfile.write(shrunk)

        def log_message(self, *args) -> None:
            return

    server = ThreadingHTTPServer(("0.0.0.0", port), BenchHandler)
    # A stream that never ends would otherwise keep the process alive on exit.
    server.daemon_threads = True
    server.serve_forever()
