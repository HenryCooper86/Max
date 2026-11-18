#!/usr/bin/env python3
"""
Turns green-screen footage of a creature into Max's character files, the way the
hummingbird was made: a transparent looping video, an animated picture for phones
and Safari, and a still.

    python3 scripts/cut-out-character.py clip.mp4 --start 2 --end 5 --name bee --flip

writes public/character/<name>.webm (VP9 with alpha, 660 x 480, 30 fps),
<name>.webp (animated, 462 x 336) and <name>.png (still). The creature is tracked
in every frame and kept in the same place as the hummingbird, at the same size,
so it hovers rather than wanders. --ping-pong plays the stretch forwards then
backwards, which makes any hovering stretch loop without a jump.

Needs ffmpeg, img2webp (libwebp) and numpy.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

OUT_W, OUT_H = 660, 480
PICTURE_W, PICTURE_H = 462, 336
FPS = 30
# Where the hummingbird sits in its frame, and how tall it is: the others match it.
CENTER = (422, 341)


def read_frames(path: Path, start: float, end: float) -> np.ndarray:
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout.strip().split(",")
    width, height = int(probe[0]), int(probe[1])
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(start), "-to", str(end), "-i", str(path),
         "-r", str(FPS), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.uint8).reshape(-1, height, width, 3)


def key(frame: np.ndarray, low: float, high: float) -> np.ndarray:
    """RGBA with the green screen made transparent and green spill removed from the edges."""
    rgb = frame.astype(np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    dominance = g - np.maximum(r, b)
    alpha = 1.0 - np.clip((dominance - low) / (high - low), 0.0, 1.0)
    # Spill: no pixel may be greener than its red or blue allows.
    g = np.minimum(g, np.maximum(r, b))
    out = np.dstack([r, g, b, alpha * 255.0])
    return np.clip(out, 0, 255).astype(np.uint8)


def smooth(values: np.ndarray, window: int) -> np.ndarray:
    if window <= 1:
        return values
    padded = np.pad(values, (window // 2, window - 1 - window // 2), mode="edge")
    return np.convolve(padded, np.ones(window) / window, mode="valid")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("clip", type=Path)
    parser.add_argument("--start", type=float, required=True, help="Seconds into the clip.")
    parser.add_argument("--end", type=float, required=True)
    parser.add_argument("--name", required=True, help="File name in public/character.")
    parser.add_argument("--flip", action="store_true", help="Mirror it: characters face right.")
    parser.add_argument("--ping-pong", action="store_true", help="Forwards then backwards, for a seamless loop.")
    parser.add_argument("--height", type=float, default=215, help="Its height in the 660 x 480 frame (hummingbird: 215).")
    parser.add_argument("--steady", type=int, default=15, help="Frames over which drift is smoothed away.")
    parser.add_argument("--low", type=float, default=22, help="Green dominance where transparency starts.")
    parser.add_argument("--high", type=float, default=70, help="Green dominance that is fully transparent.")
    parser.add_argument("--out", type=Path, default=Path("public/character"))
    args = parser.parse_args()

    frames = read_frames(args.clip, args.start, args.end)
    keyed = [key(frame, args.low, args.high) for frame in frames]
    boxes = []
    for rgba in keyed:
        ys, xs = np.nonzero(rgba[..., 3] > 128)
        boxes.append((xs.mean(), ys.mean(), ys.max() - ys.min()))
    cx = smooth(np.array([box[0] for box in boxes]), args.steady)
    cy = smooth(np.array([box[1] for box in boxes]), args.steady)
    scale = args.height / float(np.median([box[2] for box in boxes]))
    crop_w, crop_h = round(OUT_W / scale), round(OUT_H / scale)

    work = Path(tempfile.mkdtemp(prefix=f"character-{args.name}-"))
    try:
        cropped: list[np.ndarray] = []
        height, width = frames.shape[1:3]
        for index, rgba in enumerate(keyed):
            left = round(cx[index] - CENTER[0] / scale)
            top = round(cy[index] - CENTER[1] / scale)
            canvas = np.zeros((crop_h, crop_w, 4), dtype=np.uint8)
            x0, y0 = max(0, left), max(0, top)
            x1, y1 = min(width, left + crop_w), min(height, top + crop_h)
            if x1 > x0 and y1 > y0:
                canvas[y0 - top:y1 - top, x0 - left:x1 - left] = rgba[y0:y1, x0:x1]
            cropped.append(canvas[:, ::-1] if args.flip else canvas)
        if args.ping_pong:
            cropped = cropped + cropped[-2:0:-1]
        raw = b"".join(frame.tobytes() for frame in cropped)
        source = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{crop_w}x{crop_h}", "-r", str(FPS), "-i", "-"]
        args.out.mkdir(parents=True, exist_ok=True)
        webm = args.out / f"{args.name}.webm"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", *source, "-vf", f"scale={OUT_W}:{OUT_H}:flags=lanczos",
             "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "36", "-row-mt", "1",
             "-auto-alt-ref", "0", "-metadata:s:v:0", "alpha_mode=1", str(webm)],
            input=raw, check=True,
        )
        middle = len(cropped) // 4
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{crop_w}x{crop_h}", "-i", "-",
             "-vf", f"scale={OUT_W}:{OUT_H}:flags=lanczos", "-frames:v", "1", str(args.out / f"{args.name}.png")],
            input=cropped[middle].tobytes(), check=True,
        )
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", *source, "-vf", f"scale={PICTURE_W}:{PICTURE_H}:flags=lanczos",
             str(work / "f%04d.png")],
            input=raw, check=True,
        )
        pictures = sorted(str(path) for path in work.glob("f*.png"))
        subprocess.run(
            ["img2webp", "-loop", "0", "-lossy", "-q", "55", "-m", "6", "-d", str(round(1000 / FPS)), *pictures,
             "-o", str(args.out / f"{args.name}.webp")],
            check=True, capture_output=True,
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)
    for suffix in ("webm", "webp", "png"):
        path = args.out / f"{args.name}.{suffix}"
        print(f"{path}  {path.stat().st_size // 1024} KB")
    print(f"{len(cropped)} frames, {len(cropped) / FPS:.2f} s, scale {scale:.2f}")


if __name__ == "__main__":
    main()
