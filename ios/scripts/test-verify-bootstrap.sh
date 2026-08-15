#!/bin/sh

set -eu

ios_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
guard="$ios_dir/scripts/verify-bootstrap.sh"
fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/maxhelmet-bootstrap-test.XXXXXX")

cleanup() {
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT HUP INT TERM

alternate_dir="$fixture_root/alternate"
marker="$fixture_root/external-gemfile-evaluated"
mkdir -p "$alternate_dir"
cp "$ios_dir/scripts/fixtures/AlternateGemfile" "$alternate_dir/Gemfile"
cp "$ios_dir/Gemfile.lock" "$alternate_dir/Gemfile.lock"

MAXHELMET_BOOTSTRAP_MARKER="$marker" \
  BUNDLE_GEMFILE="$alternate_dir/Gemfile" \
  BUNDLE_PATH="$ios_dir/vendor/bundle" \
  bundle _4.0.16_ check >/dev/null
test -f "$marker"
rm -f -- "$marker"

MAXHELMET_BOOTSTRAP_MARKER="$marker" \
  BUNDLE_GEMFILE="$alternate_dir/Gemfile" \
  BUNDLE_PATH="$ios_dir/vendor/bundle" \
  "$guard" >/dev/null

if test -e "$marker"; then
  echo "verify-bootstrap.sh evaluated an externally supplied BUNDLE_GEMFILE" >&2
  exit 1
fi

empty_bundle="$fixture_root/empty-bundle"
mkdir -p "$empty_bundle"
BUNDLE_PATH="$empty_bundle" "$guard" >/dev/null

printf '%s\n' "verify-bootstrap.sh ignores external BUNDLE_GEMFILE and retains the local Bundler path."
