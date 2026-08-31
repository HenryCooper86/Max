"""Prove the anchor table is right before trusting anything built on it.

If ANCHORS is wrong, boxes land in plausible-looking wrong places: the pipeline
runs, detections appear, and every TTC number is quietly garbage. bus.jpg is a
COCO image shipped on the board containing a large bus and several people —
exactly the classes the helmet cares about — so a correct decode is obvious and
a wrong one is unmissable.

    python3 tools/check_anchors.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from perception.detector import Detector

IMAGE = "/app/pydev_demo/03_instance_segmentation_sample/02_ultralytics_yolo11_seg/bus.jpg"
MODEL = "/app/multimedia_samples/sunrise_camera/Platform/x5/model_zoom/yolov5s_672x672_nv12.bin"


def jpeg_to_nv12(path: str) -> tuple[bytes, int, int]:
    probe = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path,
        ],
        capture_output=True,
        check=True,
    )
    w, h = (int(v) for v in probe.stdout.decode().strip().split("x"))
    w -= w % 2
    h -= h % 2
    raw = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={w}:{h}",
            "-pix_fmt", "nv12", "-f", "rawvideo", "-",
        ],
        capture_output=True,
        check=True,
    )
    return raw.stdout, w, h


def main() -> None:
    nv12, w, h = jpeg_to_nv12(IMAGE)
    dets = Detector(MODEL).infer(nv12, w, h)

    print(f"{IMAGE}  {w}x{h}  -> {len(dets)} detections")
    for d in sorted(dets, key=lambda d: -d.score):
        print(
            f"  {d.cls:11s} {d.score:.2f}  "
            f"x[{d.x1:.3f},{d.x2:.3f}] y[{d.y1:.3f},{d.y2:.3f}]"
        )

    buses = [d for d in dets if d.cls == "bus"]
    people = [d for d in dets if d.cls == "person"]

    problems = []
    if not buses:
        problems.append("no bus found — anchors or class map are wrong")
    else:
        bus = max(buses, key=lambda d: d.width * d.height)
        # The bus spans nearly the full width of this shot. Height is not
        # checked: bus.jpg is portrait (810x1080) and the lower third is road,
        # so a correct bus box covers well under half the frame vertically.
        if bus.width < 0.5:
            problems.append(f"bus box only {bus.width:.2f} wide — decode is wrong")

    if len(people) < 2:
        problems.append(f"expected several people, found {len(people)}")

    # The sharpest test of anchor correctness available without ground truth.
    # Anchor priors are what set box dimensions, so a wrong table distorts the
    # aspect ratio: a standing person is roughly 1:2 to 1:5 tall-to-wide, and
    # mis-decoded boxes come out square or wildly elongated even when their
    # centres look plausible.
    for person in people:
        if person.width <= 0:
            problems.append("person box has non-positive width — decode is wrong")
            continue
        ratio = person.height / person.width
        if not 1.2 <= ratio <= 6.0:
            problems.append(
                f"person box aspect {ratio:.1f}:1 is not human-shaped — anchors are wrong"
            )

    for det in dets:
        if not (0.0 <= det.x1 < det.x2 <= 1.0 and 0.0 <= det.y1 < det.y2 <= 1.0):
            problems.append(
                f"{det.cls} box outside the frame — letterbox mapping is wrong"
            )

    if problems:
        for p in problems:
            print(f"FAIL: {p}")
        raise SystemExit(1)
    print("OK: anchors and letterbox geometry validated")


if __name__ == "__main__":
    main()
