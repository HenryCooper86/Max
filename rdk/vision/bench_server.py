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

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

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
        pairs.append({**manifest, "sizes": sizes})
    return {"pairs": pairs}


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


def serve(pair, gallery, port: int, share_frames: bool = False) -> None:
    """Serve preview and gallery on one port. Blocks forever."""

    class BenchHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if self.path.startswith("/preview/"):
                self._preview()
            elif self.path == "/gallery":
                self._listing()
            elif self.path.startswith("/gallery/"):
                self._capture()
            elif self.path.startswith("/frame/"):
                self._frame()
            else:
                self.send_error(404)

        def _capture(self) -> None:
            relative = unquote(self.path[len("/gallery/") :])
            thumb = relative.endswith("/thumb")
            if thumb:
                relative = relative[: -len("/thumb")]

            target = safe_path(gallery.root, relative)
            # 404 rather than 403 for a refused path: a distinct code would
            # confirm which files exist.
            if target is None or not target.is_file():
                self.send_error(404)
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
            body = json.dumps(listing(gallery), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            # The page is served from the agent's port and fetches this one, so
            # the JSON is a cross-origin read. Images in <img> are not.
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _preview(self) -> None:
            camera = pair.front if self.path.endswith("front") else pair.rear
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

        def _frame(self) -> None:
            # Consent, not capability: with sharing off no image leaves the
            # board at all, whatever the relay is configured to do.
            if not share_frames:
                self.send_error(403, "frame sharing is off")
                return

            parsed = urlparse(self.path)
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
