from __future__ import annotations

import argparse
import dataclasses
import logging
import sys
import threading
from collections.abc import Sequence

from max_speech.api.slots import EngineSlots
from max_speech.engines.select import build_engines, cloning_companions, licensed, plan, zh_model_id
from max_speech.licenses import LicenseError, load_registry, require
from max_speech.models import ModelDownloadError, ensure_model
from max_speech.profile import resolve_profile
from max_speech.settings import PROFILES, Settings

log = logging.getLogger("max_speech")

WS_MAX_MESSAGE_BYTES = 1 << 20


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
        engines = build_engines(settings, profile, progress=_progress_logger())
        for engine in engines.loaded():
            warm_up = getattr(engine, "warm_up", None)  # the VAD has nothing to warm up
            if warm_up is None:
                continue
            try:
                warm_up()
            except Exception as exc:
                if engine is not engines.cloning or settings.cloning_model is not None:
                    raise  # only a default cloning engine may fail without taking the server down
                log.warning(
                    "voice cloning is unavailable, continuing without it (%s: %s)", type(exc).__name__, exc
                )
                engines.cloning = None
        slots.stt = engines.stt
        slots.install_tts(engines.tts, engines.cloning)
        slots.vad, slots.turn, slots.stt_stream = engines.vad, engines.turn, engines.stt_stream
        slots.second_pass = engines.second_pass
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
    # ws_max_size: the session only receives microphone chunks and small JSON; 1 MiB is far more than either needs.
    return uvicorn.Config(
        app,
        host=settings.host,
        port=settings.port,
        log_level="info",
        proxy_headers=False,
        ws_max_size=WS_MAX_MESSAGE_BYTES,
    )


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
        the_plan = plan(settings, profile)
        for role_plan in the_plan.roles():
            licensed(role_plan, registry)
        if zh_id := zh_model_id(settings, the_plan.tts):
            require(zh_id, "tts", registry=registry)
        if the_plan.cloning:
            cloning_companions(the_plan.cloning, registry)
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
        the_plan = plan(settings, profile)
        wanted = [(p.role, p.model_id, licensed(p, registry)) for p in the_plan.roles()]
        if zh_id := zh_model_id(settings, the_plan.tts):
            wanted.append(("tts-zh", zh_id, require(zh_id, "tts", registry=registry)))
        if the_plan.cloning:
            for companion in cloning_companions(the_plan.cloning, registry):
                wanted.append(("cloning-companion", companion.id, companion))
        for role, model_id, entry in wanted:
            path = ensure_model(entry, settings.models_dir, progress=_progress_logger())
            print(f"{role}: {model_id} -> {path}")
    except (LicenseError, ModelDownloadError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


def _cmd_engines(args: argparse.Namespace) -> int:
    settings, profile = _settings_with_profile(args.profile)
    print(f"profile: {profile}")
    registry = load_registry()
    try:
        the_plan = plan(settings, profile)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    plans = (
        ("stt", the_plan.stt),
        ("tts", the_plan.tts),
        ("cloning", the_plan.cloning),
        ("vad", the_plan.vad),
        ("turn", the_plan.turn),
        ("stt_stream", the_plan.stt_stream),
    )
    for role, role_plan in plans:
        if role_plan is None:
            print(f"{role}: off")
            continue
        print(f"{role}: {role_plan.engine} / {role_plan.model_id} [{_license_text(role_plan, registry)}]")
        if role == "tts" and (zh_id := zh_model_id(settings, role_plan)):
            try:
                zh = require(zh_id, "tts", registry=registry)
                zh_lic = f"weights {zh.weights_license}, code {zh.code_license}"
            except LicenseError as exc:
                zh_lic = f"NOT ALLOWED ({exc})"
            print(f"tts-zh: {role_plan.engine} / {zh_id} [{zh_lic}]")
        if role == "cloning":
            try:
                for companion in cloning_companions(role_plan, registry):
                    print(
                        f"cloning-companion: {companion.id} "
                        f"[weights {companion.weights_license}, code {companion.code_license}]"
                    )
            except LicenseError as exc:
                print(f"cloning-companion: NOT ALLOWED ({exc})")
    print(f"second_pass: {'on' if the_plan.second_pass else 'off'}")
    return 0


def _license_text(role_plan, registry) -> str:
    try:
        entry = licensed(role_plan, registry)
        return f"weights {entry.weights_license}, code {entry.code_license}"
    except LicenseError as exc:
        return f"NOT ALLOWED ({exc})"


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
