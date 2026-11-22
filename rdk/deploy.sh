#!/usr/bin/env bash
# Deploy the reviewed main commit to an RDK board: stage, verify, swap, health
# check, and roll back automatically if the new release does not prove itself.
# Run from a clean checkout of main on your own machine.
#
#   rdk/deploy.sh --host root@board.example.com --dry-run
#   rdk/deploy.sh --host root@board.example.com
#
# See "Deploying" in rdk/README.md. The board-side steps are in rdk/remote/.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

REPO=${RDK_DEPLOY_REPO:-$SCRIPT_DIR/..}
HOST=${RDK_HOST:-}
DEVICE_ID_FILE=${RDK_DEVICE_ID_FILE:-/var/lib/max/device-id}
HARDEN=1
VISION_SETTLE_S=${RDK_VISION_SETTLE_S:-45}
RELEASE_ROOT=/opt/max

usage() {
  cat <<'USAGE'
usage: deploy.sh --host [user@]host [options]

  --host H              SSH target (or set RDK_HOST). Never put credentials in the URL.
  --dry-run             Print every command that would run on the board; run none of them.
  --no-hardening        Do not install the systemd hardening drop-ins, and remove any
                        installed by an earlier deploy.
  --device-id-file P    Path of the board's device identity (default /var/lib/max/device-id,
                        or RDK_DEVICE_ID_FILE).
  --vision-settle S     Seconds the vision sidecar must stay up after the restart
                        before the deploy counts as healthy (default 45).
  -h, --help            This text.

Deploys only the commit that is both HEAD and origin/main, from a clean tree.
USAGE
}

while [ "$#" -gt 0 ]; do
  case $1 in
    --host)
      [ "$#" -ge 2 ] || die "--host needs a value"
      HOST=$2
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --no-hardening)
      HARDEN=0
      shift
      ;;
    --device-id-file)
      [ "$#" -ge 2 ] || die "--device-id-file needs a value"
      DEVICE_ID_FILE=$2
      shift 2
      ;;
    --vision-settle)
      [ "$#" -ge 2 ] || die "--vision-settle needs a value"
      VISION_SETTLE_S=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument '$1'"
      ;;
  esac
done

[ -n "$HOST" ] || die "--host (or RDK_HOST) is required"
validate_host "$HOST"
validate_abs_path "device id file" "$DEVICE_ID_FILE"
[[ $VISION_SETTLE_S =~ ^[0-9]{1,3}$ ]] || die "--vision-settle must be 1-3 digits"

# --- local guards: the commit must be the reviewed one --------------------------
if [ "$DRY_RUN" = 1 ]; then
  note "[dry-run] skipping 'git fetch origin main'; comparing against the last fetched origin/main"
else
  git -C "$REPO" fetch origin main
fi
REVIEWED_SHA=$(git -C "$REPO" rev-parse HEAD)
validate_sha "$REVIEWED_SHA"
[ "$REVIEWED_SHA" = "$(git -C "$REPO" rev-parse origin/main)" ] ||
  die "HEAD is not origin/main; deploy only the reviewed main commit"
[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ] ||
  die "the working tree has uncommitted changes to tracked files"

# Both names embed only the validated SHA and a digits-only timestamp, so the
# board-side scripts can rebuild and compare them before moving or deleting.
STAMP=$(date -u +%Y%m%d%H%M%S)
REMOTE_STAGE="$RELEASE_ROOT.stage-$REVIEWED_SHA"
PREVIOUS_ROOT="$RELEASE_ROOT.previous-$REVIEWED_SHA-$STAMP"
FAILED_ROOT="$RELEASE_ROOT.failed-$REVIEWED_SHA-$STAMP"

# --- idempotence: nothing to do if this exact commit is already live ------------
ACTIVE_SHA=$(query_remote "$HOST" "cat $RELEASE_ROOT/.rdk-release-sha 2>/dev/null || true")
if [ "$ACTIVE_SHA" = "$REVIEWED_SHA" ]; then
  note "$REVIEWED_SHA is already the active release on $HOST; nothing to deploy"
  exit 0
fi

