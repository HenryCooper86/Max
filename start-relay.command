#!/bin/zsh
# Launcher for the Max voice-agent relay (mock provider by default).
# Double-click in Finder to start the server on http://localhost:8787.
cd "$(dirname "$0")" || exit 1

# Make sure node/npm are on PATH whether installed via Homebrew or nvm.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

echo "──────────────────────────────────────────────"
echo " Max relay → http://localhost:8787  (VOICE_PROVIDER=${VOICE_PROVIDER:-mock})"
echo " Leave this window open. Press Ctrl+C to stop."
echo "──────────────────────────────────────────────"
npm run dev:server
