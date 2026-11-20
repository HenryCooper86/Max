#!/bin/zsh
# Launcher for Max Speech, the local speech server (Apple silicon, native).
# Double-click in Finder to start it on http://localhost:8790. Loopback only,
# so no API key is needed (set SPEECH_API_KEY to require one). The first start downloads about 5 GB of models
# (about 9 GB on Macs with 24 GB+ of memory, where voice design is on too).
cd "$(dirname "$0")/speech-server" || exit 1

if [ "$(uname -m)" != "arm64" ]; then
  echo "Max Speech's native setup needs an Apple silicon Mac (this one is $(uname -m))."
  echo "The MLX models do not run on Intel. Use Docker instead (CPU image):"
  echo "  docs/speech-server-deployment.md"
  read -r "?Press Return to close."
  exit 1
fi

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is not installed. Install it with one of:"
  echo "  brew install uv"
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh"
  echo "then double-click this file again."
  read -r "?Press Return to close."
  exit 1
fi

uv sync --extra mlx || exit 1

echo "──────────────────────────────────────────────"
echo " Max Speech → http://localhost:8790  (profile: ${SPEECH_PROFILE:-mlx, detected})"
echo " Models download on first start; /healthz says ready when loaded."
echo " Leave this window open. Press Ctrl+C to stop."
echo
echo " Point the relay at it in .env, either:"
if [ -n "${SPEECH_API_KEY:-}" ]; then
  echo "   VOICE_PROVIDER=max-speech"
  echo "   MAX_SPEECH_URL=ws://localhost:8790/v1/speech/session"
  echo "   MAX_SPEECH_API_KEY=<the value of SPEECH_API_KEY>"
  echo " or:"
  echo "   VOICE_PROVIDER=local   LOCAL_VOICE=on   LOCAL_TTS_FORMAT=pcm"
  echo "   LOCAL_STT_BASE_URL=http://localhost:8790/v1"
  echo "   LOCAL_TTS_BASE_URL=http://localhost:8790/v1"
  echo "   LOCAL_STT_API_KEY=<the value of SPEECH_API_KEY>"
  echo "   LOCAL_TTS_API_KEY=<the value of SPEECH_API_KEY>"
  echo " (A relay in Docker reaches this server as http://host.docker.internal:8790;"
  echo "  that needs the key, which is why one is set.)"
else
  echo "   VOICE_PROVIDER=max-speech"
  echo "   MAX_SPEECH_URL=ws://localhost:8790/v1/speech/session"
  echo " or:"
  echo "   VOICE_PROVIDER=local   LOCAL_VOICE=on   LOCAL_TTS_FORMAT=pcm"
  echo "   LOCAL_STT_BASE_URL=http://localhost:8790/v1"
  echo "   LOCAL_TTS_BASE_URL=http://localhost:8790/v1"
  echo " (No key is set, so only a relay on this Mac can connect. A relay in Docker"
  echo "  needs SPEECH_API_KEY set before you start this.)"
fi
echo "──────────────────────────────────────────────"
uv run --extra mlx max-speech serve
