#!/usr/bin/env bash
# Puts examples/v0.85.0 on the proof's backend for the native build action,
# with the credentials a CI job's environment holds, except the ones the
# proof expects CI to miss:
#
# 1. the app's hot-updater.config.ts re-exports native-build.config.ts;
# 2. `db migrate` creates core's tables;
# 3. the release keystore is generated, as the one JSON value the CLI
#    reads from HOT_UPDATER_RELEASE_KEYSTORE for `secret("release-keystore")`;
#    play-service-account, widget-keystore, and asc-api-key stay missing.
#
# It needs the backend's variables (scripts/backend.sh) in its environment,
# and prints HOT_UPDATER_RELEASE_KEYSTORE as a NAME=value line.
#
# PROOF_APP_CONFIG names the config to re-export (default native-build.config.ts).
#
#   bash scripts/native-build-seed.sh <log-dir>
set -euo pipefail

log_dir="$1"
fixture="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$fixture/../.." && pwd)"
app="$root/examples/v0.85.0"
cli=(node "$root/packages/hot-updater/dist/index.mjs")
mkdir -p "$log_dir"

printf 'export { default } from "../../examples-server/preview-action/%s";\n' \
  "${PROOF_APP_CONFIG:-native-build.config.ts}" \
  >"$app/hot-updater.config.ts"

node "$fixture/proof.ts" create-bucket

(cd "$fixture" && "${cli[@]}" db migrate server.ts -y) >"$log_dir/migrate.log" 2>&1

work="$(mktemp -d)"
keytool -genkeypair -keystore "$work/release.jks" -storetype PKCS12 \
  -alias release -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass native-proof-pass -keypass native-proof-pass \
  -dname "CN=Native build proof" >/dev/null 2>&1
keystore="$(node -e '
  const fs = require("node:fs");
  process.stdout.write(JSON.stringify({
    keystore: fs.readFileSync(process.argv[1]).toString("base64"),
    storePassword: "native-proof-pass",
    keyAlias: "release",
    keyPassword: "native-proof-pass",
  }));
' "$work/release.jks")"
rm -rf "$work"

echo "HOT_UPDATER_RELEASE_KEYSTORE=$keystore"
