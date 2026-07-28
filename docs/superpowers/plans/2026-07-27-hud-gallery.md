# HUD Gallery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a read-only grid of captures in the bench HUD, so a photo Max reports taking can actually be looked at.

**Architecture:** The vision sidecar grows a `bench_server.py` that serves both the existing MJPEG preview and three new gallery routes on the same port; the agent keeps serving only the page. The HUD polls the listing every 3 s and re-renders only on change.

**Tech Stack:** Python 3.10 (`http.server`, no new dependencies), plain HTML/JS in the agent's `index.html`, pytest 6.2.5.

**Spec:** `docs/superpowers/specs/2026-07-27-hud-gallery-design.md`

## Global Constraints

- **The test suite runs on the board.** `export BOARD=10.42.0.11` — network-dependent; find it with `arp -a`, narrow with `nc -G 2 -z <ip> 22`, confirm with `ssh root@<ip> 'ls /usr/hobot'`.
- **Deploy the sidecar:** `scp -r rdk/vision root@$BOARD:/opt/max/rdk/`, then `systemctl restart max-vision`.
- **Deploy the page:** `scp -r rdk/agent root@$BOARD:/opt/max/rdk/`, then `systemctl restart max-agent`. The agent runs from source via `tsx` and reads `index.html` at startup, so there is no build step. **Restarting max-agent drops any live voice session** — do it deliberately, not in a loop.
- **No new Python dependencies.** `http.server`, `json`, `mimetypes`, `pathlib` are all stdlib and all already on the board.
- **The server binds `0.0.0.0` and the sidecar runs as root.** Every path served must resolve inside the gallery root. This is the one requirement in this plan that is a security boundary rather than a nicety.
- **Read-only.** No route may delete, move or write anything.
- **House style:** module docstrings explain *why*. Tests use `sys.path.insert(0, str(Path(__file__).resolve().parents[1]))` and import modules directly.
- Work on branch `feat/hud-gallery` (already created; the spec is committed there).

### A correction to the spec

The spec says `test_preview.py` must pass "unchanged" as the guard on moving the
server out of `camera.py`. That is not literally achievable: the tests call
`pair.serve_preview(port)`, and after the move the entry point is
`bench_server.serve(pair, gallery, port)`.

What the guard actually means, and what Task 1 enforces: **every assertion stays
byte-identical**, and only the two lines that construct and invoke the server
change. If any assertion needs touching, the move changed behaviour and must be
reworked rather than accommodated.

---

### Task 1: Move the preview server into `bench_server.py`

Pure extraction. No behaviour changes, so the existing preview tests are the proof.

**Files:**
- Create: `rdk/vision/bench_server.py`
- Modify: `rdk/vision/camera.py` (remove `serve_preview`)
- Modify: `rdk/vision/service.py`
- Test: `rdk/vision/tests/test_preview.py` (call site only)

**Interfaces:**
- Consumes: `CameraPair` (`.front`, `.rear`, `._grab`), `Gallery`.
- Produces: `serve(pair, gallery, port) -> None`, which blocks forever.

- [ ] **Step 1: Create the module with the preview routes**

Create `rdk/vision/bench_server.py`, moving the body of `serve_preview` verbatim:

```python
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

import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def serve(pair, gallery, port: int) -> None:
    """Serve preview and gallery on one port. Blocks forever."""

    class BenchHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            self._preview()

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
```

- [ ] **Step 2: Delete `serve_preview` from `camera.py`**

Remove the entire `serve_preview` method. Then remove the now-unused import,
changing:

```python
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
```

to nothing — delete that line. Leave `import time`; recording still uses it.

- [ ] **Step 3: Point the service at the new module**

In `rdk/vision/service.py`, change the preview thread:

```python
    from bench_server import serve as serve_bench  # noqa: PLC0415

    threading.Thread(
        target=serve_bench, args=(cameras, gallery, PREVIEW_PORT), daemon=True
    ).start()
```

