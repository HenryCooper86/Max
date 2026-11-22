#!/usr/bin/env bash
# One-time (and safely repeatable) board setup: private state directories, the
# watchdog config, the systemd units and hardening drop-ins, and
# /etc/max/agent.env created at mode 0600 from prompted or environment values.
# Secrets are never echoed, never put on a command line, and never written to
# a log; they travel over ssh's standard input.
#
#   MAX_RELAY_URL=wss://relay.example.com/agent rdk/provision.sh --host root@board --dry-run
#   rdk/provision.sh --host root@board
#
# It does not install Node or apt packages (see the appendix in rdk/README.md)
# and does not deploy code: run rdk/deploy.sh afterwards.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

HOST=${RDK_HOST:-}
HARDEN=1
FORCE=0
ALLOW_CLEARTEXT=0

usage() {
  cat <<'USAGE'
usage: provision.sh --host [user@]host [options]

Values come from the environment, else a prompt (secrets are read silently):
  MAX_RELAY_URL      wss://... relay URL, without a token in it (required)
  MAX_RELAY_TOKEN    relay token; required against a relay that has accounts
  MAX_VISION_TOKEN   bench token. Port 8080 (HUD) is reachable from the LAN with
                     it; port 8081 (camera preview, gallery) listens on the board
                     only unless MAX_VISION_LISTEN=all is set in agent.env
                     (trusted bench network only). Empty keeps both board-only

  --host H           SSH target (or set RDK_HOST)
  --dry-run          Print every command (secrets redacted); run none of them.
  --force            Replace an existing /etc/max/agent.env. Without it an existing
                     file is kept (its mode is still corrected to 0600).
  --allow-cleartext  Accept a plain ws:// relay URL to a non-loopback host. Writes
                     MAX_REQUIRE_TLS=off; use only on a trusted bench LAN.
  --no-hardening     Install units without the hardening drop-ins.
  -h, --help         This text.
USAGE
}

while [ "$#" -gt 0 ]; do
  case $1 in
    --host)
      [ "$#" -ge 2 ] || die "--host needs a value"
      HOST=$2
      shift 2
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    --allow-cleartext) ALLOW_CLEARTEXT=1; shift ;;
    --no-hardening) HARDEN=0; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument '$1'" ;;
  esac
done

[ -n "$HOST" ] || die "--host (or RDK_HOST) is required"
validate_host "$HOST"

# --- values --------------------------------------------------------------------
# prompt VAR LABEL secret?  - fills VAR from the environment, else the terminal.
prompt() {
  local name=$1 label=$2 secret=$3 value=${!1:-}
  if [ -z "$value" ] && [ -t 0 ]; then
    if [ "$secret" = secret ]; then
      read -r -s -p "$label: " value
      printf '\n' >&2
    else
      read -r -p "$label: " value
    fi
  fi
  printf -v "$name" '%s' "$value"
}

MAX_RELAY_URL=${MAX_RELAY_URL:-}
MAX_RELAY_TOKEN=${MAX_RELAY_TOKEN:-}
MAX_VISION_TOKEN=${MAX_VISION_TOKEN:-}
prompt MAX_RELAY_URL "Relay URL (wss://host/agent)" plain
prompt MAX_RELAY_TOKEN "Relay token (empty if the relay is open)" secret
prompt MAX_VISION_TOKEN "Bench token for the HUD on :8080; :8081 stays board-only unless MAX_VISION_LISTEN=all (empty: board-only)" secret

[ -n "$MAX_RELAY_URL" ] || die "MAX_RELAY_URL is required"
# A closed character set: no whitespace, quotes, '#', newlines or '$', so a
# value cannot break out of its line in the env file. The URL may not carry a
# query string, because the token must never travel in the URL.
url_pattern='^wss?://[A-Za-z0-9._-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'
ipv6_pattern='^wss?://\[[0-9A-Fa-f:]+\](:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'
if ! [[ $MAX_RELAY_URL =~ $url_pattern ]] && ! [[ $MAX_RELAY_URL =~ $ipv6_pattern ]]; then
  die "MAX_RELAY_URL must look like wss://host[:port]/path with no query string or token in it"
fi
token_pattern='^[A-Za-z0-9._~+/=:-]*$'
[[ $MAX_RELAY_TOKEN =~ $token_pattern ]] || die "MAX_RELAY_TOKEN has characters that are not allowed in agent.env"
[[ $MAX_VISION_TOKEN =~ $token_pattern ]] || die "MAX_VISION_TOKEN has characters that are not allowed in agent.env"

REQUIRE_TLS=on
case $MAX_RELAY_URL in
  wss://*) ;;
  ws://localhost[:/]* | ws://127.*[:/]* | ws://\[::1\][:/]* | ws://localhost | ws://127.* | ws://\[::1\]) ;;
  *)
    [ "$ALLOW_CLEARTEXT" = 1 ] ||
      die "plain ws:// to a non-loopback host sends the token and microphone audio unencrypted; use wss://, or pass --allow-cleartext on a trusted bench LAN"
    REQUIRE_TLS=off
    note "WARNING: plain ws:// relay; MAX_REQUIRE_TLS=off. Do not ride with this."
    ;;
esac
[ -n "$MAX_RELAY_TOKEN" ] || note "note: MAX_RELAY_TOKEN is empty; a relay with accounts will refuse the agent with 401"
[ -n "$MAX_VISION_TOKEN" ] || note "note: MAX_VISION_TOKEN is empty; ports 8080 and 8081 answer 401 to everything but the board itself"

