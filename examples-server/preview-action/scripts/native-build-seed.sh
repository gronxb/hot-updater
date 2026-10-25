#!/usr/bin/env bash
# Puts examples/v0.85.0 on the proof's backend for the native build action,
# with a vault that holds what a project stored once from a laptop, except
# the credentials the proof expects CI to miss:
#
# 1. the app's hot-updater.config.ts re-exports native-build.config.ts;
# 2. `db migrate` creates core's tables and the vault's;
# 3. a write-only token stores deploy-credentials and release-keystore
#    through the Console, which this script starts with a new master key;
#    play-service-account, widget-keystore, and asc-api-key stay missing;
# 4. a CI token reads all five by name, and a narrow one reads only
#    deploy-credentials.
#
# It needs the backend's variables (scripts/backend.sh) in its environment,
# and prints the Console's URL, the two CI tokens, and the write token,
# which stores play-service-account later in the proof, as NAME=value lines.
#
#   bash scripts/native-build-seed.sh <console-port> <log-dir>
set -euo pipefail

port="$1"
log_dir="$2"
fixture="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$fixture/../.." && pwd)"
app="$root/examples/v0.85.0"
cli=(node "$root/packages/hot-updater/dist/index.mjs")
console_url="http://127.0.0.1:$port"
names="deploy-credentials,release-keystore,play-service-account,widget-keystore,asc-api-key"
mkdir -p "$log_dir"

token_of() {
  grep -Eo 'hu_vault_[A-Za-z0-9_-]+' "$1" | head -n 1
}

printf 'export { default } from "../../examples-server/preview-action/native-build.config.ts";\n' \
  >"$app/hot-updater.config.ts"

node "$fixture/proof.ts" create-bucket

(cd "$fixture" && "${cli[@]}" db migrate server.ts -y) >"$log_dir/migrate.log" 2>&1

(cd "$fixture" && "${cli[@]}" secrets token create --name native-build-seed \
  --secrets "$names" --actions write server.ts) >"$log_dir/seed-token.log" 2>&1
write_token="$(token_of "$log_dir/seed-token.log")"
(cd "$fixture" && "${cli[@]}" secrets token create --name ci-native \
  --secrets "$names" --actions read server.ts) >"$log_dir/ci-token.log" 2>&1
ci_token="$(token_of "$log_dir/ci-token.log")"
(cd "$fixture" && "${cli[@]}" secrets token create --name ci-narrow \
  --secrets deploy-credentials --actions read server.ts) >"$log_dir/narrow-token.log" 2>&1
narrow_token="$(token_of "$log_dir/narrow-token.log")"

master_key="$(openssl rand -base64 32)"
(
  cd "$app"
  env -u HOT_UPDATER_CONSOLE_URL -u HOT_UPDATER_VAULT_TOKEN \
    HOT_UPDATER_VAULT_MASTER_KEY="$master_key" PORT="$port" NITRO_PORT="$port" \
    HOST=127.0.0.1 NITRO_HOST=127.0.0.1 \
    nohup node "$root/packages/console/.output/server/index.mjs" \
    >"$log_dir/console.log" 2>&1 &
  echo $! >"$log_dir/console.pid"
)
for _ in $(seq 60); do
  if curl -s -o /dev/null "$console_url/_hot-updater/vault/v1/secrets"; then
    break
  fi
  sleep 1
done
curl -s -o /dev/null "$console_url/_hot-updater/vault/v1/secrets"

work="$(mktemp -d)"
keytool -genkeypair -keystore "$work/release.jks" -storetype PKCS12 \
  -alias release -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass release-keystore -keypass release-keystore \
  -dname "CN=Native build proof" >/dev/null 2>&1

(
  cd "$app"
  export HOT_UPDATER_CONSOLE_URL="$console_url"
  export HOT_UPDATER_VAULT_TOKEN="$write_token"
  "${cli[@]}" secrets put deploy-credentials --kind deploy-credentials \
    HOT_UPDATER_DATABASE_URL HOT_UPDATER_S3_ENDPOINT HOT_UPDATER_S3_REGION \
    HOT_UPDATER_S3_BUCKET_NAME HOT_UPDATER_S3_ACCESS_KEY_ID \
    HOT_UPDATER_S3_SECRET_ACCESS_KEY
  HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD=release-keystore \
    HOT_UPDATER_ANDROID_KEY_PASSWORD=release-keystore \
    "${cli[@]}" secrets put release-keystore --kind android-keystore \
    --keystore "$work/release.jks" --key-alias release
) >"$log_dir/seed-secrets.log" 2>&1
rm -rf "$work"

echo "HOT_UPDATER_CONSOLE_URL=$console_url"
echo "PROOF_CI_TOKEN=$ci_token"
echo "PROOF_NARROW_TOKEN=$narrow_token"
echo "PROOF_WRITE_TOKEN=$write_token"
