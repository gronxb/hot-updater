#!/bin/zsh
# Writes the fingerprint this build of the app embeds, before every build of
# HotUpdater:
# - CocoaPods: HotUpdater.podspec runs it as a script phase, which writes
#   $(DERIVED_FILE_DIR)/HotUpdaterBuildFingerprintHash.h for
#   HotUpdaterFingerprintHash.m.
# - Swift Package Manager: Package.swift's build tool plugin runs it with
#   `--swift <dir> <app root>`, which writes
#   <dir>/HotUpdaterBuildFingerprintHash.swift.
# Both define HotUpdaterBuildFingerprintHash(), which HotUpdater.mm returns.
#
# The app root is $HOT_UPDATER_APP_ROOT when set, else the root the caller
# passes, else two levels above $PODS_ROOT (<app>/ios/Pods). Without a
# fingerprint.json there, the app uses the appVersion strategy and the
# fingerprint is empty. A Debug build embeds the hash fingerprint.json holds;
# any other build runs `hot-updater fingerprint hash`, which computes it from
# the inputs fingerprint.json records, so the binary carries the fingerprint
# of the native interface it was built from.
set -eu

mode="objc"
output_dir="${DERIVED_FILE_DIR:-}"
app_root="${HOT_UPDATER_APP_ROOT:-}"
if [[ "${1:-}" == "--swift" ]]; then
  mode="swift"
  output_dir="${2:?usage: generate-fingerprint-hash.zsh --swift <output dir> <app root>}"
  [[ -z "$app_root" ]] && app_root="${3:-}"
fi
if [[ -z "$app_root" && -n "${PODS_ROOT:-}" ]]; then
  app_root="${PODS_ROOT:h:h}"
fi

fingerprint_hash=""
if [[ -n "$app_root" && -f "$app_root/fingerprint.json" ]]; then
  app_root="${app_root:A}"
  # React Native's own way to find node for Xcode builds.
  [[ -f "$app_root/ios/.xcode.env" ]] && source "$app_root/ios/.xcode.env"
  [[ -f "$app_root/ios/.xcode.env.local" ]] && source "$app_root/ios/.xcode.env.local"
  node_binary="${NODE_BINARY:-$(command -v node || true)}"
  if [[ -z "$node_binary" ]]; then
    echo "error: [HotUpdater] node was not found. Set NODE_BINARY in ios/.xcode.env.local."
    exit 1
  fi

  if [[ "${CONFIGURATION:-}" == "Debug" ]]; then
    fingerprint_hash=$("$node_binary" -e \
      'console.log(require(process.argv[1]).ios?.hash ?? "")' \
      "$app_root/fingerprint.json")
  else
    cli=$("$node_binary" -e '
      const path = require("node:path");
      const manifest = require.resolve("hot-updater/package.json", { paths: [process.argv[1]] });
      const { bin } = require(manifest);
      console.log(path.join(path.dirname(manifest), typeof bin === "string" ? bin : bin["hot-updater"]));
    ' "$app_root")
    fingerprint_hash=$(cd "$app_root" && "$node_binary" "$cli" fingerprint hash -p ios)
  fi
fi

if [[ "$mode" == "swift" ]]; then
  output="$output_dir/HotUpdaterBuildFingerprintHash.swift"
  mkdir -p "${output:h}"
  printf '%s\n' \
    'import Foundation' \
    '' \
    '@_cdecl("HotUpdaterBuildFingerprintHash")' \
    'public func hotUpdaterBuildFingerprintHash() -> NSString {' \
    "    \"$fingerprint_hash\"" \
    '}' > "$output"
else
  output="$output_dir/HotUpdaterBuildFingerprintHash.h"
  mkdir -p "${output:h}"
  printf '#define HOT_UPDATER_BUILD_FINGERPRINT_HASH "%s"\n' "$fingerprint_hash" > "$output"
fi
