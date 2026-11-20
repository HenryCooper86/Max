from __future__ import annotations

import argparse
import dataclasses
import logging
import sys
import threading
from collections.abc import Sequence

from max_speech.api.slots import EngineSlots
from max_speech.engines.select import build_engines, licensed, plan
from max_speech.licenses import LicenseError, load_registry
from max_speech.models import ModelDownloadError, ensure_model
from max_speech.profile import resolve_profile
from max_speech.settings import PROFILES, Settings

log = logging.getLogger("max_speech")


def _progress_logger():
    last: dict[str, int] = {}

    def progress(name: str, done: int, total: int | None) -> None:
        # Log every ~10% (or every 100 MB when the size is unknown) rather than every chunk.
        step = (total // 10) if total else 100 << 20
        bucket = done // max(step, 1)
        if last.get(name) != bucket:
            last[name] = bucket
            log.info("downloading %s: %d / %s MB", name, done >> 20, (total >> 20) if total else "?")

    return progress


def _load_engines(slots: EngineSlots, settings: Settings, profile: str) -> None:
    """Runs in a background thread: a failure is recorded on the slots so the server keeps answering 503."""
    try:
        stt, tts = build_engines(settings, profile, progress=_progress_logger())
        for engine in (stt, tts):
            if engine is not None:
                engine.warm_up()
        slots.stt, slots.tts = stt, tts
        slots.mark_ready()
        log.info("models ready")
    except Exception as exc:  # anything at all must surface as a readable 503
        log.exception("loading models failed")
        slots.fail(f"{type(exc).__name__}: {exc}")


def _settings_with_profile(profile_arg: str | None) -> tuple[Settings, str]:
    settings = Settings.from_env()
    if profile_arg:
        settings = dataclasses.replace(settings, profile=profile_arg)
    return settings, resolve_profile(settings)


def _uvicorn_config(app, settings: Settings):
    import uvicorn

    # No-key mode trusts loopback clients only; proxy headers would let a local reverse proxy make remote
    # traffic look like 127.0.0.1.
    return uvicorn.Config(app, host=settings.host, port=settings.port, log_level="info", proxy_headers=False)


def _cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    from max_speech.app import create_app

    settings, profile = _settings_with_profile(args.profile)
    settings = dataclasses.replace(
        settings,
        host=args.host or settings.host,
        port=args.port or settings.port,
    )
    try:
        # Fail before listening: a bad engine, unknown/unlicensed model or kind mismatch is a config error.
        registry = load_registry()
        for role_plan in filter(None, plan(settings, profile)):
            licensed(role_plan, registry)
    except (LicenseError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    app = create_app(settings, stt=None, tts=None, profile=profile, ready=threading.Event())
    threading.Thread(
        target=_load_engines, args=(app.state.slots, settings, profile), name="load-engines", daemon=True
    ).start()
    uvicorn.Server(_uvicorn_config(app, settings)).run()
    return 0


def _cmd_download(args: argparse.Namespace) -> int:
    settings, profile = _settings_with_profile(args.profile)
    registry = load_registry()
    try:
        for role_plan in filter(None, plan(settings, profile)):
            entry = licensed(role_plan, registry)
            path = ensure_model(entry, settings.models_dir, progress=_progress_logger())
            print(f"{role_plan.role}: {role_plan.model_id} -> {path}")
    except (LicenseError, ModelDownloadError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


def _cmd_engines(args: argparse.Namespace) -> int:
    settings, profile = _settings_with_profile(args.profile)
    print(f"profile: {profile}")
    registry = load_registry()
    try:
        plans = plan(settings, profile)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    for role, role_plan in zip(("stt", "tts"), plans, strict=True):
        if role_plan is None:
            print(f"{role}: off")
            continue
        try:
            entry = licensed(role_plan, registry)
            lic = f"weights {entry.weights_license}, code {entry.code_license}"
        except LicenseError as exc:
            lic = f"NOT ALLOWED ({exc})"
        print(f"{role}: {role_plan.engine} / {role_plan.model_id} [{lic}]")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="max-speech")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="start the HTTP server")
    serve.add_argument("--host")
    serve.add_argument("--port", type=int)
    serve.add_argument("--profile", choices=PROFILES)
    serve.set_defaults(func=_cmd_serve)

    download = sub.add_parser("download", help="download the profile's models and exit")
    download.add_argument("--profile", choices=PROFILES)
    download.set_defaults(func=_cmd_download)

    engines = sub.add_parser("engines", help="show the resolved engines, models and licenses")
    engines.add_argument("--profile", choices=PROFILES)
    engines.set_defaults(func=_cmd_engines)

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
