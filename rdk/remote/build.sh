#!/usr/bin/env bash
# Runs ON the board as root, streamed by rdk/deploy.sh. Usage: build.sh STAGE SHA
#
# The native AEC executable and the rendered ADAS alert clips are armed board
# artifacts, not Git files: carry them over from the live release, prove they
# arrived intact, then install dependencies and build from the staged tree. A
# missing AEC binary or an empty alert set blocks activation.
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
install -o root -g root -m 0755 "$CURRENT_AEC" "$STAGED_AEC"
cp -a "$CURRENT_ALERTS"/. "$STAGED_ALERTS"/
test -x "$STAGED_AEC"
cmp -s "$CURRENT_AEC" "$STAGED_AEC"
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
