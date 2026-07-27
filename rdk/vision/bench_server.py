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
from urllib.parse import unquote

#: JPEG start-of-image. A .mjpeg segment is these, concatenated.
SOI = b"\xff\xd8\xff"


def first_frame(data: bytes) -> bytes | None:
    """The first JPEG in a concatenated-JPEG segment.

    This is what gives a recording a thumbnail without transcoding, on a board
    that plateaus near 94 °C with a ride running.
    """
    if not data.startswith(SOI):
        return None
    nxt = data.find(SOI, len(SOI))
    return data if nxt == -1 else data[:nxt]


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


def serve(pair, gallery, port: int) -> None:
    """Serve preview and gallery on one port. Blocks forever."""

    class BenchHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if self.path.startswith("/preview/"):
                self._preview()
            elif self.path == "/gallery":
                self._listing()
            elif self.path.startswith("/gallery/"):
                self._capture()
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

            data = target.read_bytes()
            if thumb:
                data = first_frame(data)
                if data is None:
                    self.send_error(404)
                    return

            self.send_response(200)
            if thumb or target.suffix == ".jpg":
                self.send_header("Content-Type", "image/jpeg")
            else:
                # A .mjpeg is concatenated JPEG; no browser plays it inline, so
                # offering it as a download beats rendering a broken tile.
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header(
                    "Content-Disposition", f'attachment; filename="{target.name}"'
                )
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

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
                    data = pair._grab(camera)
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

        def log_message(self, *args) -> None:
            return

    server = ThreadingHTTPServer(("0.0.0.0", port), BenchHandler)
    # A stream that never ends would otherwise keep the process alive on exit.
    server.daemon_threads = True
    server.serve_forever()
