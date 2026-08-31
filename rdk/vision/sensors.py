"""Which camera modules this board can actually use, and a fast preflight.

Identifying the attached sensor before opening a pipeline turns a confusing
5-second ISP timeout into an instant, actionable message. That timeout cost real
debugging hours: an OV5647 gets all the way through sensor init and then stalls
in the ISP, so every symptom points at the wrong layer.

OV5647 is supported on host 0 and fails on host 2 — the port is the variable,
not the sensor. See "Camera findings" in rdk/README.md. This module reports what
is attached; deciding whether a combination can stream is the opener's job.
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

#: Each connector's one usable MIPI channel. mipi_cam prints "this board support
#: mipi: host 0, host 2" — hosts 1 and 3 do not exist, so a connector carries one
#: camera. Bus 6 is the CAM1 connector (vcon@0/@1); bus 4 is the other (vcon@2/@3).
BUS_CHANNEL = {6: 0, 4: 2}


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


def discover(scan: Callable[[int], list[int]] = scan_bus) -> dict[int, str]:
    """MIPI channel -> the ``video_device`` name mipi_cam wants, per attached module.

    Discovering the sensor is what lets the sidecar stop hardcoding one. A
    hardcoded IMX219 is why the working OV5647 in CAM1 could not be opened.
    """
    found: dict[int, str] = {}
    for bus, channel in BUS_CHANNEL.items():
        for addr in scan(bus):
            sensor = identify(addr)
            if sensor is not None:
                found[channel] = sensor.name.upper()
                break
    return found


def preflight(scan: Callable[[int], list[int]] = scan_bus) -> None:
    """Raise only when no known camera module is attached at all.

    This used to reject any sensor outside a supported list. That was wrong in
    the most expensive way: the list held only IMX219, so it vetoed the OV5647
    that streams fine on host 0. With two of four port x sensor combinations
    measured, refusing to try is likelier to be wrong than the hardware is. An
    open that cannot work now fails loudly, with the vendor's own error.

    The fast-failure this function was written for is kept: an empty bus still
    fails in under a second with the ribbon-seating message, rather than after a
    five-second ISP timeout that points at the wrong layer.
    """
    addrs = [addr for bus in CAMERA_BUSES for addr in scan(bus)]
    if any(identify(a) is not None for a in addrs):
        return

    raise UnsupportedSensor(
        "no camera answering on either connector bus:\n"
        f"{describe_scan(scan)}\n"
        "An entirely empty bus usually means the ribbon is not seated — the metal\n"
        "contacts must face the PCB, and it must be pushed fully home before the\n"
        "latch closes. See 'Camera findings' in rdk/README.md."
    )