Replacing the existing `threading.Thread(target=cameras.serve_preview, ...)` line.

- [ ] **Step 4: Update only the call site in the preview tests**

In `rdk/vision/tests/test_preview.py`, add the imports:

```python
from bench_server import serve
from gallery import Gallery
```

and change the `serve` helper's thread target — note the local function is
renamed to `start_server` so it does not shadow the imported `serve`:

```python
def start_server(pair, tmp_path) -> int:
    port = free_port()
    gallery = Gallery(str(tmp_path), min_free_mb=0)
    threading.Thread(target=serve, args=(pair, gallery, port), daemon=True).start()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return port
        except OSError:
            time.sleep(0.05)
    raise AssertionError("preview server never started listening")
```

Then update the four tests to take `tmp_path` and call `start_server(pair, tmp_path)`
instead of `serve(pair)`. **Change nothing else.** Every assertion stays as it is.

- [ ] **Step 5: Run the preview tests**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && timeout 180 python3 -m pytest tests/test_preview.py -q'
```

Expected: PASS, 4 tests. A failure here means the extraction changed behaviour — fix the extraction, not the test.

- [ ] **Step 6: Run the full suite**

```bash
ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'
```

Expected: PASS, 249.

- [ ] **Step 7: Commit**

```bash
git add rdk/vision/bench_server.py rdk/vision/camera.py rdk/vision/service.py rdk/vision/tests/test_preview.py
git commit -m "refactor(vision): move the bench HTTP surface out of camera.py"
```

---

### Task 2: The capture listing

**Files:**
- Modify: `rdk/vision/bench_server.py`
- Test: `rdk/vision/tests/test_bench_gallery.py`

**Interfaces:**
- Consumes: `Gallery.list_pairs()`, `Gallery.pair_dir(pair_id)`.
- Produces: `listing(gallery) -> dict` returning `{"pairs": [...]}`, each entry being the manifest plus `"sizes": {"front": int | None, "rear": int | None}`. Route `GET /gallery` returns it as JSON with `Access-Control-Allow-Origin: *`.

- [ ] **Step 1: Write the failing tests**

Create `rdk/vision/tests/test_bench_gallery.py`:

```python
import json
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from bench_server import listing, serve
from camera import CameraPair
from gallery import Gallery


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture()
def gallery(tmp_path):
    return Gallery(str(tmp_path), min_free_mb=0)


PHOTO = b"\xff\xd8\xff photo \xff\xd9"


def make_photo(gallery, pair_id: str, front=PHOTO, rear=None):
    directory = gallery.pair_dir(pair_id)
    directory.mkdir(parents=True, exist_ok=True)
    if front is not None:
        (directory / "front.jpg").write_bytes(front)
    if rear is not None:
        (directory / "rear.jpg").write_bytes(rear)
    gallery.write_manifest(
        pair_id, "front.jpg" if front else None, "rear.jpg" if rear else None, "photo"
    )


def test_listing_is_empty_when_nothing_was_captured(gallery):
    assert listing(gallery) == {"pairs": []}


def test_listing_reports_a_capture_with_its_size(gallery):
    make_photo(gallery, "pair-20260727-100000")
    payload = listing(gallery)
    assert len(payload["pairs"]) == 1
    entry = payload["pairs"][0]
    assert entry["id"] == "pair-20260727-100000"
    assert entry["front"] == "front.jpg"
    assert entry["sizes"]["front"] == len(PHOTO)
    assert entry["sizes"]["rear"] is None


def test_listing_is_newest_first(gallery):
    make_photo(gallery, "pair-20260727-100000")
    make_photo(gallery, "pair-20260727-110000")
    assert [p["id"] for p in listing(gallery)["pairs"]] == [
        "pair-20260727-110000",
        "pair-20260727-100000",
    ]


def test_a_manifest_naming_a_missing_file_reports_no_size(gallery):
    # The tile must be able to say "missing" rather than show a broken image.
    directory = gallery.pair_dir("pair-20260727-120000")
    directory.mkdir(parents=True, exist_ok=True)
    gallery.write_manifest("pair-20260727-120000", "front.jpg", None, "photo")
    assert listing(gallery)["pairs"][0]["sizes"]["front"] is None


