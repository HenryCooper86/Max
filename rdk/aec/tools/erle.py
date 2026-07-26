"""Measure echo cancellation offline, in dB, against known ground truth.

The 2026-07-25 AEC spike compared a sweep's RMS against a noise floor, concluded
"gate passed", and was wrong — a live conversation looped immediately. This
harness cannot flatter itself the same way: it synthesises the echo, so it knows
exactly what should have been removed.

    python3 tools/erle.py --bin ./max-aec --delay-ms 160
"""

from __future__ import annotations

import argparse
import math
import struct
import subprocess
import wave
from pathlib import Path

RATE = 16000


def write_wav(path: Path, samples: list[int]) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", max(-32768, min(32767, s))) for s in samples))


def read_wav(path: Path) -> list[int]:
    with wave.open(str(path)) as w:
        raw = w.readframes(w.getnframes())
    return list(struct.unpack(f"<{len(raw) // 2}h", raw))


def rms(samples: list[int]) -> float:
    if not samples:
        return 0.0
    return math.sqrt(sum(float(s) * s for s in samples) / len(samples))


def tone(freq: float, n: int, amp: float) -> list[int]:
    return [int(amp * 32767 * math.sin(2 * math.pi * freq * i / RATE)) for i in range(n)]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", default="./max-aec")
    parser.add_argument("--delay-ms", type=int, default=160, help="delay hint given to APM")
    parser.add_argument(
        "--echo-delay-ms",
        type=int,
        default=None,
        help="true delay of the synthetic echo; defaults to --delay-ms. Set it "
        "differently to test how APM copes when the hint is wrong, which is the "
        "case that actually matters on hardware.",
    )
    parser.add_argument("--echo-gain", type=float, default=0.5)
    parser.add_argument("--suppression", type=int, default=0, choices=[0, 1, 2])
    parser.add_argument("--seconds", type=float, default=6.0)
    parser.add_argument("--min-erle-db", type=float, default=12.0)
    parser.add_argument("--max-near-loss-db", type=float, default=10.0)
    parser.add_argument(
        "--max-duplex-loss-db",
        type=float,
        default=15.0,
        help="how much of the rider may be lost while Max is talking. This is "
        "the barge-in gate: a high ERLE means nothing if double-talk is muted.",
    )
    args = parser.parse_args()

    echo_delay_ms = args.echo_delay_ms if args.echo_delay_ms is not None else args.delay_ms
    n = int(RATE * args.seconds)
    delay = int(RATE * echo_delay_ms / 1000)
    tmp = Path("/tmp/erle")
    tmp.mkdir(exist_ok=True)

    reference = tone(440.0, n, 0.5)
    silence = [0] * n
    # Near-end stand-in for the rider. Amplitude-modulated so WebRTC's noise
    # suppressor treats it as speech-like rather than stationary noise — a plain
    # tone gets eaten by NS and inflates any "suppression" figure.
    near = [
        int(0.15 * 32767 * math.sin(2 * math.pi * 300 * i / RATE) * (0.5 + 0.5 * math.sin(2 * math.pi * 3 * i / RATE)))
        for i in range(n)
    ]

    def run(mic: list[int], tag: str) -> list[int]:
        write_wav(tmp / "ref.wav", reference)
        write_wav(tmp / f"mic_{tag}.wav", mic)
        subprocess.run(
            [args.bin, "--offline", str(tmp / "ref.wav"), str(tmp / f"mic_{tag}.wav"),
             str(tmp / f"out_{tag}.wav"), "--delay-ms", str(args.delay_ms),
             "--suppression", str(args.suppression)],
            check=True,
            stderr=subprocess.DEVNULL,
        )
        return read_wav(tmp / f"out_{tag}.wav")

    def echoed(base: list[int]) -> list[int]:
        out = []
        for i in range(n):
            echo = reference[i - delay] * args.echo_gain if i >= delay else 0.0
            out.append(int(echo + base[i]))
        return out

    skip = RATE  # the adaptive filter needs time to converge

    # ERLE proper: echo only, no near end. This is the number that means
    # "how much of Max's own voice was removed".
    echo_only = echoed(silence)
    cleaned_echo = run(echo_only, "echo")
    before = rms(echo_only[skip:])
    after = rms(cleaned_echo[skip:]) if len(cleaned_echo) > skip else 0.0
    erle = 20 * math.log10(max(before, 1e-9) / max(after, 1e-9))

    # Near-end preservation: rider only, no echo. A canceller that also destroys
    # the rider's voice is useless, and a single "suppression" number hides that.
    cleaned_near = run(near, "near")
    near_before = rms(near[skip:])
    near_after = rms(cleaned_near[skip:]) if len(cleaned_near) > skip else 0.0
    near_loss = 20 * math.log10(max(near_before, 1e-9) / max(near_after, 1e-9))

    # Double-talk: echo AND rider at once. This is barge-in. The echo-only case
    # above shows APM happily gating its output to digital silence, which scores
    # a superb ERLE and would still break barge-in if it does the same here —
    # so measure how much of the rider survives while Max is talking over him.
    # Residual echo inflates this slightly, but it sits ~30 dB down, so the
    # figure is dominated by the rider.
    cleaned_both = run(echoed(near), "both")
    both_after = rms(cleaned_both[skip:]) if len(cleaned_both) > skip else 0.0
    duplex_loss = 20 * math.log10(max(near_before, 1e-9) / max(both_after, 1e-9))

    print(f"  echo gain     : {args.echo_gain}")
    print(f"  true delay    : {echo_delay_ms} ms")
    print(f"  hint to APM   : {args.delay_ms} ms")
    # With --echo-gain 0 there is no echo to remove and the "echo only" mic is
    # just silence, so the ratio is undefined. Say so instead of scoring it.
    if before < 1.0:
        print("  ERLE          : no echo in fixture — control case, undefined")
    elif after < 1.0:
        print(f"  ERLE          : output digitally silent (>= 40 dB)  [want >= {args.min_erle_db}]")
    else:
        print(f"  ERLE          : {erle:.1f} dB  (echo only; want >= {args.min_erle_db})")
    # Negative means AGC amplified the rider — preservation, not loss.
    label = "gain" if near_loss < 0 else "loss"
    print(f"  near-end {label:4} : {abs(near_loss):.1f} dB  (rider only; want loss <= {args.max_near_loss_db})")
    label = "gain" if duplex_loss < 0 else "loss"
    print(f"  duplex   {label:4} : {abs(duplex_loss):.1f} dB  (barge-in; want loss <= {args.max_duplex_loss_db})")

    if before >= 1.0 and erle < args.min_erle_db:
        raise SystemExit(f"ERLE {erle:.1f} dB below threshold {args.min_erle_db} dB")
    if near_loss > args.max_near_loss_db:
        raise SystemExit(f"near-end loss {near_loss:.1f} dB above {args.max_near_loss_db} dB")
    if duplex_loss > args.max_duplex_loss_db:
        raise SystemExit(
            f"duplex loss {duplex_loss:.1f} dB above {args.max_duplex_loss_db} dB — "
            "the rider is cancelled along with the echo, so barge-in will not work"
        )


if __name__ == "__main__":
    main()
