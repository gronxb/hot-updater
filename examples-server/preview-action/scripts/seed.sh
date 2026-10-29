#!/usr/bin/env bash
# Puts examples/v0.85.0 on the proof's backend, as a project's owner would
# before turning the preview action on:
#
# 1. the app's hot-updater.config.ts re-exports app.config.ts;
# 2. `db migrate` creates core's tables;
# 3. a release keystore and a bundle signing key pair are generated, and the
#    preview build pins the public key;
# 4. the Console starts, for the comment's download links and QR codes.
#
# Every credential the action's CLI reads is a job variable, which the CLI
# reads as the config sets no secrets adapter: the keystore as one JSON
# value, HOT_UPDATER_ANDROID_KEYSTORE for `secret("android-keystore")`, and the
# signing key's path. It needs the backend's variables (scripts/backend.sh)
# in its environment, and prints those as NAME=value lines.
#
#   bash scripts/seed.sh <console-port> <log-dir> <key-dir>
set -euo pipefail

port="$1"
log_dir="$2"
key_dir="$3"
fixture="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$fixture/../.." && pwd)"
app="$root/examples/v0.85.0"
cli=(node "$root/packages/hot-updater/dist/index.mjs")
console_url="http://127.0.0.1:$port"
mkdir -p "$log_dir" "$key_dir"

printf 'export { default } from "../../examples-server/preview-action/app.config.ts";\n' \
  >"$app/hot-updater.config.ts"

node "$fixture/proof.ts" create-bucket

(cd "$fixture" && "${cli[@]}" db migrate server.ts -y) >"$log_dir/migrate.log" 2>&1

keytool -genkeypair -keystore "$key_dir/release.jks" -storetype PKCS12 \
  -alias preview -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass preview-keystore -keypass preview-keystore \
  -dname "CN=Preview" >/dev/null 2>&1
keystore="$(node -e '
  const fs = require("node:fs");
  process.stdout.write(JSON.stringify({
    keystore: fs.readFileSync(process.argv[1]).toString("base64"),
    storePassword: "preview-keystore",
    keyAlias: "preview",
    keyPassword: "preview-keystore",
  }));
' "$key_dir/release.jks")"
rm "$key_dir/release.jks"

# The preview build pins the public key the bundles are signed for.
(
  cd "$app"
  "${cli[@]}" keys generate -o "$key_dir/keys"
  PREVIEW_SIGNING_KEY_PATH="$key_dir/keys/private-key.pem" \
    "${cli[@]}" keys export-public -y
) >"$log_dir/keys.log" 2>&1

(
  cd "$app"
  PORT="$port" NITRO_PORT="$port" HOST=127.0.0.1 NITRO_HOST=127.0.0.1 \
    nohup node "$root/packages/console/.output/server/index.mjs" \
    >"$log_dir/console.log" 2>&1 &
  echo $! >"$log_dir/console.pid"
)
for _ in $(seq 60); do
  if curl -s -o /dev/null "$console_url/_hot-updater/native-builds/qr?build=019a0000-0000-7000-8000-000000000001"; then
    break
  fi
  sleep 1
done
curl -s -o /dev/null "$console_url/_hot-updater/native-builds/qr?build=019a0000-0000-7000-8000-000000000001"

echo "HOT_UPDATER_ANDROID_KEYSTORE=$keystore"
echo "PREVIEW_SIGNING_KEY_PATH=$key_dir/keys/private-key.pem"
