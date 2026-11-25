#!/usr/bin/env bash
# Runs ON the board as root, streamed by rdk/deploy.sh. Usage: build.sh STAGE SHA
#
# The native AEC executable and the rendered ADAS alert clips are armed board
# artifacts, not Git files. The alert clips are carried over from the live
# release. So is the AEC executable while its sources (rdk/aec/Makefile and
# rdk/aec/src) are unchanged; when the release changes them, it is compiled
# here from the staged sources, so a reviewed AEC fix actually ships. Either
# way the copies are proven intact, then dependencies are installed and the
# staged tree is built. A missing AEC binary, an AEC build failure or an empty
# alert set blocks activation.
set -euo pipefail

ROOT=${RDK_REMOTE_ROOT:-/opt/max}
[ "$#" -eq 2 ] || { echo "usage: build.sh STAGE SHA" >&2; exit 64; }
STAGE=$1
SHA=$2

sha_pattern='^[0-9a-f]{40}$'
[[ $SHA =~ $sha_pattern ]] || { echo "bad SHA" >&2; exit 64; }
[ "$STAGE" = "$ROOT.stage-$SHA" ] || { echo "stage path does not match the SHA" >&2; exit 64; }
[ -d "$STAGE" ]
[ ! -L "$STAGE" ]

CURRENT_AEC=$ROOT/rdk/aec/max-aec
CURRENT_ALERTS=$ROOT/rdk/audio/alerts
STAGED_AEC=$STAGE/rdk/aec/max-aec
STAGED_ALERTS=$STAGE/rdk/audio/alerts

test -x "$CURRENT_AEC"
find "$CURRENT_ALERTS" -maxdepth 1 -type f -name '*.wav' -print -quit | grep -q .
install -d -o root -g root -m 0755 "$(dirname "$STAGED_AEC")" "$STAGED_ALERTS"
if cmp -s "$ROOT/rdk/aec/Makefile" "$STAGE/rdk/aec/Makefile" &&
  diff -qr "$ROOT/rdk/aec/src" "$STAGE/rdk/aec/src" >/dev/null 2>&1; then
  install -o root -g root -m 0755 "$CURRENT_AEC" "$STAGED_AEC"
  cmp -s "$CURRENT_AEC" "$STAGED_AEC"
else
  echo "rdk/aec sources changed since the live release: building max-aec from the stage"
  if ! make -C "$STAGE/rdk/aec"; then
    echo "max-aec did not build. The board needs: apt install g++ pkg-config libwebrtc-audio-processing-dev libasound2-dev" >&2
    exit 1
  fi
fi
cp -a "$CURRENT_ALERTS"/. "$STAGED_ALERTS"/
test -x "$STAGED_AEC"
diff -qr "$CURRENT_ALERTS" "$STAGED_ALERTS"
find "$STAGED_ALERTS" -maxdepth 1 -type f -name '*.wav' -readable -print -quit | grep -q .

cd "$STAGE"
npm ci --no-audit --no-fund
npm run build
printf '%s\n' "$SHA" >.rdk-release-sha
chown -R root:root "$STAGE"
chmod 0755 "$STAGE"
test "$(stat -c '%U:%G:%a' "$STAGE")" = root:root:755
test -x "$STAGED_AEC"
find "$STAGED_ALERTS" -maxdepth 1 -type f -name '*.wav' -readable -print -quit | grep -q .
echo "staged and built $SHA"