# --- refuse while another activation is running ------------------------------
ACTIVATE_LOG="$RELEASE_ROOT.activate-$REVIEWED_SHA.log"
ACTIVATE_STATUS="$RELEASE_ROOT.activate-$REVIEWED_SHA.status"
ACTIVATE_LOCK="$RELEASE_ROOT.activate.lock"

# One remote command, three lines back: the status ("none" if there is no file),
# "running" or "idle" (is the lock's holder alive: its PID exists and it is the
# same boot, the test activate.sh itself uses to reclaim a stale lock), and the
# SHA of the active release.
# shellcheck disable=SC2016 # runs on the board, not here
BOARD_QUERY='s=none; if [ -f @STATUS@ ]; then s=$(cat @STATUS@); fi; l=idle; if [ -d @LOCK@ ] && read -r p <@LOCK@/pid && kill -0 "$p" 2>/dev/null && [ "$(cat @LOCK@/boot 2>/dev/null)" = "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" ]; then l=running; fi; echo "$s"; echo "$l"; cat @ROOT@/.rdk-release-sha 2>/dev/null || echo unknown'
BOARD_QUERY=${BOARD_QUERY//@STATUS@/$ACTIVATE_STATUS}
BOARD_QUERY=${BOARD_QUERY//@LOCK@/$ACTIVATE_LOCK}
BOARD_QUERY=${BOARD_QUERY//@ROOT@/$RELEASE_ROOT}

# Reads the board's answer into BOARD_STATUS, BOARD_LIVE and BOARD_ACTIVE.
ask_board() {
  local out
  out=$(query_remote "$HOST" "$BOARD_QUERY" 2>/dev/null) || return 1
  { read -r BOARD_STATUS && read -r BOARD_LIVE && read -r BOARD_ACTIVE; } <<<"$out" || return 1
}

if [ "$DRY_RUN" != 1 ]; then
  # Never start a second activation, or delete the files of one, while another is
  # still running on the board.
  if ask_board && [ "$BOARD_LIVE" = running ]; then
    die "an activation is still running on $HOST (lock $ACTIVATE_LOCK); wait for it, then read $ACTIVATE_STATUS"
  fi
fi

note "deploying $REVIEWED_SHA to $HOST (hardening drop-ins: $([ "$HARDEN" = 1 ] && echo on || echo off))"

# --- stage ---------------------------------------------------------------------
# The reviewed Git archive only: ignored and untracked checkout files never
# travel, and the live checkout is never mirrored over.
run_remote_script "$HOST" "$SCRIPT_DIR/remote/stage.sh" "$REMOTE_STAGE" "$REVIEWED_SHA"
if [ "$DRY_RUN" = 1 ]; then
  printf '[dry-run] git -C %s archive %s | ssh %s tar -xf - -C %s\n' "$REPO" "$REVIEWED_SHA" "$HOST" "$REMOTE_STAGE"
else
  git -C "$REPO" archive "$REVIEWED_SHA" | _ssh "$HOST" "tar -xf - -C '$REMOTE_STAGE'"
fi

# --- verify and build ----------------------------------------------------------
run_remote_script "$HOST" "$SCRIPT_DIR/remote/build.sh" "$REMOTE_STAGE" "$REVIEWED_SHA"

# --- swap, health check, automatic rollback -------------------------------------
# activate.sh writes everything to a log on the board and its outcome, last, to a
# one-line status file, so the result does not depend on this ssh connection
# surviving. Whatever ssh returns, the board is asked what happened.
if [ "$DRY_RUN" != 1 ]; then
  # A leftover from an earlier attempt at this SHA must not be mistaken for this one.
  run_remote_command "$HOST" "rm -f -- $ACTIVATE_LOG $ACTIVATE_STATUS"
fi

ACTIVATE_RC=0
run_remote_script "$HOST" "$SCRIPT_DIR/remote/activate.sh" \
  "$REMOTE_STAGE" "$PREVIOUS_ROOT" "$FAILED_ROOT" "$DEVICE_ID_FILE" "$REVIEWED_SHA" "$HARDEN" "$VISION_SETTLE_S" ||
  ACTIVATE_RC=$?

if [ "$DRY_RUN" = 1 ]; then
  note "[dry-run] nothing was run on the board"
  exit 0
fi

# Ask the board for the outcome, reconnecting if the connection dropped. The
# window covers the worst case of two proofs (20 s + 60 s each) plus the settle
# time twice, with margin; it is not a guess about one fixed duration.
STEP=${RDK_RECONNECT_SLEEP:-10}
if [ -n "${RDK_RECONNECT_TRIES:-}" ]; then
  TRIES=$RDK_RECONNECT_TRIES
else
  WINDOW=$((2 * (80 + VISION_SETTLE_S) + 120))
  TRIES=$(((WINDOW + STEP - 1) / (STEP > 0 ? STEP : 1)))
fi
BOARD_STATUS=
BOARD_LIVE=
BOARD_ACTIVE=
REACHED=0
for _ in $(seq 1 "$TRIES"); do
  if ask_board; then
    REACHED=1
    # "started" with a live holder: still working. "started" with nobody home was
    # left by a killed script; do not wait for it.
    case $BOARD_STATUS in started\ *) [ "$BOARD_LIVE" = running ] || break ;; *) break ;; esac
  fi
  sleep "$STEP"
done

if [ "$REACHED" != 1 ]; then
  die "connection lost and the board could not be reached; the outcome is unknown. When it is back: ssh $HOST 'cat $ACTIVATE_STATUS $ACTIVATE_LOG'"
fi
if [ "$ACTIVATE_RC" -ne 0 ]; then
  note "connection to the board ended with status $ACTIVATE_RC; board says: $BOARD_STATUS (active release: $BOARD_ACTIVE)"
fi
note "--- board log ($ACTIVATE_LOG) ---"
query_remote "$HOST" "if [ -f $ACTIVATE_LOG ]; then cat $ACTIVATE_LOG; fi" >&2 || note "(could not fetch the log)"
note "--- end board log ---"

# No usable status file (never written, or the disk was full): fall back to what
# activate.sh's own exit status said, checked against the release that is active.
case $BOARD_STATUS in
  none | started\ *)
    if [ "$BOARD_LIVE" = running ]; then
      die "activation is still running on the board after waiting; read $ACTIVATE_STATUS later"
    fi
    case $ACTIVATE_RC in
      0 | 3)
        if [ "$BOARD_ACTIVE" = "$REVIEWED_SHA" ]; then
          if [ "$ACTIVATE_RC" = 0 ]; then BOARD_STATUS="activated $REVIEWED_SHA"; else BOARD_STATUS="activated-relay-unreachable $REVIEWED_SHA"; fi
          note "(no status file on the board; derived from activate.sh's exit status $ACTIVATE_RC and the active release)"
        fi
        ;;
      1) BOARD_STATUS="rolled-back $REVIEWED_SHA" ; note "(no status file on the board; derived from activate.sh's exit status 1)" ;;
      2) BOARD_STATUS="rollback-failed $REVIEWED_SHA" ; note "(no status file on the board; derived from activate.sh's exit status 2)" ;;
    esac
    ;;
esac
case $BOARD_STATUS in
  none | started\ *)
    die "activation was interrupted; the board is on release $BOARD_ACTIVE (status: $BOARD_STATUS). Read the log above and check the services before deploying again."
    ;;
esac

case $BOARD_STATUS in
  "activated $REVIEWED_SHA")
    note "deployed $REVIEWED_SHA. Keep $PREVIOUS_ROOT until acceptance is complete."
    ;;
  "activated-relay-unreachable $REVIEWED_SHA")
    note "WARNING: $REVIEWED_SHA is active and its services are healthy, but the agent could not reach the relay."
    note "Check the relay URL, token and network; the helmet has no voice until it connects. Keep $PREVIOUS_ROOT."
    exit 3
    ;;
  "rolled-back $REVIEWED_SHA")
    die "activation failed; the previous release is running again. The failed release is kept at $FAILED_ROOT"
    ;;
  "rollback-failed $REVIEWED_SHA")
    note "ROLLBACK FAILED: the board is not on a proven release. Follow the manual rollback in rdk/README.md."
    exit 2
    ;;
  *)
    die "activation did not complete (board status: $BOARD_STATUS, active release: $BOARD_ACTIVE); see the log above."
    ;;
esac