def test_the_route_serves_the_listing_as_json(gallery):
    make_photo(gallery, "pair-20260727-100000")
    port = free_port()
    pair = CameraPair(front_channel=0, rear_channel=2)
    threading.Thread(target=serve, args=(pair, gallery, port), daemon=True).start()
    time.sleep(0.5)

    with urllib.request.urlopen(f"http://127.0.0.1:{port}/gallery", timeout=5) as response:
        assert response.headers["Access-Control-Allow-Origin"] == "*"
        payload = json.loads(response.read())
    assert payload["pairs"][0]["id"] == "pair-20260727-100000"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && timeout 180 python3 -m pytest tests/test_bench_gallery.py -q'
```

Expected: FAIL — `ImportError: cannot import name 'listing'`.

- [ ] **Step 3: Implement the listing**

In `rdk/vision/bench_server.py`, add `import json` to the imports and this function above `serve`:

```python
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
```

- [ ] **Step 4: Route it**

In `BenchHandler.do_GET`, replace the body with routing:

```python
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if self.path.startswith("/preview/"):
                self._preview()
            elif self.path == "/gallery":
                self._listing()
            else:
                self.send_error(404)
```

and add the handler method:

```python
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
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && timeout 180 python3 -m pytest tests/test_bench_gallery.py -q'
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add rdk/vision/bench_server.py rdk/vision/tests/test_bench_gallery.py
git commit -m "feat(vision): serve the capture listing from the bench server"
```

---

### Task 3: Serving capture files, safely

**Files:**
- Modify: `rdk/vision/bench_server.py`
- Test: `rdk/vision/tests/test_bench_gallery.py`

**Interfaces:**
- Produces: `safe_path(root: Path, relative: str) -> Path | None` — resolved and inside `root`, else `None`; `first_frame(data: bytes) -> bytes | None` — the first JPEG of a concatenated-JPEG segment. Routes `GET /gallery/<pair>/<file>` and `GET /gallery/<pair>/<file>/thumb`.

- [ ] **Step 1: Write the failing tests**

Append to `rdk/vision/tests/test_bench_gallery.py`:

```python
import urllib.error

from bench_server import first_frame, safe_path

JPEG_A = b"\xff\xd8\xff first \xff\xd9"
JPEG_B = b"\xff\xd8\xff second \xff\xd9"


def get(port: int, path: str):
    return urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5)


def status_of(port: int, path: str) -> int:
    try:
        with get(port, path) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def running(gallery) -> int:
    port = free_port()
    pair = CameraPair(front_channel=0, rear_channel=2)
    threading.Thread(target=serve, args=(pair, gallery, port), daemon=True).start()
    time.sleep(0.5)
    return port


def test_safe_path_accepts_a_file_inside_the_root(tmp_path):
    (tmp_path / "pair").mkdir()
    (tmp_path / "pair" / "front.jpg").write_bytes(b"x")
    assert safe_path(tmp_path, "pair/front.jpg") is not None


def test_safe_path_rejects_climbing_out():
    # This server binds 0.0.0.0 and the sidecar runs as root, so a path that
    # escapes the gallery reads whatever root can read.
    assert safe_path(Path("/var/lib/max/gallery"), "../../../etc/shadow") is None


def test_safe_path_rejects_an_absolute_path():
    assert safe_path(Path("/var/lib/max/gallery"), "/etc/shadow") is None


def test_safe_path_rejects_the_root_itself(tmp_path):
    assert safe_path(tmp_path, "") is None


def test_first_frame_slices_at_the_second_marker():
    assert first_frame(JPEG_A + JPEG_B) == JPEG_A


def test_first_frame_of_a_single_frame_file_is_the_whole_file():
    assert first_frame(JPEG_A) == JPEG_A


