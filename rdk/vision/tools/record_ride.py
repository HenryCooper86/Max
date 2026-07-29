"""Record a ride. Runs on the board.

    python3 -m tools.record_ride --root /var/lib/max/corpus --fps 10

Two frame sources:

* ``mipi_cam`` (default) — drives the vendor's ROS node, which demonstrably
  streams. Writes ``.mjpeg`` segments.
* ``binding`` — our ctypes ``hbn_camera_create`` path plus the hardware H.264
  encoder. Writes ``.h264`` segments. Does not open a camera yet: create still
  returns -1 with a matching sensor and the correct VCON. Kept so the switch is
  a flag flip once that is solved.

Front is MIPI channel 0 (the CAM1 connector, i2c bus 6) and rear is channel 2
(the other connector, bus 4). The sensor on each is discovered, not configured.
A camera that will not open is logged and skipped — front-only rides are
expected on current hardware, which has one module.
"""

from __future__ import annotations

import argparse
import signal
import time
from pathlib import Path

from recorder.session import CameraSlot, RideRecorder

WIDTH = 1920
HEIGHT = 1080
H264 = 1


def _open_binding(slot: CameraSlot):
    from camera_binding import IMX219, build_config, open_camera  # noqa: PLC0415
    from hobot_vio import libsrcampy  # noqa: PLC0415

    # Never open_cam(-1): that auto-detect crashes cam-service. Pin the VCON.
    open_camera(build_config(IMX219, vcon=slot.channel, width=WIDTH, height=HEIGHT, fps=30))
    camera = libsrcampy.Camera()
    encoder = libsrcampy.Encoder()
    encoder.encode(0, H264, WIDTH, HEIGHT)
    return (camera, encoder)


def _encode_binding(handle, out_path: Path) -> None:
    camera, encoder = handle
    frame = camera.get_img(2)
    if frame is None:
        raise RuntimeError("no frame")
    encoder.encode_file(frame)
    chunk = encoder.get_img()
    if chunk:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("ab") as fh:
            fh.write(chunk)


def _open_mipi(slot: CameraSlot):
    from mipi_camera import MipiCamera  # noqa: PLC0415
    from sensors import discover  # noqa: PLC0415

    sensor = discover().get(slot.channel)
    if sensor is None:
        raise RuntimeError(f"no camera on channel {slot.channel}")
    camera = MipiCamera(
        channel=slot.channel, sensor=sensor, camera=slot.name, width=WIDTH, height=HEIGHT
    )
    camera.start()
    return camera


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="/var/lib/max/corpus")
    parser.add_argument("--fps", type=float, default=10.0)
    parser.add_argument("--source", choices=("mipi_cam", "binding"), default="mipi_cam")
    parser.add_argument("--front-channel", type=int, default=0)
    parser.add_argument("--rear-channel", type=int, default=2)
    parser.add_argument(
        "--skip-preflight",
        action="store_true",
        help="record even when no camera answers on either bus",
    )
    args = parser.parse_args()

    if args.source == "mipi_cam":
        from mipi_camera import reap_orphans  # noqa: PLC0415
        from recorder.mipi_source import write_jpeg  # noqa: PLC0415

        # Once per acquisition, before RideRecorder.start() opens front then
        # rear — a per-camera reap would SIGKILL the front camera's mipi_cam
        # while starting the rear one.
        reap_orphans()
        open_fn, encode_fn, suffix = _open_mipi, write_jpeg, ".mjpeg"
    else:
        open_fn, encode_fn, suffix = _open_binding, _encode_binding, ".h264"

    if not args.skip_preflight:
        from sensors import UnsupportedSensor, preflight  # noqa: PLC0415

        try:
            preflight()
        except UnsupportedSensor as error:
            # Fail in a second with a specific reason, rather than after a 5 s
            # ISP timeout that points at the wrong layer.
            raise SystemExit(f"[recorder] {error}") from None

    recorder = RideRecorder(
        root=args.root,
        slots=[CameraSlot("front", args.front_channel), CameraSlot("rear", args.rear_channel)],
        open_fn=open_fn,
        encode_fn=encode_fn,
        video_suffix=suffix,
    )
    try:
        ride = recorder.start(now_wall_ms=int(time.time() * 1000))
    except RuntimeError as error:
        # No camera attached is an ordinary operator mistake, not a crash.
        raise SystemExit(f"[recorder] {error}. Check the ribbon and try `i2cdetect -y -r 4`.") from None
    print(f"[recorder] recording {ride} from {recorder.active_cameras}")

    running = True

    def stop(*_args) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    period = 1.0 / args.fps
    started = time.monotonic()
    try:
        while running:
            now = time.monotonic()
            if recorder.tick(now - started, int(time.time() * 1000)) == 0:
                print("[recorder] all cameras gone; stopping")
                break
            time.sleep(max(0.0, period - (time.monotonic() - now)))
    finally:
        for handle in list(recorder._cameras.values()):
            stop_fn = getattr(handle, "stop", None)
            if callable(stop_fn):
                stop_fn()  # tears down the mipi_cam process and rclpy node
        recorder.stop()
        print(f"[recorder] finished {ride}")


if __name__ == "__main__":
    main()
