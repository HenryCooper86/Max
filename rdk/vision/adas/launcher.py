"""Starting one camera's ADAS loop on its own thread.

This lives here rather than in ``service.py`` because of how the sidecar is
started: ``max-vision.service`` runs ``python3 service.py``, so that file is
``__main__``. A ``from service import start_adas`` on the ride path therefore
loaded a *second*, independent copy of the module — two ``VisionConfig``
classes, two ``ControlHandler`` classes, and any module-level state split in
half without a word. Nothing depended on that state today, which is exactly
why it would have been found the hard way.

``ride.py`` imports this instead, and nothing here reaches back into the
module being run as a script.
"""

from __future__ import annotations

import threading
from pathlib import Path


def start_adas(config, shadow_path, emit, source_factory) -> threading.Thread:
    """Run one camera's ADAS loop on a daemon thread.

    Exceptions are caught and logged rather than raised. ADAS failing must cost
    hazard detection and nothing else: the sidecar keeps serving preview and
    gallery, and voice is a different process that this cannot reach.

    RecordingRequired arrives here too. It is a deliberate stop rather than a
    bug — shadow mode without a recorder produces a false-alarm rate nobody can
    review — and it is contained the same way.
    """
    from adas.runtime import run_camera  # noqa: PLC0415 - board-only deps below it
    from adas.shadow import ShadowLog  # noqa: PLC0415

    def body() -> None:
        try:
            with ShadowLog(Path(shadow_path), tuning=config.tuning) as shadow:
                fired = run_camera(source_factory(), config, shadow, emit)
                print(f"[adas] {config.camera}: {fired} alerts", flush=True)
        except Exception as error:  # noqa: BLE001 — see the docstring
            print(f"[adas] {config.camera} stopped: {error}", flush=True)

    thread = threading.Thread(target=body, name=f"adas-{config.camera}", daemon=True)
    thread.start()
    return thread
