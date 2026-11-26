#!/bin/sh

set -eu

ios_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ios_dir"

ruby -e '
  require "rubygems"
  current = Gem::Version.new(RUBY_VERSION)
  minimum = Gem::Version.new("3.2.0")
  maximum = Gem::Version.new("5.0.0")
  supported = current >= minimum && current < maximum
  abort "Ruby #{current} is unsupported; use Homebrew Ruby 3.2 through 4.x." unless supported
'

bundler_version=$(BUNDLE_GEMFILE="$ios_dir/Gemfile" bundle --version | awk '{ print $NF }')
if [ "$bundler_version" != "4.0.16" ]; then
  echo "Bundler $bundler_version is unsupported; install and invoke Bundler 4.0.16." >&2
  exit 1
fi

BUNDLE_GEMFILE="$ios_dir/Gemfile" bundle check

cocoapods_version=$(BUNDLE_GEMFILE="$ios_dir/Gemfile" bundle exec pod --version)
case "$cocoapods_version" in
  1.17.*) ;;
  *)
    echo "CocoaPods $cocoapods_version is unsupported; the reviewed minor is 1.17.x." >&2
    exit 1
    ;;
esac

printf 'Ruby %s, Bundler %s, and CocoaPods %s are ready.\n' \
  "$(ruby -e 'print RUBY_VERSION')" \
  "$bundler_version" \
  "$cocoapods_version"