def test_first_frame_of_something_that_is_not_jpeg_is_none():
    assert first_frame(b"not a jpeg at all") is None


def test_the_route_serves_a_photo(gallery):
    make_photo(gallery, "pair-1")
    port = running(gallery)
    with get(port, "/gallery/pair-1/front.jpg") as response:
        assert response.status == 200
        assert response.headers["Content-Type"] == "image/jpeg"
        assert response.read() == PHOTO


def test_the_route_refuses_to_climb_out(gallery):
    # Weaker than it looks: urllib may normalise "../" away before sending, in
    # which case the path never matches /gallery/ and 404s for a different
    # reason. Kept because it costs nothing; the encoded test below is the one
    # that actually reaches safe_path, and the curl check in Task 5 uses
    # --path-as-is so the server really does see the dots.
    port = running(gallery)
    assert status_of(port, "/gallery/../../../etc/shadow") == 404


def test_the_route_refuses_an_encoded_climb(gallery):
    # %2e%2e survives client-side normalisation, so this exercises the guard.
    port = running(gallery)
    assert status_of(port, "/gallery/%2e%2e/%2e%2e/etc/shadow") == 404


def test_an_unknown_pair_is_404(gallery):
    port = running(gallery)
    assert status_of(port, "/gallery/pair-nope/front.jpg") == 404


def test_thumb_returns_only_the_first_frame(gallery):
    directory = gallery.pair_dir("pair-v")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.mjpeg").write_bytes(JPEG_A + JPEG_B)
    gallery.write_manifest("pair-v", "front.mjpeg", None, "video")

    port = running(gallery)
    with get(port, "/gallery/pair-v/front.mjpeg/thumb") as response:
        assert response.read() == JPEG_A
        assert response.headers["Content-Type"] == "image/jpeg"


def test_a_recording_downloads_as_an_attachment(gallery):
    directory = gallery.pair_dir("pair-v")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "front.mjpeg").write_bytes(JPEG_A + JPEG_B)
    gallery.write_manifest("pair-v", "front.mjpeg", None, "video")

    port = running(gallery)
    with get(port, "/gallery/pair-v/front.mjpeg") as response:
        assert "attachment" in response.headers["Content-Disposition"]
        assert response.read() == JPEG_A + JPEG_B
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && timeout 180 python3 -m pytest tests/test_bench_gallery.py -q'
```

Expected: FAIL — `ImportError: cannot import name 'first_frame'`.

- [ ] **Step 3: Implement the two helpers**

In `rdk/vision/bench_server.py`, add `from pathlib import Path` and `from urllib.parse import unquote` to the imports, then:

```python
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
```

- [ ] **Step 4: Route the file requests**

Extend `do_GET`:

```python
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if self.path.startswith("/preview/"):
                self._preview()
            elif self.path == "/gallery":
                self._listing()
            elif self.path.startswith("/gallery/"):
                self._capture()
            else:
                self.send_error(404)
```

and add:

```python
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
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
scp -r rdk/vision root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'cd /opt/max/rdk/vision && timeout 180 python3 -m pytest tests/test_bench_gallery.py -q'
```

Expected: PASS, 18 tests.

- [ ] **Step 6: Run the full suite**

```bash
ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q'
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add rdk/vision/bench_server.py rdk/vision/tests/test_bench_gallery.py
git commit -m "feat(vision): serve capture files, refusing any path outside the gallery"
```

---

### Task 4: The captures grid in the HUD

**Files:**
- Modify: `rdk/agent/src/hud/index.html`

**Interfaces:**
- Consumes: `GET /gallery` and `GET /gallery/<pair>/<file>[/thumb]` on `__PREVIEW_PORT__`.

- [ ] **Step 1: Add the section markup**

In `rdk/agent/src/hud/index.html`, after the transcript card:

```html
<div class="card" style="margin-top: 16px">
  <h1 style="margin-top: 0">captures</h1>
  <div id="captures-status" class="muted">loading…</div>
  <div id="captures" class="grid"></div>
