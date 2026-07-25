"""Record a ride. Runs on the board.

    python3 -m tools.record_ride --root /var/lib/max/corpus --fps 10

Two frame sources:

* ``mipi_cam`` (default) — drives the vendor's ROS node, which demonstrably
  streams. Writes ``.mjpeg`` segments.
* ``binding`` — our ctypes ``hbn_camera_create`` path plus the hardware H.264
  encoder. Writes ``.h264`` segments. Does not open a camera yet: create still
  returns -1 with a matching sensor and the correct VCON. Kept so the switch is
  a flag flip once that is solved.

Front camera is VCON 2 and rear is VCON 3 (VCON 0/1 have no connector on this
board). A camera that will not open is logged and skipped — front-only rides are
expected on current hardware.
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
    open_camera(build_config(IMX219, vcon=slot.vcon, width=WIDTH, height=HEIGHT, fps=30))
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


def _make_mipi_opener(sensor: str):
    def _open_mipi(slot: CameraSlot):
        from recorder.mipi_source import MipiCamSource  # noqa: PLC0415

        source = MipiCamSource(channel=slot.vcon, sensor=sensor, width=WIDTH, height=HEIGHT)
        source.start()
        return source

    return _open_mipi


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="/var/lib/max/corpus")
    parser.add_argument("--fps", type=float, default=10.0)
    parser.add_argument("--source", choices=("mipi_cam", "binding"), default="mipi_cam")
    parser.add_argument("--front-vcon", type=int, default=2)
    parser.add_argument("--rear-vcon", type=int, default=3)
    parser.add_argument("--sensor", default="IMX219", help="mipi_cam video_device name, e.g. IMX219 or OV5647")
    args = parser.parse_args()

    if args.source == "mipi_cam":
        from recorder.mipi_source import write_jpeg  # noqa: PLC0415

        open_fn, encode_fn, suffix = _make_mipi_opener(args.sensor), write_jpeg, ".mjpeg"
    else:
        open_fn, encode_fn, suffix = _open_binding, _encode_binding, ".h264"

    recorder = RideRecorder(
        root=args.root,
        slots=[CameraSlot("front", args.front_vcon), CameraSlot("rear", args.rear_vcon)],
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
