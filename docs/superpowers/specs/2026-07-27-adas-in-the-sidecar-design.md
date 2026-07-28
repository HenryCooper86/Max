# ADAS in the Sidecar — Wiring the Shadow Runtime to a Live Camera

## Summary

`start_adas` has never had a caller. It is defined in `rdk/vision/service.py`,
exercised by four tests, and invoked by nothing in `main()`. The M2 spec says the
ADAS loop "runs **inside the vision sidecar**, on its own thread per camera" —
that thread is never started.

This spec wires it up. The sidecar gains a **ride**: starting one begins
continuous segment recording _and_ the ADAS threads together, so shadow mode
cannot run without the evidence it requires.

Parent: `docs/superpowers/specs/2026-07-26-adas-m2-ride-design.md`.
Depends on: `docs/superpowers/specs/2026-07-27-rdk-cam1-live-design.md`, which
made the camera openable at all.

## Why this is not a one-line call

Three things block a naive `start_adas(...)` in `main()`. Each would produce
working-looking code that lies.

### 1. Shadow mode requires a recorder, and the recorder cannot run

`run_camera` raises `RecordingRequired` unless `config.recording`. That is
deliberate — M2: _"If recording is off, the runtime refuses to start rather than
degrading to alerts-without-evidence."_

Evidence comes from M0's continuous segments, written by `tools/record_ride.py`
— **a separate process**. The board permits exactly one holder of the ISP, so
`record_ride.py` and `max-vision` cannot both have the camera. The conflict was
invisible until 2026-07-27 because nothing could open a camera at all.

So if ADAS runs in the sidecar, **the sidecar must do the recording**. That is
not a preference; it is the only arrangement the hardware allows.

### 2. There is nowhere for `emit` to send

`ControlHandler` writes replies to the connection that made the request. There is
no registry of connected clients, so an ADAS thread has no way to push an
unsolicited `event` line. `rpc.encode_event` exists and `agent/src/vision-client.ts`
documents the channel in its module docstring — the server half was never built.

### 3. The segment names would name nothing

`RuntimeConfig.segment_pattern` defaults to `{camera}_{index:06d}.h264`. The
recorder writes `<ride>/front/seg-000000.mjpeg` (`segmenter.segment_name`, plus
the `.mjpeg` suffix the mipi_cam path produces). Every shadow record would cite a
file that does not exist and `tools/clip.py` would find nothing.

This is the same defect just removed from `camera.record`, which named a
`front.h264` no code ever wrote. Shipping it again in the evidence path — the one
place M2 argues most strongly about — would be worse.

## Architecture

A `RideSession` owns recording and ADAS as one unit.

```text
rdk/vision/
  ride.py              NEW — RideSession: recorder + one ADAS thread per camera
  events.py            NEW — connected-client registry; the push half of the socket
  service.py           registers clients, starts/stops the ride
```

Because the recorder and the ADAS threads start together and stop together,
"shadow mode requires recording" is enforced **by construction**. There is no
flag to misconfigure and no order of operations to get wrong.

### Sharing the camera

Recording and ADAS read the shared `FrameBuffer` independently: the recorder
ticks at 10 fps writing JPEG segments, ADAS consumes `MipiCamera.frames(fps=10)`.
Neither `run_camera` nor `RideRecorder` changes.

A single loop fanning one frame out to both was considered. It would guarantee
the shadow record names the byte-identical frame that fired, but needs a
queue-backed source and leaves `run_camera` restructured. The cost of not doing
it is that the two loops may drift by up to one frame — about 100 ms, inside a
±5 s clip window. Not worth the coupling.

### Timestamp rebase

`run_camera` derives `segment_index` from `frame.t_ms / 1000 / segment_seconds`,
which assumes `t_ms` starts near zero at ride start. `FileSource` satisfies that;
a live camera does not. Live frames carry the ROS header stamp — **board uptime**,
measured at 2,992,848 ms on 2026-07-27. Unrebased, every shadow record would cite
segment ~49,880.