</div>
```

- [ ] **Step 2: Add the styles**

Inside the existing `<style>` block:

```css
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
  }
  .tile {
    border: 1px solid #21262d;
    border-radius: 6px;
    overflow: hidden;
    background: #0b0d10;
  }
  .tile img {
    display: block;
    aspect-ratio: 16 / 9;
    object-fit: cover;
  }
  .tile .meta {
    padding: 6px 8px;
    font-size: 12px;
    color: #7d8590;
  }
  .muted {
    color: #7d8590;
  }
  .missing {
    padding: 24px 8px;
    text-align: center;
    color: #f85149;
    font-size: 12px;
  }
```

- [ ] **Step 3: Add the polling and rendering**

Append inside the existing `<script>` block:

```js
  const galleryBase = `http://${host}:__PREVIEW_PORT__`;
  const capturesEl = document.getElementById("captures");
  const statusEl = document.getElementById("captures-status");
  let lastSerialised = null;

  function tile(pair) {
    const side = pair.front ? "front" : "rear";
    const name = pair[side];
    const bytes = pair.sizes ? pair.sizes[side] : null;
    const href = `${galleryBase}/gallery/${pair.id}/${name}`;
    // A recording is concatenated JPEG: show frame one, link the file.
    const isVideo = pair.kind === "video";
    const src = isVideo ? `${href}/thumb` : href;
    const label = isVideo ? "video" : "photo";
    const size = bytes === null ? "missing" : `${Math.round(bytes / 1024)} KB`;

    if (bytes === null) {
      return `<div class="tile"><div class="missing">file missing</div>
        <div class="meta">${pair.id}<br />${label} · ${size}</div></div>`;
    }
    return `<div class="tile"><a href="${href}" target="_blank">
      <img src="${src}" alt="${pair.id}" /></a>
      <div class="meta">${pair.id}<br />${label} · ${size}${pair.degraded ? " · degraded" : ""}</div></div>`;
  }

  async function refreshCaptures() {
    let payload;
    try {
      const response = await fetch(`${galleryBase}/gallery`, { cache: "no-store" });
      payload = await response.json();
    } catch {
      // "Cannot reach the sidecar" and "nothing captured yet" must never look
      // the same. A blank panel that meant both cost an afternoon once.
      statusEl.textContent = "sidecar unreachable";
      return;
    }

    const serialised = JSON.stringify(payload.pairs);
    if (serialised === lastSerialised) return;
    lastSerialised = serialised;

    statusEl.textContent = payload.pairs.length ? "" : "no captures yet";
    capturesEl.innerHTML = payload.pairs.map(tile).join("");
  }

  refreshCaptures();
  setInterval(refreshCaptures, 3000);
```

- [ ] **Step 4: Deploy the page and look at it**

```bash
scp -r rdk/agent root@$BOARD:/opt/max/rdk/ && ssh root@$BOARD 'systemctl restart max-agent && sleep 6 && systemctl is-active max-agent'
```

Open `http://$BOARD:8080/`. Expected: a captures section listing the pairs already on the board, each tile showing its image, id and size.

- [ ] **Step 5: Commit**

```bash
git add rdk/agent/src/hud/index.html
git commit -m "feat(hud): show the captures grid"
```

---

### Task 5: Verify end to end on the board

**Files:**
- Modify: `rdk/README.md`

- [ ] **Step 1: Confirm the listing over the network**

```bash
curl -s --max-time 6 "http://$BOARD:8081/gallery" | head -c 600; echo
```

Expected: JSON with a `pairs` array, newest first, each carrying `sizes`.

- [ ] **Step 2: Confirm a capture downloads and is a real image**

