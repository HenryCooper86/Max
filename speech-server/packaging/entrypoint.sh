#!/bin/sh
# Container entrypoint. Only `max-speech serve` needs SPEECH_API_KEY: the server
# binds 0.0.0.0 in a container, and without a key it refuses every non-loopback
# client (401 api_key_required), so a keyless server could never be reached.
# `max-speech download`, `max-speech engines` and other commands run without one.
set -eu

# Options only (docker run IMAGE --port 9000): run the default server command.
case "${1:-}" in
  -*) set -- max-speech serve --host 0.0.0.0 "$@" ;;
esac

serving=0
has_port=0
if [ "${1:-}" = "max-speech" ]; then
  for arg in "$@"; do
    case "$arg" in
      serve) serving=1 ;;
      --port | --port=*) has_port=1 ;;
    esac
  done
fi

if [ "$serving" = 1 ] && [ -z "${SPEECH_API_KEY:-}" ]; then
  cat >&2 <<'MSG'
error: SPEECH_API_KEY is not set.

Max Speech in a container listens on 0.0.0.0 and needs an API key; without one it
only answers loopback clients, which a container port mapping never is. Set one:

  docker run -e SPEECH_API_KEY="$(openssl rand -hex 24)" ...

and give the same value to the relay as MAX_SPEECH_API_KEY.
MSG
  exit 64
fi
# The port comes from SPEECH_PORT (default 8790, also what the healthcheck probes)
# unless --port is given explicitly.
if [ "$serving" = 1 ] && [ "$has_port" = 0 ]; then
  set -- "$@" --port "${SPEECH_PORT:-8790}"
fi
exec "$@"
