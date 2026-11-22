# shellcheck shell=bash
# Shared by rdk/deploy.sh and rdk/provision.sh. Sourced, never run.
#
# Everything that reaches the board goes through run_remote_* so that --dry-run
# can print it instead of running it, and so that every value interpolated into
# a remote command line has first been matched against a closed character set.

DRY_RUN=0
# Overridable so a test can substitute a recorder for ssh; never taken from a
# remote host.
RDK_SSH=${RDK_SSH:-ssh}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*" >&2
}

# [user@]host, no leading dash (an ssh option), no whitespace, quotes or shell
# metacharacters. IPv6 literals and ports belong in ~/.ssh/config as an alias.
validate_host() {
  local host=$1
  local pattern='^([A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$'
  [[ $host =~ $pattern ]] || die "invalid host '$host' (expected [user@]host; use an ssh config alias for anything else)"
}

# Absolute, no '..', no repeated or trailing slash, closed character set.
validate_abs_path() {
  local label=$1 path=$2
  local pattern='^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
  [[ $path =~ $pattern ]] || die "$label must be a plain absolute path, got '$path'"
  case $path in
    *..*) die "$label must not contain '..', got '$path'" ;;
  esac
}

validate_sha() {
  local pattern='^[0-9a-f]{40}$'
  [[ $1 =~ $pattern ]] || die "expected a full 40-character lowercase Git SHA, got '$1'"
}

_remote_arg_ok() {
  local pattern='^[A-Za-z0-9._/:=+-]*$'
  [[ $1 =~ $pattern ]]
}

_ssh() {
  "$RDK_SSH" -o ConnectTimeout=15 "$@"
}

# run_remote_script HOST SCRIPT_FILE ARG...
# Streams SCRIPT_FILE to `bash -s` on the board. Arguments are re-validated here
# because ssh joins them into one string the remote shell parses again.
run_remote_script() {
  local host=$1 script=$2
  shift 2
  local arg
  for arg in "$@"; do
    _remote_arg_ok "$arg" || die "refusing to send unsafe argument to the board: '$arg'"
  done
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] ssh %s bash -s --' "$host"
    printf ' %s' "$@"
    printf '\n[dry-run] --- begin %s ---\n' "$(basename "$script")"
    sed 's/^/[dry-run]   /' "$script"
    printf '[dry-run] --- end %s ---\n' "$(basename "$script")"
    return 0
  fi
  _ssh "$host" bash -s -- "$@" <"$script"
}

# run_remote_command HOST COMMAND
# COMMAND is a fixed string written in this repository, never built from input.
# Standard input is passed through, which is how archives and secrets travel
# without appearing in any argument list.
run_remote_command() {
  local host=$1 command=$2
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] ssh %s %s\n' "$host" "$command"
    return 0
  fi
  _ssh "$host" "$command"
}

# Like run_remote_command but captures output; empty in a dry run.
query_remote() {
  local host=$1 command=$2
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] ssh %s %s\n' "$host" "$command" >&2
    return 0
  fi
  _ssh "$host" "$command"
}
