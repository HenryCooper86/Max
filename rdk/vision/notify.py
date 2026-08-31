"""sd_notify without a dependency: one datagram to systemd's socket.

The sidecar needs exactly one state (``WATCHDOG=1``) and must not grow a
python3-systemd dependency for it. Outside systemd — no ``NOTIFY_SOCKET`` —
every call is a no-op, so bench runs and tests behave identically.
"""

from __future__ import annotations

import os
import socket


def sd_notify(state: str, env=os.environ) -> bool:
    """Send one state line to systemd. False when not under systemd or on error."""
    path = env.get("NOTIFY_SOCKET")
    if not path:
        return False
    if path.startswith("@"):
        # systemd spells the abstract namespace "@"; AF_UNIX spells it "\0".
        path = "\0" + path[1:]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.connect(path)
            sock.sendall(state.encode("utf-8"))
        return True
    except OSError:
        return False
