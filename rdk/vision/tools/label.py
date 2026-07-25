"""Label hazard windows on a recorded ride. Runs on a laptop, not the board.

    python3 -m tools.label list  --root ./corpus
    python3 -m tools.label show  --ride ./corpus/ride-20260725-141900
    python3 -m tools.label add   --ride ./corpus/ride-20260725-141900 \
        rear_approach:rear:12000:15000:"car closed fast"

Windows are millisecond offsets from the start of the ride, matching the
`wall_ms` in each segment's metadata sidecar.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from corpus.labels import HazardWindow, LabelError, read_labels, write_labels
from corpus.library import scan_corpus, scan_ride


def parse_window_arg(text: str) -> HazardWindow:
    """`threat:camera:start_ms:end_ms[:note]`"""
    parts = text.split(":", 4)
    if len(parts) < 4:
        raise LabelError(f"expected threat:camera:start_ms:end_ms[:note], got {text!r}")
    threat, camera, start, end = parts[0], parts[1], parts[2], parts[3]
    try:
        start_ms, end_ms = int(start), int(end)
    except ValueError as error:
        raise LabelError(f"start and end must be integer milliseconds: {text!r}") from error
    return HazardWindow(
        threat=threat, camera=camera, start_ms=start_ms, end_ms=end_ms, note=parts[4] if len(parts) > 4 else ""
    )


def add_window(ride_dir: Path | str, window: HazardWindow) -> list[HazardWindow]:
    """Append and re-persist. write_labels validates and merges, so a repeated
    label of the same event does not inflate the hazard count."""
    windows = read_labels(ride_dir) + [window]
    write_labels(ride_dir, windows)
    return read_labels(ride_dir)


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    listing = sub.add_parser("list")
    listing.add_argument("--root", required=True)

    show = sub.add_parser("show")
    show.add_argument("--ride", required=True)

    adder = sub.add_parser("add")
    adder.add_argument("--ride", required=True)
    adder.add_argument("windows", nargs="+")

    args = parser.parse_args()

    if args.command == "list":
        for ride in scan_corpus(args.root):
            mark = "labelled" if ride.labelled else "unlabelled"
            frames = sum(s.frame_count for s in ride.segments)
            print(
                f"{ride.ride}  {','.join(ride.cameras):12}  {len(ride.segments):3} segs  {frames:6} frames  {mark}"
            )
        return

    if args.command == "show":
        info = scan_ride(args.ride)
        print(f"{info.ride}  cameras={','.join(info.cameras)}  segments={len(info.segments)}")
        for window in read_labels(args.ride):
            note = f"  # {window.note}" if window.note else ""
            print(f"  {window.threat:20} {window.camera:6} {window.start_ms:>8}..{window.end_ms:<8}{note}")
        return

    try:
        for raw in args.windows:
            add_window(args.ride, parse_window_arg(raw))
    except LabelError as error:
        raise SystemExit(f"[label] {error}") from None
    print(f"{len(read_labels(args.ride))} window(s) on {args.ride}")


if __name__ == "__main__":
    main()