# render_env redact?  - the file body; redact replaces secrets for --dry-run.
render_env() {
  local relay_token=$MAX_RELAY_TOKEN vision_token=$MAX_VISION_TOKEN
  if [ "${1:-}" = redact ]; then
    if [ -n "$relay_token" ]; then relay_token='<redacted>'; fi
    if [ -n "$vision_token" ]; then vision_token='<redacted>'; fi
  fi
  cat <<ENV
MAX_RELAY_URL=$MAX_RELAY_URL
MAX_RELAY_TOKEN=$relay_token
MAX_REQUIRE_TLS=$REQUIRE_TLS
MAX_RELAY_INSECURE_TLS=0
# Durable per-board identity; preserve across upgrades.
MAX_DEVICE_ID_FILE=/var/lib/max/device-id
RDK_ALSA_CAPTURE=plughw:0,0
RDK_ALSA_PLAYBACK=plughw:0,0
MAX_GALLERY_DIR=/var/lib/max/gallery
MAX_GALLERY_MIN_FREE_MB=1024
MAX_HUD_PORT=8080
MAX_VISION_PREVIEW_PORT=8081
# The bench server listens on 127.0.0.1 only. Set MAX_VISION_LISTEN=all to reach
# it from the LAN with the token below (see "Bench access" in rdk/README.md).
# MAX_VISION_LISTEN=all
MAX_VISION_TOKEN=$vision_token
MAX_VISION_SOCKET=/run/max/vision.sock
RDK_CAMERA_FRONT=0
RDK_CAMERA_REAR=2
MAX_ADAS_SHADOW=0
MAX_VISION_SHARE=0
MAX_CORPUS_DIR=/var/lib/max/corpus
MAX_VOICE_GATE_RMS=900
MAX_VOICE_GATE_MS=400
ENV
}

# --- remote steps ---------------------------------------------------------------
# Fixed command strings: no value from the user or the environment is spliced in.
DIRS_CMD='install -d -o root -g root -m 0700 /var/lib/max /var/lib/max/gallery'

ENV_PRESENT_CMD='test -e /etc/max/agent.env && echo present || true'
ENV_WRITE_CMD='umask 077 && install -d -o root -g root -m 0755 /etc/max && cat >/etc/max/agent.env.new && chown root:root /etc/max/agent.env.new && chmod 0600 /etc/max/agent.env.new && mv -f /etc/max/agent.env.new /etc/max/agent.env'
ENV_FIX_CMD='chown root:root /etc/max/agent.env && chmod 0600 /etc/max/agent.env'

# shellcheck disable=SC2016  # $d and $s expand on the board, on purpose.
UNITS_COMMON='d=$(mktemp -d) && trap '"'"'rm -rf "$d"'"'"' EXIT && tar -xf - -C "$d" && install -d -o root -g root -m 0755 /etc/systemd/system.conf.d && install -o root -g root -m 0644 "$d/10-max-watchdog.conf" /etc/systemd/system.conf.d/ && install -o root -g root -m 0644 "$d"/max-agent.service "$d"/max-vision.service /etc/systemd/system/'
# shellcheck disable=SC2016
DROPINS_ON=' && for s in max-agent max-vision; do install -d -o root -g root -m 0755 "/etc/systemd/system/$s.service.d" && install -o root -g root -m 0644 "$d/$s.service.d/hardening.conf" "/etc/systemd/system/$s.service.d/hardening.conf"; done'
DROPINS_OFF=' && rm -f /etc/systemd/system/max-agent.service.d/hardening.conf /etc/systemd/system/max-vision.service.d/hardening.conf'
UNITS_FINISH=' && systemctl daemon-reexec && systemctl daemon-reload && systemctl enable max-agent max-vision'

run_remote_command "$HOST" "$DIRS_CMD"

present=$(query_remote "$HOST" "$ENV_PRESENT_CMD")
if [ "$present" = present ] && [ "$FORCE" != 1 ]; then
  note "/etc/max/agent.env already exists; keeping it (use --force to replace). Correcting owner and mode only."
  run_remote_command "$HOST" "$ENV_FIX_CMD"
elif [ "$DRY_RUN" = 1 ]; then
  printf '[dry-run] ssh %s %s   (stdin below, secrets redacted)\n' "$HOST" "$ENV_WRITE_CMD"
  render_env redact | sed 's/^/[dry-run]   /'
else
  render_env | run_remote_command "$HOST" "$ENV_WRITE_CMD"
fi

UNITS_CMD=$UNITS_COMMON
if [ "$HARDEN" = 1 ]; then UNITS_CMD+=$DROPINS_ON; else UNITS_CMD+=$DROPINS_OFF; fi
UNITS_CMD+=$UNITS_FINISH
if [ "$DRY_RUN" = 1 ]; then
  printf '[dry-run] tar -C %s -cf - . | ssh %s %s\n' "$SCRIPT_DIR/systemd" "$HOST" "$UNITS_CMD"
else
  COPYFILE_DISABLE=1 tar -C "$SCRIPT_DIR/systemd" -cf - . | run_remote_command "$HOST" "$UNITS_CMD"
fi

if [ "$DRY_RUN" = 1 ]; then
  note "[dry-run] nothing was run on the board"
else
  note "provisioned $HOST. Next: rdk/deploy.sh --host $HOST"
fi
