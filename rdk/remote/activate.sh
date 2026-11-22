#!/usr/bin/env bash
# Runs ON the board as root, streamed by rdk/deploy.sh.
# Usage: activate.sh STAGE PREVIOUS FAILED DEVICE_ID_FILE SHA HARDEN VISION_SETTLE_S
#
# Swaps the staged release in, installs its unit files (and, when HARDEN=1, its
# hardening drop-ins), restarts the services once, and proves the new release
# works. If anything after the swap fails, the previous release, its units and
# its drop-ins are put back and proven the same way, and this exits non-zero.
# Exit 0: activated and proven, including a ready relay session.
# Exit 1: activation failed and the previous release is running again.
# Exit 2: activation failed AND the rollback did not complete; the board needs a
# human (see the rollback appendix in rdk/README.md).
# Exit 3: activated and proven (services active and stable, the agent running and
# retrying), but the agent never reached the relay. The release stays: a good
# release is not rolled back because the relay or the network is down. Exit 3
# with `closed code=1008` in the log usually means the relay token on the board
# is wrong or was rotated (an auth rejection is classed as "unreachable").
# Exit 64: refused before anything moved (bad arguments or a failed preflight).
#
# Once the arguments are valid ALL output goes to $ROOT.activate-$SHA.log (0600),
# and the outcome is written last to $ROOT.activate-$SHA.status as one line:
#   started SHA | activated SHA | activated-relay-unreachable SHA |
#   rolled-back SHA | rollback-failed SHA | refused SHA
# so a dropped ssh channel can neither abort the swap or the rollback (a write to
# a dead channel is an error under errexit) nor hide what happened: rdk/deploy.sh
# reads the status and prints the log after it reconnects. One activation runs at
# a time (lock directory $ROOT.activate.lock, reclaimed when its holder is dead)
# and the five most recent log/status pairs are kept.
set -euo pipefail
# An ssh drop must not kill the script halfway through a swap: it carries on to
# a proven release (or a proven rollback) with nobody watching.
trap '' HUP PIPE

ROOT=${RDK_REMOTE_ROOT:-/opt/max}
ETC=${RDK_REMOTE_ETC:-/etc}
UNIT_DIR=$ETC/systemd/system
ENV_FILE=$ETC/max/agent.env

fatal() {
  echo "error: $*" >&2
  exit 64
}

[ "$#" -eq 7 ] || fatal "usage: activate.sh STAGE PREVIOUS FAILED DEVICE_ID_FILE SHA HARDEN VISION_SETTLE_S"
STAGE=$1
PREVIOUS=$2
FAILED=$3
DEVICE_ID=$4
SHA=$5
HARDEN=$6
SETTLE=$7

# Every path that will be moved or deleted is rebuilt from the SHA and a
# timestamp and compared for exact equality; nothing is trusted because it was
# passed in.
sha_pattern='^[0-9a-f]{40}$'
stamp_pattern='^[0-9]{14}$'
path_pattern='^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
[[ $SHA =~ $sha_pattern ]] || fatal "bad SHA"
[ "$STAGE" = "$ROOT.stage-$SHA" ] || fatal "stage path does not match the SHA"
stamp=${PREVIOUS#"$ROOT.previous-$SHA-"}
[[ $stamp =~ $stamp_pattern ]] || fatal "previous path does not match the SHA and a timestamp"
[ "$PREVIOUS" = "$ROOT.previous-$SHA-$stamp" ] || fatal "previous path is not canonical"
[ "$FAILED" = "$ROOT.failed-$SHA-$stamp" ] || fatal "failed path does not match the previous path"
[[ $DEVICE_ID =~ $path_pattern ]] || fatal "device id path must be a plain absolute path"
case $DEVICE_ID in *..*) fatal "device id path must not contain '..'" ;; esac
case $HARDEN in 0 | 1) ;; *) fatal "HARDEN must be 0 or 1" ;; esac
[[ $SETTLE =~ ^[0-9]{1,3}$ ]] || fatal "VISION_SETTLE_S must be 1-3 digits"
DEVICE_ID_PARENT=$(dirname "$DEVICE_ID")
LOG=$ROOT.activate-$SHA.log
STATUS_FILE=$ROOT.activate-$SHA.status
LOCK_DIR=$ROOT.activate.lock
KEEP_RUNS=5

