"""Which camera modules this board can actually use, and a fast preflight.

Identifying the attached sensor before opening a pipeline turns a confusing
5-second ISP timeout into an instant, actionable message. That timeout cost real
debugging hours: an OV5647 gets all the way through sensor init and then stalls
in the ISP, so every symptom points at the wrong layer.

OV5647 is deliberately unsupported — see "Camera findings" in rdk/README.md for
the trace. It is a vendor-side ISP tuning bug, not something we can fix here.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from typing import Callable

#: The two connector buses. vcon@0/@1 sit on bus 6, vcon@2/@3 on bus 4.
CAMERA_BUSES = (4, 6)


@dataclass(frozen=True)
class Sensor:
    name: str
    addr: int


_BY_ADDR = {
    0x10: Sensor(name="imx219", addr=0x10),
    0x36: Sensor(name="ov5647", addr=0x36),
}

#: Only IMX219 streams on this image.
SUPPORTED_ADDRS = (0x10,)


class UnsupportedSensor(RuntimeError):
    """Raised when no usable camera is attached."""


def identify(addr: int) -> Sensor | None:
    return _BY_ADDR.get(addr)


def scan_bus(bus: int) -> list[int]:
    """Addresses answering on one i2c bus, via i2cdetect. Board-only."""
    try:
        out = subprocess.run(
            ["i2cdetect", "-y", "-r", str(bus)],
            capture_output=True,
            text=True,
            timeout=15,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []

    found: list[int] = []
    for line in out.splitlines()[1:]:
        head, _, rest = line.partition(":")
        if not rest:
            continue
        try:
            row = int(head.strip(), 16)
        except ValueError:
            continue
        for column, cell in enumerate(rest.split()):
            if cell not in ("--", "UU"):
                found.append(row + column)
    return found


def describe_scan(scan: Callable[[int], list[int]] = scan_bus) -> str:
    lines = []
    for bus in CAMERA_BUSES:
        sensors = [identify(a) for a in scan(bus)]
        names = [s.name for s in sensors if s is not None]
        lines.append(f"  bus {bus}: {', '.join(names) if names else 'empty'}")
    return "\n".join(lines)


def preflight(scan: Callable[[int], list[int]] = scan_bus) -> None:
    """Raise unless at least one supported module is attached.

    A mixed pair passes: one usable camera is enough, because front-only is a
    valid corpus and a second unusable module should not block the ride.
    """
    addrs = [addr for bus in CAMERA_BUSES for addr in scan(bus)]
    known = [identify(a) for a in addrs]
    usable = [s for s in known if s is not None and s.addr in SUPPORTED_ADDRS]
    if usable:
        return

    report = describe_scan(scan)
    present = [s.name for s in known if s is not None]
    if not present:
        raise UnsupportedSensor(
            "no camera answering on either connector bus:\n"
            f"{report}\n"
            "An entirely empty bus usually means the ribbon is not seated — the metal\n"
            "contacts must face the PCB, and it must be pushed fully home before the\n"
            "latch closes. See 'Camera findings' in rdk/README.md."
        )

    raise UnsupportedSensor(
        f"only unsupported modules attached ({', '.join(sorted(set(present)))}):\n"
        f"{report}\n"
        "OV5647 does not stream on this image — it stalls 5 s in the ISP tuning step\n"
        "and never starts MIPI, under our recorder and the vendor's own mipi_cam alike.\n"
        "Use an IMX219 (i2c 0x10). See 'Camera findings' in rdk/README.md."
    )
