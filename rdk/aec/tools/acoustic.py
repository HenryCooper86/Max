"""Measure AEC over the real speaker-to-mic path, not a synthetic fixture.

Plays a signal through aplay while feeding max-aec the identical samples on
fd 3 — the exact arrangement the agent uses — then reports how much of the
echo max-aec removed. Sweeping --delay-ms with this finds the board's true
reference-to-mic delay, which no offline fixture can know.

Run it in a quiet room with nobody speaking: everything the mic hears is echo,
so residual energy is what the canceller failed to remove.
"""

import math
import os
import struct
import subprocess
import sys
import time

RATE48 = 48000
SECONDS = 8.0
DEV = "plughw:0,0"


def signal_48k(n):
    """Speech-like: a swept tone with syllable-rate amplitude modulation.

    A steady sine is the easy case — it lets a canceller lock on and flatters
    the result. Real speech moves, so this moves.
    """
    out = bytearray()
    phase = 0.0
    for i in range(n):
        t = i / RATE48
        freq = 300.0 + 500.0 * (0.5 + 0.5 * math.sin(2 * math.pi * 0.3 * t))
        phase += 2 * math.pi * freq / RATE48
        env = 0.35 + 0.65 * abs(math.sin(2 * math.pi * 2.5 * t))
        out += struct.pack("<h", int(0.45 * 32767 * env * math.sin(phase)))
    return bytes(out)


def rms(data):
    if not data:
        return 0.0
    vals = struct.unpack(f"<{len(data)//2}h", data[: len(data) // 2 * 2])
    return math.sqrt(sum(float(v) * v for v in vals) / len(vals))


def run(delay_ms, suppression, pcm, aec_bin, extra=""):
    fifo = "/tmp/acoustic_ref"
    if os.path.exists(fifo):
        os.unlink(fifo)
    os.mkfifo(fifo)

    out_path = f"/tmp/acoustic_out_{delay_ms}_{suppression}.raw"
    # The shell puts the fifo on fd 3, which is where max-aec expects the
    # reference — the same arrangement Node gives it via stdio.
    aec = subprocess.Popen(
        ["sh", "-c",
         f"exec {aec_bin} --device {DEV} --delay-ms {delay_ms} "
         f"--suppression {suppression} {extra} > {out_path} 3< {fifo}"],
        stderr=subprocess.PIPE,
    )
    # Opening both ends rendezvouses: each blocks until the other arrives.
    ref = open(fifo, "wb", buffering=0)

    aplay = subprocess.Popen(
        ["aplay", "-D", DEV, "-f", "S16_LE", "-r", str(RATE48), "-c", "1",
         "-t", "raw", "--buffer-size", "5760", "-q"],
        stdin=subprocess.PIPE,
    )

    # Paced exactly like playback.ts: never let more than MAX_QUEUE_MS of audio
    # sit ahead of the DAC, and emit the reference as each block is handed over.
    chunk = RATE48 // 50 * 2  # 20 ms
    max_queue = 0.080
    start = time.time()
    drained = 0.0
    for i in range(0, len(pcm), chunk):
        block = pcm[i : i + chunk]
        at = time.time() - start
        if drained < at:
            drained = at
        while drained - at > max_queue:
            time.sleep(0.005)
            at = time.time() - start
        ref.write(struct.pack("<I", len(block)))
        ref.write(block)
        aplay.stdin.write(block)
        aplay.stdin.flush()
        drained += len(block) / 2 / RATE48

    aplay.stdin.close()
    aplay.wait()
    time.sleep(0.4)
    ref.close()
    aec.wait(timeout=10)
    err = aec.stderr.read().decode()
    data = open(out_path, "rb").read()
    # Skip the first second: the filter has to converge.
    return rms(data[16000 * 2 :]), err.strip()


def main():
    aec_bin = sys.argv[1] if len(sys.argv) > 1 else "./max-aec"
    pcm = signal_48k(int(RATE48 * SECONDS))

    # A failed build leaves the previous binary in place, and one that does not
    # know these flags ignores them silently — producing numbers that look like
    # measurements but describe a different configuration entirely.
    usage = subprocess.run([aec_bin], capture_output=True).stderr.decode()
    for flag in ("--no-aec", "--no-ns", "--no-agc"):
        if flag not in usage:
            sys.exit(f"{aec_bin} does not support {flag} — rebuild before measuring")

    # The hardware duck must be off. Leaving CROSSTALK engaged would have the
    # codec attenuate the mic whenever the speaker is active, and the result
    # would credit APM for suppression it never performed — the same class of
    # mistake that made the 2026-07-25 spike declare success.
    for control in ("CROSSTALK1", "CROSSTALK2"):
        subprocess.run(["amixer", "-c", "0", "sset", control, "0"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("CROSSTALK forced to 0 — measuring APM alone", flush=True)

    # Every stage but resampling is off, so this is the echo as the mic hears
    # it. Note --delay-ms 0 is NOT a baseline: DelayAgnostic means APM keeps
    # cancelling regardless of the hint.
    bench = "--no-agc --no-ns"
    print("measuring baseline (all APM stages off)...", flush=True)
    base, _ = run(160, 0, pcm, aec_bin, extra=bench + " --no-aec")
    print(f"  baseline echo rms {base:.1f}", flush=True)
    if base < 50:
        print("  !! the mic barely hears the speaker — check volume before "
              "trusting anything below", flush=True)

    # AGC and NS stay off here so the number is attributable to the canceller
    # alone. AGC in particular renormalises the output and would mask it.
    best = None
    for delay in (40, 80, 120, 160, 200, 240, 320):
        residual, _ = run(delay, 0, pcm, aec_bin, extra=bench)
        erle = 20 * math.log10(max(base, 1e-9) / max(residual, 1e-9))
        print(f"  delay {delay:3d} ms -> residual rms {residual:7.1f}  "
              f"ERLE {erle:5.1f} dB", flush=True)
        if best is None or erle > best[1]:
            best = (delay, erle)
    print(f"\nbest: --delay-ms {best[0]} at {best[1]:.1f} dB", flush=True)


if __name__ == "__main__":
    main()
