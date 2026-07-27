"""Who is listening on the control socket.

The protocol has always been bidirectional — `rpc.encode_event` and the module
docstring in `agent/src/vision-client.ts` both describe unsolicited `event`
messages — but the server half was never built: `ControlHandler` writes only to
the connection that made a request. An ADAS thread has no such connection, so
without this registry a hazard has nowhere to go.
"""

from __future__ import annotations

import threading
from typing import Callable

from rpc import encode_event


class EventBus:
    """Fan one event out to every connected client.

    A client is just a callable that takes a line. Keeping it that narrow means
    the bus never touches sockets, so it tests without one.
    """

    def __init__(self) -> None:
        self._clients: list[Callable[[str], None]] = []
        self._lock = threading.Lock()

    def register(self, write: Callable[[str], None]) -> None:
        with self._lock:
            self._clients.append(write)

    def unregister(self, write: Callable[[str], None]) -> None:
        with self._lock:
            if write in self._clients:
                self._clients.remove(write)

    def broadcast(self, payload: dict) -> int:
        """Deliver one event, returning how many clients took it.

        A client whose write raises is dropped rather than retried: the socket is
        gone, and one dead rider's connection must not cost the others theirs.
        """
        fields = {key: value for key, value in payload.items() if key != "event"}
        line = encode_event(payload["event"], **fields)

        with self._lock:
            clients = list(self._clients)

        delivered = 0
        dead: list[Callable[[str], None]] = []
        for write in clients:
            try:
                write(line)
                delivered += 1
            except Exception:  # noqa: BLE001 - a broken client is expected, not exceptional
                dead.append(write)

        if dead:
            with self._lock:
                self._clients = [c for c in self._clients if c not in dead]
        return delivered
