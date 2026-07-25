"""Record a ride. Runs on the board.

    python3 -m tools.record_ride --root /var/lib/max/corpus --fps 10

Front camera is VCON 2 and rear is VCON 3 (VCON 0/1 have no connector on this
board). A camera that will not open is logged and skipped — front-only rides are
expected on current hardware.
"""

from __future__ import annotations

import argparse
import signal
import time
from pathlib import Path

from camera_binding import IMX219, build_config, open_camera
from hobot_vio import libsrcampy
from recorder.session import CameraSlot, RideRecorder

WIDTH = 1920
HEIGHT = 1080
H264 = 1


def _open(slot: CameraSlot):
    # Never open_cam(-1): that auto-detect crashes cam-service. Pin the VCON.
    open_camera(build_config(IMX219, vcon=slot.vcon, width=WIDTH, height=HEIGHT, fps=30))
    camera = libsrcampy.Camera()
    encoder = libsrcampy.Encoder()
    encoder.encode(0, H264, WIDTH, HEIGHT)
    return (camera, encoder)


def _encode(handle, out_path: Path) -> None:
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="/var/lib/max/corpus")
    parser.add_argument("--fps", type=float, default=10.0)
    args = parser.parse_args()

    recorder = RideRecorder(
        root=args.root,
        slots=[CameraSlot("front", 2), CameraSlot("rear", 3)],
        open_fn=_open,
        encode_fn=_encode,
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
        recorder.stop()
        print(f"[recorder] finished {ride}")


if __name__ == "__main__":
    main()
