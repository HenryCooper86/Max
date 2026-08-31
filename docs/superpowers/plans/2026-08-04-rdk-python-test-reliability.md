# RDK Python Test Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every hardware-independent RDK vision/ADAS Python test run through one local and CI command without touching production storage or hardware during import.

**Architecture:** Move environment parsing into an immutable `VisionConfig` and production object construction into `build_runtime`, then pass a `VisionRuntime` explicitly into each control server. Add a pinned native Python development environment, a strict pytest marker contract, an npm entry point, and a dedicated GitHub Actions job that invokes the same command.

**Tech Stack:** Python 3.10, pytest 8.3.5, NumPy 1.26.4, OpenCV headless 4.10.0.84, FFmpeg, Node 22/npm, GitHub Actions

## Global Constraints

- The normal command is exactly `npm run test:rdk-vision` from the repository root.
- The normal suite excludes only tests explicitly marked `hardware`; unknown pytest markers are errors.
- Off-board collection and execution must not access `/var/lib/max`, `/run/max`, cameras, ROS/ISP, or the BPU.
- Production defaults remain `/run/max/vision.sock`, `/var/lib/max/gallery`, `/var/lib/max/corpus`, ports `8081`, channels `0` and `2`, minimum free space `1024` MB, and exact-string `"1"` feature gates.
- `numpy==1.26.4` must match the board; development pytest is `8.3.5` and headless OpenCV is `4.10.0.84`.
- FFmpeg and `ffprobe` are mandatory software prerequisites, not skipped test capabilities.
- Keep the Python command separate from the existing `npm run check`; both are independent mandatory CI jobs.
- Do not alter camera, recorder, gallery, ADAS algorithms, systemd retry policy, consent behavior, socket permissions, or shutdown semantics.

## File Structure

- Create `rdk/vision/requirements-dev.txt`: pinned off-board Python test dependencies.
- Create `rdk/vision/pytest.ini`: test discovery and the strict `hardware` marker declaration.
- Create `rdk/vision/tests/test_service_runtime.py`: import-purity, configuration, and runtime-construction regressions.
- Modify `rdk/vision/service.py`: pure configuration, explicit runtime ownership, and production wiring.
- Modify `rdk/vision/tests/test_control_socket.py`: inject a runtime and prove server state is isolated.
- Modify `package.json`: expose the single repository-root test command.
- Modify `.gitignore`: exclude the documented local Python virtual environment.
- Modify `.github/workflows/ci.yml`: add the independent Python RDK gate.
- Modify `rdk/README.md`: document macOS, Ubuntu, board, and hardware verification commands.

---

### Task 1: Native Python gate and import-safe vision runtime

**Files:**

- Create: `rdk/vision/requirements-dev.txt`
- Create: `rdk/vision/pytest.ini`
- Create: `rdk/vision/tests/test_service_runtime.py`
- Modify: `.gitignore`
- Modify: `package.json:9-26`
- Modify: `rdk/vision/service.py:5-208`
- Modify: `rdk/vision/tests/test_control_socket.py:1-58`
- Test: `rdk/vision/tests/test_service_runtime.py`
- Test: `rdk/vision/tests/test_control_socket.py`

**Interfaces:**

- Consumes: existing `Gallery(root: str, min_free_mb: int)`, `CameraPair(front_channel: int, rear_channel: int)`, `EventBus`, and `rpc.Handler`.
- Produces: `VisionConfig.from_env(env: Mapping[str, str] | None = None) -> VisionConfig`.
- Produces: `VisionRuntime(gallery, events, cameras, handlers)`.
- Produces: `build_runtime(config: VisionConfig) -> VisionRuntime`.
- Produces: `ControlServer(socket_path, ControlHandler, runtime)` with `runtime` available to `ControlHandler`.
- Produces: `npm run test:rdk-vision` as the shared hardware-independent suite command.

- [ ] **Step 1: Add the native development dependency and pytest contracts**

Create `rdk/vision/requirements-dev.txt`:

```text
numpy==1.26.4
opencv-python-headless==4.10.0.84
pytest==8.3.5
```

Create `rdk/vision/pytest.ini`:

```ini
[pytest]
testpaths = tests
markers =
    hardware: requires an RDK camera, ROS/ISP stack, or BPU runtime
```

Add `.venv/` under the Python tooling section of `.gitignore`:

```gitignore
# Python tooling state (rdk/vision test suite)
.venv/
__pycache__/
.pytest_cache/
```

Add this script to `package.json` immediately after `"test": "vitest run"`:

```json
"test:rdk-vision": "python3 -m pytest -c rdk/vision/pytest.ini -m \"not hardware\" --strict-markers rdk/vision/tests",
```

- [ ] **Step 2: Provision the test environment**

Run:

```bash
python3.10 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r rdk/vision/requirements-dev.txt
ffmpeg -version
ffprobe -version
```

Expected: all commands exit `0`; NumPy, headless OpenCV, and pytest install from the pinned manifest, and both FFmpeg binaries report versions.

- [ ] **Step 3: Write failing configuration and import-purity tests**

Create `rdk/vision/tests/test_service_runtime.py`:

```python
import os
import subprocess
import sys
from pathlib import Path

import pytest

VISION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(VISION_ROOT))

import service


def test_import_does_not_construct_the_production_runtime(tmp_path):
    gallery_dir = tmp_path / "must-not-exist"
    env = {**os.environ, "MAX_GALLERY_DIR": str(gallery_dir)}
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            f"import sys; sys.path.insert(0, {str(VISION_ROOT)!r}); import service",
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert not gallery_dir.exists()
    assert not hasattr(service, "gallery")
    assert not hasattr(service, "cameras")
    assert not hasattr(service, "events")


def test_config_defaults_match_the_production_service():
    assert service.VisionConfig.from_env({}) == service.VisionConfig(
        socket_path="/run/max/vision.sock",
        gallery_dir="/var/lib/max/gallery",
        min_free_mb=1024,
        preview_port=8081,
        corpus_dir="/var/lib/max/corpus",
        adas_shadow=False,
        share_frames=False,
        front_channel=0,
        rear_channel=2,
    )


def test_config_reads_overrides_and_keeps_feature_gates_exact():
    config = service.VisionConfig.from_env(
        {
            "MAX_VISION_SOCKET": "/tmp/max/vision.sock",
            "MAX_GALLERY_DIR": "/tmp/max/gallery",
            "MAX_GALLERY_MIN_FREE_MB": "17",
            "MAX_VISION_PREVIEW_PORT": "9081",
            "MAX_CORPUS_DIR": "/tmp/max/corpus",
            "MAX_ADAS_SHADOW": "1",
            "MAX_VISION_SHARE": "1",
            "RDK_CAMERA_FRONT": "4",
            "RDK_CAMERA_REAR": "6",
        }
    )
    assert config == service.VisionConfig(
        socket_path="/tmp/max/vision.sock",
        gallery_dir="/tmp/max/gallery",
        min_free_mb=17,
        preview_port=9081,
        corpus_dir="/tmp/max/corpus",
        adas_shadow=True,
        share_frames=True,
        front_channel=4,
        rear_channel=6,
    )

    rejected = service.VisionConfig.from_env(
        {"MAX_ADAS_SHADOW": "true", "MAX_VISION_SHARE": "yes"}
    )
    assert rejected.adas_shadow is False
    assert rejected.share_frames is False


@pytest.mark.parametrize(
    "name",
    [
        "MAX_GALLERY_MIN_FREE_MB",
        "MAX_VISION_PREVIEW_PORT",
        "RDK_CAMERA_FRONT",
        "RDK_CAMERA_REAR",
    ],
)
def test_invalid_numeric_config_fails_fast(name):
    with pytest.raises(ValueError):
        service.VisionConfig.from_env({name: "not-a-number"})


def test_runtime_uses_the_supplied_storage_and_camera_config(tmp_path):
    gallery_dir = tmp_path / "gallery"
    runtime = service.build_runtime(
        service.VisionConfig(
            gallery_dir=str(gallery_dir),
            min_free_mb=0,
            front_channel=4,
            rear_channel=6,
        )
    )
    assert gallery_dir.is_dir()
    assert runtime.gallery.root == str(gallery_dir)
    assert runtime.gallery.min_free_mb == 0
    assert runtime.cameras.front_channel == 4
    assert runtime.cameras.rear_channel == 6
    assert set(runtime.handlers) == {"camera.photo", "camera.record"}
```

