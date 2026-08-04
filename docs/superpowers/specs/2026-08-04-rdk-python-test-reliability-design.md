# RDK Python Test Reliability Design

**Date:** 2026-08-04

## Context

The RDK TypeScript suite runs locally and in the repository gate, but the Python
vision and ADAS suite is only documented as a board-side command. A normal
off-board import of `rdk/vision/service.py` currently constructs `Gallery` with
the production default `/var/lib/max/gallery`; on a development machine that
tries to create a production directory during test collection. The development
dependencies are also implicit, and GitHub Actions does not run any Python RDK
tests.

This leaves a large, safety-relevant part of the software outside the ordinary
developer and CI feedback loop even though its camera and BPU boundaries are
already mostly injectable.

## Goal

Provide one documented command that runs every hardware-independent RDK Python
test on macOS, Linux, GitHub Actions, and the board's ordinary Python
environment. Off-board test collection and execution must not access
`/var/lib/max`, `/run/max`, cameras, or the BPU. Tests that genuinely require
RDK hardware must be explicitly marked and excluded from the normal command.

## Non-goals

- Emulating the RDK camera, ROS, ISP, or BPU stack in CI.
- Replacing on-board camera, thermal, audio, or BPU verification.
- Refactoring camera, recorder, gallery, or ADAS algorithms unrelated to test
  isolation.
- Introducing Docker, `uv`, or a new Python packaging workflow.
- Adding hardware tests merely to exercise the new marker; the existing suite
  uses fakes at those boundaries and remains hardware-independent.

## Decision

Use the repository's existing native tooling. Add a small Python development
requirements file, pytest configuration, an npm command, and a dedicated
GitHub Actions job. Refactor only the vision service's construction boundary so
importing it is pure.

Alternatives considered:

1. A locked `uv` environment would make dependency resolution more exact, but
   adds a tool that neither the repository nor the board currently needs.
2. A container would provide a controlled Linux userland, but slows the normal
   macOS workflow and still cannot reproduce camera or BPU hardware.

## Runtime isolation

### Configuration

Introduce an immutable `VisionConfig` in `rdk/vision/service.py`. A pure
`from_env` constructor reads the current settings and retains their production
defaults:

- control socket and gallery/corpus paths;
- gallery space floor and preview port;
- front and rear MIPI channels;
- ADAS shadow and frame-sharing gates.

Invalid integer settings continue to fail fast. Parsing configuration must not
create directories, inspect the camera bus, start threads, or import board-only
libraries.

### Runtime

Introduce a `VisionRuntime` value containing the `Gallery`, `CameraPair`,
`EventBus`, and RPC handler mapping. `build_runtime(config)` constructs those
objects. This function may create the configured gallery directory, so only
`main()` and tests supplying a temporary directory call it.

`ControlServer` receives a runtime explicitly, and `ControlHandler` obtains the
event bus and handler mapping from its server. There will be no module-global
production gallery, camera pair, event bus, or handler mapping. Each server and
test therefore owns its state, and concurrent test runs cannot broadcast into
one another.

`main()` performs the production sequence:

1. Parse `VisionConfig`.
2. Build `VisionRuntime`.
3. Prepare the socket and reconcile the gallery.
4. Open and validate cameras.
5. Start monitoring, preview, and optional shadow ADAS.
6. Serve control requests.
7. Finalize the same runtime's cameras, gallery, and ride on shutdown.

The existing systemd retry behavior, fail-loud camera policy, consent gate,
socket permissions, shutdown cleanup, and production defaults do not change.

## Developer test contract

Add `rdk/vision/requirements-dev.txt` with versions verified on Python 3.10:

- `pytest==8.3.5`;
- `numpy==1.26.4`, matching the board;
- `opencv-python-headless==4.10.0.84`.

FFmpeg and `ffprobe` remain system prerequisites because the clip tests exercise
the real executables. The README will name the macOS Homebrew and Ubuntu apt
installation commands.

Add `rdk/vision/pytest.ini` with the test path and a registered `hardware`
marker. The shared command enables strict markers and excludes hardware tests:

```bash
npm run test:rdk-vision
```

The package script expands to the repository-root-safe equivalent of:

```bash
python3 -m pytest -c rdk/vision/pytest.ini \
  -m "not hardware" --strict-markers rdk/vision/tests
```

Software dependencies are mandatory. Missing pytest, NumPy, OpenCV, FFmpeg, or
`ffprobe` fails with the dependency's direct error; the suite must not silently
skip ordinary coverage. Only tests decorated with `@pytest.mark.hardware` are
excluded. The marker is available for future camera/BPU tests, but no current
mock-backed test will be reclassified as hardware-dependent.

The command remains separate from `npm run check` initially. That preserves the
current web/relay developer workflow for contributors who have not created a
Python virtual environment, while both commands are mandatory, separate CI
jobs.

## Continuous integration

Add an `rdk-vision` job to `.github/workflows/ci.yml` that:

1. checks out the repository;
2. installs Python 3.10 and enables pip caching for
   `rdk/vision/requirements-dev.txt`;
3. installs Node 22 so CI invokes the same npm command as developers;
4. installs FFmpeg through apt;
5. installs the Python development requirements; and
6. runs `npm run test:rdk-vision`.

This job is independent of the existing web/relay, Android, and iOS jobs. A
Python failure is visible as its own required signal and cannot be hidden by an
unrelated platform result.

## Tests

Add focused regression coverage for the new boundary:

- importing `service.py` does not create production directories or construct a
  gallery/camera runtime;
- configuration defaults exactly match today's service defaults;
- environment overrides and exact-string feature gates are preserved;
- invalid numeric configuration fails clearly;
- runtime construction uses the configured gallery path and camera channels;
- two control servers use their own event buses and handler mappings;
- concurrent RPC responses and hazard broadcasts remain valid, separate NDJSON
  lines;
- shutdown finalization still finishes a recording, stops a ride, and releases
  cameras.

Existing tests may receive fixture-only changes needed to pass a runtime into
`ControlServer`. Their behavioral assertions do not weaken. The existing RDK
TypeScript suite also runs during verification to catch cross-boundary
regressions.

## Documentation

Update `rdk/README.md` to replace the board-only Python test statement with:

- Python 3.10 and FFmpeg prerequisites for macOS and Ubuntu;
- virtual-environment creation and development dependency installation;
- the single `npm run test:rdk-vision` command;
- the board command for the same hardware-independent suite; and
- a clear statement that real camera/BPU validation remains in the on-hardware
  checklist and dedicated tools.

## Acceptance criteria

1. `npm run test:rdk-vision` passes from the repository root on a provisioned
   macOS developer machine, Ubuntu GitHub runner, and the RDK board.
2. The off-board command neither reads nor writes `/var/lib/max` or `/run/max`
   and never opens a camera or imports a BPU runtime.
3. Pytest rejects unknown markers and excludes only explicit `hardware` tests.
4. The dedicated `rdk-vision` GitHub Actions job uses the same npm command.
5. Existing Python behavior tests and all TypeScript RDK tests pass.
6. Starting `max-vision.service` retains its current paths, feature gates,
   camera retry behavior, control protocol, and shutdown semantics.