# Every diagnostic goes through here. Output is a file on a possibly full disk
# (or, in a test, a dead pipe): a failed write must never fail the script, least
# of all in the middle of a swap or a rollback.
#
# It is an external process on purpose: when a builtin printf fails to write, bash
# keeps the unwritten text buffered and flushes it into the NEXT command
# substitution's output, which corrupted `$(sha256sum ...)` and failed a rollback.
say() {
  env printf '%s\n' "$*" 2>/dev/null || true
}

# Writes the one-line outcome atomically, last, on every path. Best effort: if the
# board cannot write it (full disk), rdk/deploy.sh falls back to this script's
# exit status plus the SHA of the release that is active. The temp file is made
# by mktemp (O_EXCL, 0600) and moved over the status path, which replaces a
# planted symlink instead of following it.
set_status() {
  local tmp
  tmp=$(umask 077 && mktemp "$STATUS_FILE.XXXXXX") || return 0
  if printf '%s %s\n' "$1" "$SHA" >"$tmp" 2>/dev/null; then
    mv -f -- "$tmp" "$STATUS_FILE" 2>/dev/null || rm -f -- "$tmp" || true
  else
    rm -f -- "$tmp" || true
  fi
  return 0
}

# The release root's parent holds the log, the status files and the lock, so it
# must be root's and closed to everyone else, or a pre-planted symlink there
# could be written through as root. (The tests' stat shim reports root for their
# sandbox, which is how the check runs unprivileged.)
check_parent() {
  local parent owner mode
  parent=$(dirname "$ROOT")
  [ -d "$parent" ] && [ ! -L "$parent" ] || fatal "$parent is not a plain directory"
  IFS=: read -r owner _ mode < <(stat -c '%U:%G:%a' "$parent")
  [ "$owner" = root ] || fatal "$parent is not owned by root"
  [[ $mode =~ ^[0-7]{3,4}$ ]] || fatal "cannot read the mode of $parent"
  if (((8#$mode) & 8#022)); then fatal "$parent is writable by group or others"; fi
}

# One activation at a time, for the whole life of the process. The lock is a
# directory (mkdir is atomic) holding the holder's PID and the boot id. It cannot
# be left stale: a holder that was killed (SIGKILL, power loss) fails the
# liveness test, which is "that PID exists AND this is the same boot", so the
# next run reclaims it. rdk/deploy.sh runs the same test before it touches
# anything.
lock_holder_alive() {
  local pid boot
  pid=$(cat "$LOCK_DIR/pid" 2>/dev/null) || return 1
  [[ $pid =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  boot=$(cat "$LOCK_DIR/boot" 2>/dev/null || true)
  [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)" ]
}

acquire_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    # A holder that has made the directory but not yet written its PID is alive.
    [ -e "$LOCK_DIR/pid" ] || sleep 1
    if lock_holder_alive; then fatal "another activation is running on this board (lock $LOCK_DIR)"; fi
    rm -f -- "$LOCK_DIR/pid" "$LOCK_DIR/boot"
    rmdir "$LOCK_DIR" 2>/dev/null || fatal "cannot reclaim the stale lock $LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || fatal "cannot take the lock $LOCK_DIR"
  fi
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
  cat /proc/sys/kernel/random/boot_id >"$LOCK_DIR/boot" 2>/dev/null || : >"$LOCK_DIR/boot"
  trap release_lock EXIT
}

release_lock() {
  rm -f -- "$LOCK_DIR/pid" "$LOCK_DIR/boot" || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

# Keeps the KEEP_RUNS most recent log/status pairs, never the current one. Only
# called by the lock holder, so it cannot race another activation.
prune_old_runs() {
  local f n=0 old
  while IFS= read -r f; do
    n=$((n + 1))
    [ "$n" -gt "$KEEP_RUNS" ] || continue
    old=${f#"$ROOT.activate-"}
    old=${old%.status}
    [[ $old =~ $sha_pattern ]] || continue
    [ "$old" != "$SHA" ] || continue
    rm -f -- "$ROOT.activate-$old.status" "$ROOT.activate-$old.log"
  done < <(ls -t -- "$ROOT".activate-*.status 2>/dev/null || true)
  return 0
}

# From here on nothing is written to the ssh channel. Stale files are removed
# (rm never follows a link) and recreated with noclobber, which refuses to open
# anything that appears in between, a planted symlink included.
redirect_output() {
  rm -f -- "$LOG" "$STATUS_FILE"
  (
    umask 077
    set -C
    : >"$LOG"
  ) || fatal "cannot create $LOG"
  # RDK_REMOTE_OUTPUT_SINK is a test seam (like RDK_REMOTE_ROOT): a path to send
  # the output to instead of $LOG (/dev/full), or "inherit" to keep the caller's
  # channel, so a test can prove no failed write aborts the script.
  case ${RDK_REMOTE_OUTPUT_SINK:-} in
    inherit) ;;
    *) exec >>"${RDK_REMOTE_OUTPUT_SINK:-$LOG}" 2>&1 ;;
  esac
  set_status started
}

# A relay that cannot be reached, as opposed to an agent that is broken: the
# agent's own log lines (rdk/agent/src/relay.ts and main.ts) show the relay
# socket failing or closing and the reconnect loop running, and neither
# "[agent] uncaught exception" nor "[agent] unhandled rejection" appears.
agent_retrying_relay() {
  local journal
  journal=$(journalctl _SYSTEMD_INVOCATION_ID="$1" --no-pager -o cat) || return 1
  if grep -E '^\[agent\] (uncaught exception|unhandled rejection)' <<<"$journal" >/dev/null; then
    return 1
  fi
  grep -E '^\[relay\] (socket error:|closed code=|reconnecting in |idle close)' <<<"$journal" >/dev/null
}

invocation() {
  systemctl show -p InvocationID --value "$1"
}

# Installs a release's units. A drop-in the release does not ship (or one the
# operator opted out of) is removed, so the installed drop-ins always describe
# the release that is running.
install_units() {
  local src=$1/rdk/systemd unit service dropin_dir
  for unit in "$src"/*.service; do
    install -o root -g root -m 0644 "$unit" "$UNIT_DIR"/
  done
  for service in max-agent max-vision; do
    dropin_dir=$UNIT_DIR/$service.service.d
    if [ "$HARDEN" = 1 ] && [ -f "$src/$service.service.d/hardening.conf" ]; then
      install -d -o root -g root -m 0755 "$dropin_dir"
      install -o root -g root -m 0644 "$src/$service.service.d/hardening.conf" "$dropin_dir/hardening.conf"
    else
      rm -f -- "$dropin_dir/hardening.conf"
    fi
  done
}

# One controlled restart of both services, then proof that this invocation is
# the one that works: a new nonempty Invocation ID, that invocation's own
# journal showing a ready relay session, and (for the sidecar, which needs ~19 s
# to open the cameras) the same invocation still alive after the settle window.
# A crash-looping unit gets a fresh Invocation ID on every restart, so an
# unchanged ID is what "stayed up" means.
#
# MODE strict: a relay session that never becomes ready fails the proof unless
# the agent is demonstrably running and retrying the relay; then RELAY_STATE is
# set to unreachable and the proof carries on. MODE lenient (the rollback): relay
# readiness is only ever a warning.
RELAY_STATE=ready
restart_and_prove() {
  local mode=$1
  local old_agent old_vision agent_id vision_id ready started now
  old_agent=$(invocation max-agent)
  old_vision=$(invocation max-vision)

  systemctl daemon-reload
  systemctl restart max-vision
  started=$(date +%s)
  systemctl restart max-agent

  agent_id=
  for _ in $(seq 1 20); do
    agent_id=$(invocation max-agent)
    if test -n "$agent_id" && test "$agent_id" != "$old_agent"; then
      break
    fi
    sleep 1
  done
  test -n "$agent_id"
  test "$agent_id" != "$old_agent"

  ready=0
  for _ in $(seq 1 60); do
    if journalctl _SYSTEMD_INVOCATION_ID="$agent_id" --no-pager -o cat | grep -F '[relay] session ready' >/dev/null; then
      ready=1
      break
    fi
    sleep 1
  done
  RELAY_STATE=ready
  if [ "$ready" != 1 ]; then
    if [ "$mode" = lenient ] || agent_retrying_relay "$agent_id"; then
      RELAY_STATE=unreachable
      say "warning: the agent is running but has not reached the relay (relay or network down?)"
    else
      say "the agent never reported a ready relay session and is not retrying one"
      return 1
    fi
  fi
  systemctl is-active --quiet max-agent
  test "$(invocation max-agent)" = "$agent_id"

  vision_id=$(invocation max-vision)
  test -n "$vision_id"
  test "$vision_id" != "$old_vision"
  while :; do
    now=$(date +%s)
    if [ $((now - started)) -ge "$SETTLE" ]; then break; fi
    sleep 1
  done
  systemctl is-active --quiet max-vision
  test "$(invocation max-vision)" = "$vision_id"
  # Diagnostics only: a failed write (full disk) must not fail the proof.
  systemctl show max-agent max-vision -p Id -p InvocationID -p ActiveEnterTimestamp -p MainPID --no-pager || true
}

check_release() {
  test "$(stat -c '%U:%G:%a' "$ROOT")" = root:root:755
  test -x "$ROOT/rdk/aec/max-aec"
  find "$ROOT/rdk/audio/alerts" -maxdepth 1 -type f -name '*.wav' -readable -print -quit | grep -q .
}

check_identity() {
  test "$(stat -c '%U:%G:%a' "$DEVICE_ID_PARENT")" = root:root:700
  test "$(stat -c '%U:%G:%a' "$DEVICE_ID")" = root:root:600
}

rollback() {
  say "rolling back to the previous release"
  if [ -d "$PREVIOUS" ]; then
    if [ -e "$ROOT" ]; then mv "$ROOT" "$FAILED"; fi
    mv "$PREVIOUS" "$ROOT"
  fi
  check_release
  install_units "$ROOT"
  restart_and_prove lenient
  check_identity
  test "$before" = "$(sha256sum "$DEVICE_ID" | cut -d' ' -f1)"
}

activate() {
  mv "$ROOT" "$PREVIOUS"
  mv "$STAGE" "$ROOT"
  check_release
  install_units "$ROOT"
  restart_and_prove strict
  test "$before" = "$(sha256sum "$DEVICE_ID" | cut -d' ' -f1)"
  check_identity
  # Proven, but without a relay session: reported as exit 3, never rolled back.
  if [ "$RELAY_STATE" != ready ]; then return 3; fi
}

preflight() {
  test -d "$ROOT"
  test ! -L "$ROOT"
  test -d "$STAGE"
  test ! -L "$STAGE"
  test "$(cat "$STAGE/.rdk-release-sha")" = "$SHA"
  test "$(stat -c '%U:%G:%a' "$ROOT")" = root:root:755
  test "$(stat -c '%U:%G:%a' "$STAGE")" = root:root:755
  check_identity
  test "$(stat -c '%U:%G:%a' "$ENV_FILE")" = root:root:600
  test ! -e "$PREVIOUS"
  test ! -e "$FAILED"
}

# All of it lives in main() and runs from the last line: `bash -s` reads the
# script from the ssh stream as it goes, and a connection that drops partway
# must not leave a half-read swap sequence behind. Nothing has moved yet before
# the last line, so a truncated script just does nothing.
main() {
  check_parent
  acquire_lock
  redirect_output
  # Preflight: nothing has moved yet, so a failure here needs no rollback.
  # (Not `if ! ( ... )`: that would switch errexit off inside the subshell.)
  set +e
  (
    set -e
    preflight
  )
  preflight_status=$?
  set -e
  if [ "$preflight_status" -ne 0 ]; then
    say "preflight failed; nothing was changed"
    set_status refused
    exit 64
  fi
  before=$(sha256sum "$DEVICE_ID" | cut -d' ' -f1)

  # Each phase runs in its own subshell with errexit set INSIDE it. Running it as
  # `if ! activate` or `activate || ...` would silently turn errexit off for
  # everything in it, and the first failed check would no longer stop the swap.
  # An EXIT trap cannot host the rollback either: bash does not re-fire a trap
  # from inside one, so a failure there would exit without saying so.
  set +e
  (
    set -e
    activate
  )
  status=$?
  if [ "$status" -eq 3 ]; then
    say "WARNING: $SHA is active and healthy, but the agent could not reach the relay; check the relay URL, token and network"
    say "the previous release is kept at $PREVIOUS"
    prune_old_runs
    set_status activated-relay-unreachable
    exit 3
  fi
  if [ "$status" -ne 0 ]; then
    say "activation failed (status $status)"
    (
      set -e
      rollback
    )
    rollback_status=$?
    if [ "$rollback_status" -ne 0 ]; then
      say "ROLLBACK FAILED: the board is not on a proven release; follow the manual rollback in rdk/README.md"
      set_status rollback-failed
      exit 2
    fi
    say "rolled back; the previous release is running. The failed release is kept at $FAILED"
    set_status rolled-back
    exit 1
  fi
  set -e

  say "device identity: stable"
  say "activated $SHA; the previous release is kept at $PREVIOUS until acceptance is complete"
  prune_old_runs
  set_status activated
}

main