- [ ] **Step 4: Run the new tests and verify the old import behavior fails**

Run:

```bash
PATH="$PWD/.venv/bin:$PATH" .venv/bin/python -m pytest \
  -c rdk/vision/pytest.ini --strict-markers \
  rdk/vision/tests/test_service_runtime.py -q
```

Expected: FAIL during collection because the current module creates its gallery at import time, or with missing `VisionConfig`; it must not pass.

- [ ] **Step 5: Add pure configuration and explicit runtime construction**

In `rdk/vision/service.py`, add `dataclass`, `Mapping`, and `Handler` imports and replace the environment constants plus runtime globals with:

```python
from dataclasses import dataclass
from typing import Mapping

from rpc import Handler, decode_lines, dispatch


@dataclass(frozen=True)
class VisionConfig:
    socket_path: str = "/run/max/vision.sock"
    gallery_dir: str = "/var/lib/max/gallery"
    min_free_mb: int = 1024
    preview_port: int = 8081
    corpus_dir: str = "/var/lib/max/corpus"
    adas_shadow: bool = False
    share_frames: bool = False
    front_channel: int = 0
    rear_channel: int = 2

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "VisionConfig":
        values = os.environ if env is None else env
        return cls(
            socket_path=values.get("MAX_VISION_SOCKET", "/run/max/vision.sock"),
            gallery_dir=values.get("MAX_GALLERY_DIR", "/var/lib/max/gallery"),
            min_free_mb=int(values.get("MAX_GALLERY_MIN_FREE_MB", "1024")),
            preview_port=int(values.get("MAX_VISION_PREVIEW_PORT", "8081")),
            corpus_dir=values.get("MAX_CORPUS_DIR", "/var/lib/max/corpus"),
            adas_shadow=values.get("MAX_ADAS_SHADOW", "0") == "1",
            share_frames=values.get("MAX_VISION_SHARE", "0") == "1",
            front_channel=int(values.get("RDK_CAMERA_FRONT", "0")),
            rear_channel=int(values.get("RDK_CAMERA_REAR", "2")),
        )


@dataclass
class VisionRuntime:
    gallery: Gallery
    events: EventBus
    cameras: CameraPair
    handlers: dict[str, Handler]


def build_runtime(config: VisionConfig) -> VisionRuntime:
    gallery = Gallery(config.gallery_dir, config.min_free_mb)
    events = EventBus()
    cameras = CameraPair(
        front_channel=config.front_channel,
        rear_channel=config.rear_channel,
    )
    handlers: dict[str, Handler] = {
        "camera.photo": lambda args: cameras.capture_photo(gallery),
        "camera.record": lambda args: (
            cameras.start_recording(gallery)
            if args.get("start")
            else cameras.stop_recording(gallery)
        ),
    }
    return VisionRuntime(
        gallery=gallery,
        events=events,
        cameras=cameras,
        handlers=handlers,
    )
```

Delete `SOCKET_PATH`, `GALLERY_DIR`, `MIN_FREE_MB`, `PREVIEW_PORT`, `CORPUS_DIR`, `ADAS_SHADOW`, `SHARE_FRAMES`, `gallery`, `events`, `cameras`, and `HANDLERS` from module scope.

- [ ] **Step 6: Pass the runtime through the control server**

Replace `ControlHandler` and `ControlServer` with:

```python
class ControlHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        runtime = self.server.runtime
        write_lock = threading.Lock()

        def write(line: str) -> None:
            with write_lock:
                self.wfile.write(line.encode("utf-8"))
                self.wfile.flush()

        runtime.events.register(write)
        try:
            buffer = ""
            while True:
                chunk = self.rfile.readline()
                if not chunk:
                    return
                buffer += chunk.decode("utf-8", errors="replace")
                messages, buffer = decode_lines(buffer)
                for message in messages:
                    line = dispatch(message, runtime.handlers)
                    if line:
                        write(line)
        finally:
            runtime.events.unregister(write)


class ControlServer(socketserver.ThreadingUnixStreamServer):
    allow_reuse_address = True

    def __init__(
        self,
        socket_path: str,
        handler: type[socketserver.StreamRequestHandler],
        runtime: VisionRuntime,
    ) -> None:
        self.runtime = runtime
        super().__init__(socket_path, handler)
```

Retain the existing write lock and unregister behavior; only their state source changes.

- [ ] **Step 7: Wire `main()` to one config and runtime**

Replace `main()` with:

```python
def main() -> None:
    config = VisionConfig.from_env()
    runtime = build_runtime(config)

    if os.path.exists(config.socket_path):
        os.unlink(config.socket_path)
    os.makedirs(os.path.dirname(config.socket_path), exist_ok=True)

    repaired = runtime.gallery.reconcile()
    if repaired:
        print(
            f"[vision] recovered {len(repaired)} interrupted capture(s): {', '.join(repaired)}",
            flush=True,
        )

    runtime.cameras.open()
    require_cameras(runtime.cameras)

    from monitor import start_monitor
    from notify import sd_notify

    def exit_stale(stale: list[str]) -> None:
        print(
            f"[vision] camera frames stale: {', '.join(stale)}; exiting for systemd to restart",
            flush=True,
        )
        os._exit(1)

    start_monitor(runtime.cameras, notify=sd_notify, on_stale=exit_stale)

    from bench_server import serve as serve_bench

    threading.Thread(
        target=serve_bench,
        args=(runtime.cameras, runtime.gallery, config.preview_port),
        kwargs={"share_frames": config.share_frames},
        daemon=True,
    ).start()

    ride = None
    if config.adas_shadow:
        from ride import RideSession

        open_cameras = {
            name: camera
            for name, camera in (
                ("front", runtime.cameras.front),
                ("rear", runtime.cameras.rear),
            )
            if camera is not None
        }
        ride = RideSession(
            cameras=open_cameras,
            corpus_dir=config.corpus_dir,
            min_free_mb=config.min_free_mb,
            broadcast=runtime.events.broadcast,
        )
        if ride.start() is None:
            ride = None
    else:
        print("[vision] MAX_ADAS_SHADOW is not 1; no ride, no ADAS", flush=True)

    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))

    with ControlServer(config.socket_path, ControlHandler, runtime) as server:
        os.chmod(config.socket_path, 0o660)
        try:
            server.serve_forever()
        finally:
            finalize(runtime.cameras, runtime.gallery, ride)
            with contextlib.suppress(OSError):
                os.unlink(config.socket_path)
```

Keep the existing explanatory comments around recovery, monitor failure, shadow mode, and shutdown where they describe unchanged production invariants. Retain the lazy imports' `# noqa: PLC0415` annotations if lint requires them.

- [ ] **Step 8: Adapt the control-socket test and add runtime-isolation coverage**

In `rdk/vision/tests/test_control_socket.py`, add:

```python
def make_runtime(tmp_path, name="runtime"):
    runtime = service.build_runtime(
        service.VisionConfig(
            gallery_dir=str(tmp_path / name / "gallery"),
            min_free_mb=0,
        )
    )
    runtime.handlers = {"camera.photo": lambda args: {"status": "ok"}}
    return runtime
```

Change `test_concurrent_writes_do_not_interleave` to construct and use its runtime:

