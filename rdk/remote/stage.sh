#!/usr/bin/env bash
# Runs ON the board as root, streamed by rdk/deploy.sh. Usage: stage.sh STAGE SHA
#
# Creates the empty, root-owned directory the reviewed archive is unpacked into.
# A stage left by an earlier failed attempt is removed first, so re-running a
# deploy is safe; the path is matched exactly before anything is deleted.
set -euo pipefail

ROOT=${RDK_REMOTE_ROOT:-/opt/max}
[ "$#" -eq 2 ] || { echo "usage: stage.sh STAGE SHA" >&2; exit 64; }
STAGE=$1
SHA=$2

sha_pattern='^[0-9a-f]{40}$'
[[ $SHA =~ $sha_pattern ]] || { echo "bad SHA" >&2; exit 64; }
[ "$STAGE" = "$ROOT.stage-$SHA" ] || { echo "stage path does not match the SHA" >&2; exit 64; }

if [ -e "$STAGE" ] || [ -L "$STAGE" ]; then
  echo "removing the stage left by an earlier attempt: $STAGE"
  rm -rf -- "$STAGE"
fi
install -d -o root -g root -m 0755 "$STAGE"