```bash
PAIR=$(curl -s --max-time 6 "http://$BOARD:8081/gallery" | python3 -c "import json,sys; print(json.load(sys.stdin)['pairs'][0]['id'])")
echo "pair: $PAIR"
curl -s --max-time 10 -o /tmp/tile.jpg -w "http %{http_code}  bytes %{size_download}\n" "http://$BOARD:8081/gallery/$PAIR/front.jpg"
python3 -c "
d = open('/tmp/tile.jpg','rb').read()
print('jpeg:', d[:3] == b'\xff\xd8\xff', 'bytes:', len(d))
"
```

Expected: `http 200`, a plausible size, and `jpeg: True`. Open `/tmp/tile.jpg` and confirm it is a real picture, not a placeholder.

- [ ] **Step 3: Confirm the traversal guard on the live server**

```bash
for p in "/gallery/../../../etc/shadow" "/gallery/%2e%2e/%2e%2e/etc/passwd" "/gallery/pair-nope/front.jpg"; do
  printf "%s -> " "$p"
  curl -s -o /dev/null --max-time 6 -w "%{http_code}\n" --path-as-is "http://$BOARD:8081$p"
done
```

Expected: `404` for all three. **Anything else stops this task** — the server runs as root and this is the boundary that matters. `--path-as-is` is required, or curl normalises the `..` away client-side and the test proves nothing.

- [ ] **Step 4: Take a photo and watch it appear**

With the HUD open in a browser, ask Max for a photo, or send it directly:

```bash
ssh root@$BOARD 'python3 -c "
import socket, json
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(\"/run/max/vision.sock\")
s.sendall(json.dumps({\"id\":\"g1\",\"op\":\"camera.photo\",\"args\":{}}).encode()+b\"\n\")
print(s.recv(4096).decode().strip())
"'
```

Expected: `"status": "ok"`, and a new tile appears in the HUD within ~3 seconds without a reload.

- [ ] **Step 5: Confirm the preview still works alongside it**

```bash
curl -s --max-time 6 -o /tmp/p.mjpeg -w "front: http %{http_code} bytes %{size_download}\n" "http://$BOARD:8081/preview/front"
curl -s --max-time 6 -o /dev/null -w "rear:  http %{http_code}\n" "http://$BOARD:8081/preview/rear"
```

Expected: front `200` with megabytes, rear `503`. The gallery routes must not have disturbed the streaming ones.

- [ ] **Step 6: Document it**

In `rdk/README.md`, under the HUD/vision section, add:

```markdown
### Seeing captures

The bench HUD at `http://<board>:8080/` shows a **captures** grid under the
transcript, served by the sidecar on `MAX_VISION_PREVIEW_PORT` — the same reason
preview lives there, that image bytes never pass through the agent.

| Route | Returns |
| ----- | ------- |
| `GET /gallery` | every capture, newest first, with sizes |
| `GET /gallery/<pair>/<file>` | the bytes; a `.mjpeg` downloads as an attachment |
| `GET /gallery/<pair>/<file>/thumb` | the first frame of a recording |

It is **read-only**: nothing on that page deletes a capture, because it is
unauthenticated and bound to `0.0.0.0`. Clear space with `rm` over SSH.

Any path resolving outside the gallery root is a `404`. The sidecar runs as
root, so that check is a security boundary, not tidiness — see
`bench_server.safe_path`.
```

- [ ] **Step 7: Run the full suite and commit**

```bash
ssh root@$BOARD 'cd /opt/max/rdk/vision && python3 -m pytest tests/ -q | tail -3'
git add rdk/README.md
git commit -m "docs(hud): document the captures grid and its routes"
```

Expected: PASS. Report the count; it should have grown by roughly 18.

---

## Notes for the implementer

- **`safe_path` is the one thing in this plan that must not be approximated.** The sidecar runs as root and the port is open to the LAN. Check the resolved path, never the spelling of the input.
- **The page and the sidecar deploy separately**, and restarting `max-agent` drops a live voice session.
- **Do not add a delete route.** It was considered and deliberately rejected: an unauthenticated page on `0.0.0.0` should not be able to destroy evidence on a click.
- **If `test_preview.py` needs more than its call site changed in Task 1**, the extraction changed behaviour. Fix the extraction.