```python
runtime = make_runtime(tmp_path)
server = service.ControlServer(sock_path, service.ControlHandler, runtime)
```

Change the hazard broadcaster inside `hammer()` to:

```python
runtime.events.broadcast({"event": "hazard", "threat": f"t{i}"})
```

Extend the existing `finally` block so resources are closed deterministically:

```python
finally:
    server.shutdown()
    server.server_close()
    server_thread.join(timeout=5.0)
```

Add this test after the concurrency test:

```python
def test_control_servers_own_separate_runtime_state(tmp_path):
    first_runtime = make_runtime(tmp_path, "first")
    second_runtime = make_runtime(tmp_path, "second")
    first = service.ControlServer(
        str(tmp_path / "first.sock"), service.ControlHandler, first_runtime
    )
    second = service.ControlServer(
        str(tmp_path / "second.sock"), service.ControlHandler, second_runtime
    )
    try:
        assert first.runtime is first_runtime
        assert second.runtime is second_runtime
        assert first.runtime.events is not second.runtime.events
        assert first.runtime.handlers is not second.runtime.handlers
    finally:
        first.server_close()
        second.server_close()
```

- [ ] **Step 9: Run the focused runtime and control tests**

Run:

```bash
PATH="$PWD/.venv/bin:$PATH" .venv/bin/python -m pytest \
  -c rdk/vision/pytest.ini --strict-markers \
  rdk/vision/tests/test_service_runtime.py \
  rdk/vision/tests/test_control_socket.py -q
```

Expected: PASS, including the subprocess import test and the concurrent NDJSON test.

- [ ] **Step 10: Run the complete hardware-independent Python gate**

Run:

```bash
PATH="$PWD/.venv/bin:$PATH" npm run test:rdk-vision
```

Expected: every current RDK vision/ADAS test passes; the summary must not contain an unexpected skip, collection error, production-path permission error, camera open, or BPU import.

- [ ] **Step 11: Check the TypeScript RDK boundary and formatting**

Run:

```bash
npx vitest run tests/rdk-*.test.ts
npx prettier --check package.json
.venv/bin/python -m compileall -q rdk/vision
git diff --check
```

Expected: 19 TypeScript test files and 219 tests pass at the pre-change baseline or higher; `package.json` formatting, Python compilation, and `git diff --check` pass.

- [ ] **Step 12: Commit the local gate and runtime isolation**

```bash
git add .gitignore package.json rdk/vision/requirements-dev.txt rdk/vision/pytest.ini rdk/vision/service.py rdk/vision/tests/test_service_runtime.py rdk/vision/tests/test_control_socket.py
git commit -m "test(rdk): make the Python suite hermetic off-board"
```

### Task 2: Dedicated GitHub Actions RDK vision gate

**Files:**

- Modify: `.github/workflows/ci.yml:14-27`
- Test: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: `rdk/vision/requirements-dev.txt` and `npm run test:rdk-vision` from Task 1.
- Produces: independent required job `rdk-vision` on `ubuntu-latest` using Python 3.10 and Node 22.

- [ ] **Step 1: Establish that CI does not yet name the Python gate**

Run:

```bash
rg -n '^  rdk-vision:|npm run test:rdk-vision' .github/workflows/ci.yml
```

Expected: no matches and exit status `1`.

- [ ] **Step 2: Add the independent CI job**

Insert this job after `web-and-relay` and before `android`:

```text
  rdk-vision:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.10"
          cache: pip
          cache-dependency-path: rdk/vision/requirements-dev.txt
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - name: Install FFmpeg
        run: |
          sudo apt-get update
          sudo apt-get install -y ffmpeg
      - run: python -m pip install -r rdk/vision/requirements-dev.txt
      - run: npm run test:rdk-vision
```

Do not add `npm ci`: the npm command is an orchestrator for `python3 -m pytest` and does not import a Node package.

- [ ] **Step 3: Validate the workflow text and shared command locally**

Run:

