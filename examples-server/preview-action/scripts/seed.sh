#!/usr/bin/env bash
# Puts examples/v0.85.0 on the proof's backend and seeds the vault, as a
# project's owner would before turning the preview action on:
#
# 1. the app's hot-updater.config.ts re-exports app.config.ts;
# 2. `db migrate` creates core's tables and the vault's;
# 3. a write-only vault token stores deploy-credentials, the release
#    keystore, and the bundle signing key through the Console, which this
#    script starts with a new master key;
# 4. a read+sign token, the action's only secret beside the Console's URL,
#    reaches those three, and embeds the signing key's public half.
#
# It needs the backend's variables (scripts/backend.sh) in its environment,
# and prints the Console's URL and the action's token as NAME=value lines.
#
#   bash scripts/seed.sh <console-port> <log-dir>
set -euo pipefail

port="$1"
log_dir="$2"
fixture="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$fixture/../.." && pwd)"
app="$root/examples/v0.85.0"
cli=(node "$root/packages/hot-updater/dist/index.mjs")
console_url="http://127.0.0.1:$port"
mkdir -p "$log_dir"

token_of() {
  grep -Eo 'hu_vault_[A-Za-z0-9_-]+' "$1" | head -n 1
}

printf 'export { default } from "../../examples-server/preview-action/app.config.ts";\n' \
  >"$app/hot-updater.config.ts"

node "$fixture/proof.ts" create-bucket

(cd "$fixture" && "${cli[@]}" db migrate server.ts -y) >"$log_dir/migrate.log" 2>&1

(cd "$fixture" && "${cli[@]}" secrets token create --name preview-seed \
  --secrets deploy-credentials,android-keystore,bundle-signing-key \
  --actions write server.ts) >"$log_dir/seed-token.log" 2>&1
write_token="$(token_of "$log_dir/seed-token.log")"

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
  -alias preview -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass preview-keystore -keypass preview-keystore \
  -dname "CN=Preview" >/dev/null 2>&1

(
  cd "$app"
  export HOT_UPDATER_CONSOLE_URL="$console_url"
  export HOT_UPDATER_VAULT_TOKEN="$write_token"
  "${cli[@]}" secrets put deploy-credentials --kind deploy-credentials \
    HOT_UPDATER_DATABASE_URL HOT_UPDATER_S3_ENDPOINT HOT_UPDATER_S3_REGION \
    HOT_UPDATER_S3_BUCKET_NAME HOT_UPDATER_S3_ACCESS_KEY_ID \
    HOT_UPDATER_S3_SECRET_ACCESS_KEY
  HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD=preview-keystore \
    HOT_UPDATER_ANDROID_KEY_PASSWORD=preview-keystore \
    "${cli[@]}" secrets put android-keystore --kind android-keystore \
    --keystore "$work/release.jks" --key-alias preview
  "${cli[@]}" keys generate --vault -o "$work/keys"
) >"$log_dir/seed-secrets.log" 2>&1
rm -rf "$work"

(cd "$fixture" && "${cli[@]}" secrets token create --name preview-action \
  --secrets deploy-credentials,android-keystore,bundle-signing-key \
  --actions read,sign server.ts) >"$log_dir/action-token.log" 2>&1
action_token="$(token_of "$log_dir/action-token.log")"

# The preview build pins the vault's public key, which the Console signs
# bundles for. Only the two connection variables reach the CLI.
(
  cd "$app"
  env -i PATH="$PATH" HOME="$HOME" \
    HOT_UPDATER_CONSOLE_URL="$console_url" \
    HOT_UPDATER_VAULT_TOKEN="$action_token" \
    HOT_UPDATER_SIGNING_TOKEN="$action_token" \
    "${cli[@]}" keys export-public -y
) >"$log_dir/export-public.log" 2>&1

echo "HOT_UPDATER_CONSOLE_URL=$console_url"
echo "PREVIEW_VAULT_TOKEN=$action_token"
