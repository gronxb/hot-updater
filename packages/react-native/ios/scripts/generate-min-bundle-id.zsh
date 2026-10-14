#!/bin/zsh
# Writes this build's MIN_BUNDLE_ID before every build of HotUpdater:
# - CocoaPods: HotUpdater.podspec runs it as a script phase, which writes
#   $(DERIVED_FILE_DIR)/HotUpdaterBuildMinBundleId.h for
#   HotUpdaterMinBundleId.m.
# - Swift Package Manager: Package.swift's build tool plugin runs it with
#   `--swift <dir>`, which writes <dir>/HotUpdaterBuildMinBundleId.swift.
# Both define HotUpdaterBuildMinBundleId(), which HotUpdater.mm returns in
# Release.
#
# MIN_BUNDLE_ID is a UUIDv7 with zeroed random bits on the same epoch
# millisecond clock as the bundle IDs `hot-updater deploy` issues, so a bundle
# built after this native build sorts after it. The hot-updater CLI passes its
# own value as HOT_UPDATER_MIN_BUNDLE_ID, which wins.
set -eu
zmodload zsh/datetime

min_bundle_id="${HOT_UPDATER_MIN_BUNDLE_ID:-}"

if [[ -n "$min_bundle_id" ]]; then
  min_bundle_id="${min_bundle_id:l}"
  if [[ ! "$min_bundle_id" =~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' ]]; then
    echo "error: HOT_UPDATER_MIN_BUNDLE_ID must be a UUIDv7, got: ${HOT_UPDATER_MIN_BUNDLE_ID}"
    exit 1
  fi
else
  integer timestamp_ms=$(( epochtime[1] * 1000 + epochtime[2] / 1000000 ))
  min_bundle_id=$(printf '%08x-%04x-7000-8000-000000000000' \
    $(( timestamp_ms >> 16 )) $(( timestamp_ms & 0xffff )))
fi

if [[ "${1:-}" == "--swift" ]]; then
  output="${2:?usage: generate-min-bundle-id.zsh --swift <output dir>}/HotUpdaterBuildMinBundleId.swift"
  mkdir -p "${output:h}"
  printf '%s\n' \
    'import Foundation' \
    '' \
    '@_cdecl("HotUpdaterBuildMinBundleId")' \
    'public func hotUpdaterBuildMinBundleId() -> NSString {' \
    "    \"$min_bundle_id\"" \
    '}' > "$output"
else
  output="${DERIVED_FILE_DIR}/HotUpdaterBuildMinBundleId.h"
  mkdir -p "${output:h}"
  printf '#define HOT_UPDATER_BUILD_MIN_BUNDLE_ID "%s"\n' "$min_bundle_id" > "$output"
fi