```bash
rg -n '^  rdk-vision:|python-version: "3.10"|cache-dependency-path: rdk/vision/requirements-dev.txt|npm run test:rdk-vision' .github/workflows/ci.yml
npx prettier --check .github/workflows/ci.yml
PATH="$PWD/.venv/bin:$PATH" npm run test:rdk-vision
git diff --check
```

Expected: one job match, one Python version match, one cache dependency match, one shared-command match; workflow formatting, the Python suite, and the diff check pass.

- [ ] **Step 4: Commit the CI gate**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(rdk): run the Python vision suite off-board"
```

### Task 3: Cross-platform test documentation and final verification

**Files:**

- Modify: `rdk/README.md:787-799`
- Test: `rdk/README.md`

**Interfaces:**

- Consumes: the pinned manifest, pytest contract, npm command, and CI job from Tasks 1 and 2.
- Produces: exact macOS, Ubuntu, and board setup/run instructions plus an explicit boundary between software tests and hardware verification.

- [ ] **Step 1: Replace the board-only Python suite section**

Replace `rdk/README.md` lines 787-799 with:

````markdown
## Running the Python suite

The hardware-independent vision and ADAS suite runs on macOS, Ubuntu, CI, and
the board. It uses Python 3.10, the same version supplied by Ubuntu 22.04 on the
RDK image. Camera, ROS/ISP, and BPU libraries are not imported by this suite.

Install macOS prerequisites and create the local environment:

```bash
brew install python@3.10 ffmpeg
/opt/homebrew/bin/python3.10 -m venv .venv  # Apple Silicon
# On Intel Homebrew, use /usr/local/bin/python3.10 instead.
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r rdk/vision/requirements-dev.txt
```

On Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y python3.10-venv ffmpeg
python3.10 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r rdk/vision/requirements-dev.txt
```

Run every hardware-independent test from the repository root:

```bash
PATH="$PWD/.venv/bin:$PATH" npm run test:rdk-vision
```

The command treats missing NumPy, OpenCV, FFmpeg, or `ffprobe` as a failure. It
skips only tests explicitly marked `hardware`, and strict marker checking makes
a misspelled marker fail collection.

The deployed board already has NumPy, OpenCV, pytest, FFmpeg, and Node. After
syncing the checkout to `/opt/max`, run the same gate there:

```bash
cd /opt/max
npm run test:rdk-vision
```

Real camera and BPU validation stays separate because CI cannot emulate the
hardware. Use the on-hardware checklist above and `tools/check_anchors.py`; a
future pytest that opens either resource must use `@pytest.mark.hardware`.
````

- [ ] **Step 2: Verify the documented commands match the implementation**

Run:

```bash
rg -n 'requirements-dev.txt|npm run test:rdk-vision|pytest.mark.hardware|tools/check_anchors.py' rdk/README.md
rg -n '"test:rdk-vision"' package.json
npx prettier --check rdk/README.md package.json .github/workflows/ci.yml
```

Expected: the README names the manifest, shared command, hardware marker, and real BPU tool; `package.json` defines exactly one matching script; all files pass formatting.

- [ ] **Step 3: Run the complete feature verification**

Run:

```bash
PATH="$PWD/.venv/bin:$PATH" npm run test:rdk-vision
npx vitest run tests/rdk-*.test.ts
npm run check
git diff --check
git status --short
```

Expected:

- the complete hardware-independent Python suite passes with no unexpected skips;
- the TypeScript RDK baseline remains at least 19 files and 219 tests passing;
- the repository protocol, formatting, lint, dead-code, full Vitest, fault-matrix, and build gate passes;
- `git diff --check` is clean;
- `git status --short` lists only the intended README change before the documentation commit.

- [ ] **Step 4: Commit the documentation**

```bash
git add rdk/README.md
git commit -m "docs(rdk): document the cross-platform Python gate"
```

- [ ] **Step 5: Confirm the final branch state**

Run:

```bash
git status --short --branch
git log --oneline -4
```

Expected: a clean branch containing the runtime/test, CI, and documentation commits after the design and plan commits.