A `RebasedSource` wrapper subtracts the ride's first timestamp and yields
otherwise-identical `Frame`s. `MipiCamera` keeps reporting absolute capture time,
which is what every other consumer wants.

### Data flow

```text
MipiCamera (shared FrameBuffer)
   |-- RideRecorder tick @10fps -> <corpus>/<ride>/<camera>/seg-NNNNNN.mjpeg
   `-- RebasedSource -> run_camera -> ShadowLog  (always)
                                   `-> emit -> events.broadcast -> agent socket
```

## Configuration

| Variable          | Default                                                                                  | Meaning                       |
| ----------------- | ---------------------------------------------------------------------------------------- | ----------------------------- |
| `MAX_ADAS_SHADOW` | `0`                                                                                      | Start a ride at service start |
| `MAX_CORPUS_DIR`  | `/var/lib/max/corpus`                                                                    | Segment root, matching M0     |
| `MAX_ADAS_MODEL`  | `/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/yolov5s_672x672_nv12.bin` | BPU model                     |

Only the exact string `1` enables `MAX_ADAS_SHADOW`, matching how
`MAX_RELAY_INSECURE_TLS` is read. Default off: nothing changes until opted in.

`MAX_ADAS_AUDIO` is **not touched and stays `0`**. This work makes no sound.
Arming remains a human decision against shadow numbers meeting the M1 gate.

`segment_pattern` becomes `{camera}/seg-{index:06d}.mjpeg`, matching what the
recorder writes, so a shadow record resolves to a real path under the ride
directory.

## Failure behaviour

Follows M2's table.

| Failure                    | Behaviour                                                   |
| -------------------------- | ----------------------------------------------------------- |
| A camera never opens       | No thread for it; the other camera continues                |
| No camera opens            | No ride starts; preview and gallery still serve             |
| BPU fault in a thread      | Logs and exits, no auto-restart; other camera unaffected    |
| Free space below the floor | The ride stops — no alerts whose evidence cannot be written |
| A socket client disappears | Dropped from the registry; broadcast continues              |
| Sidecar dies               | Agent already treats it as optional and reconnects          |

None of it can reach the voice path: that is a different process.

The disk floor reuses `MAX_GALLERY_MIN_FREE_MB`, already read by `Gallery`, but
is checked against **`MAX_CORPUS_DIR`** — that is where segments land, and it is
the filesystem that fills. Segments at 1080p mjpeg are large: the measured
gallery rate was ~3 MB/s, so a half-hour ride is ~5 GB. The floor is
load-bearing, not decorative.

## Testing

**Unit, no hardware**, following `rdk/vision/tests/`:

- event registry: broadcasts to every client; a client whose write raises is
  dropped and does not stop delivery to the others
- rebase: first frame becomes `t_ms=0`; later frames keep their spacing; the
  wrapper passes `nv12`, `camera`, `width`, `height` through untouched
- ride lifecycle: start opens a recorder and one thread per open camera; start
  with no cameras is a no-op; stop joins threads and closes the recorder
- **segment pattern resolves to a path the recorder actually wrote** — the test
  that catches naming drift, and the one that would have caught defect 3

**On the board:**

- enable `MAX_ADAS_SHADOW=1`, confirm segments accumulate under the ride dir
- confirm a hazard event reaches a connected socket client
- confirm the shadow log's `segment` field names a file that exists on disk
- **watch temperature.** M1 measured 52.4 ms/frame and a ~90 °C plateau under
  two-camera load. ADAS plus a JPEG segment stream is new thermal territory, so
  this is a measurement, not an assumption.

## Out of scope

- Arming audio. `MAX_ADAS_AUDIO` stays `0`.
- Voice- or RPC-triggered rides. The env gate is the only control surface.
- Tuning suppression constants; M1's remain untuned.
- Retiring `tools/record_ride.py`. It still serves a board with the sidecar
  stopped, and it is how the existing corpus was made.
