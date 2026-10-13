#!/usr/bin/env bash
# The managed Azure server on emulators: the Cosmos DB vNext emulator, Azurite,
# and the Function `hot-updater init` deploys, run by Azure Functions Core
# Tools behind e2e-host.mjs on PORT.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/e2e-env.sh"

docker rm -f "${COSMOS_CONTAINER}" "${AZURITE_CONTAINER}" >/dev/null 2>&1 || true
docker run -d --rm --name "${COSMOS_CONTAINER}" \
  -p "127.0.0.1:${COSMOS_PORT}:${COSMOS_PORT}" \
  mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-latest \
  --port "${COSMOS_PORT}" --enable-explorer false --enable-telemetry false >/dev/null
docker run -d --rm --name "${AZURITE_CONTAINER}" \
  -p "127.0.0.1:${AZURITE_PORT}:10000" \
  mcr.microsoft.com/azure-storage/azurite:3.37.0 \
  azurite-blob --blobHost 0.0.0.0 --inMemoryPersistence --skipApiVersionCheck --loose >/dev/null

for attempt in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${COSMOS_PORT}/" >/dev/null 2>&1 &&
    curl -sS "http://127.0.0.1:${AZURITE_PORT}/devstoreaccount1?comp=list" >/dev/null 2>&1; then
    echo "emulators-ready cosmos=${COSMOS_PORT} azurite=${AZURITE_PORT} attempt=${attempt}"
    break
  fi
  if [[ "${attempt}" = "120" ]]; then
    echo "emulators-not-ready cosmos=${COSMOS_PORT} azurite=${AZURITE_PORT}" >&2
    exit 1
  fi
  sleep 1
done

# The bootstrap creates the container and the database, writes the schema
# settings, and registers the E2E API key, as init does.
pnpm e2e:bootstrap

# The Function App init deploys, from the built @hot-updater/azure.
app_dir="$(mktemp -d "${TMPDIR:-/tmp}/hot-updater-azure-function-XXXXXX")"
function_dir="$(node -p 'require("path").dirname(require.resolve("@hot-updater/azure/package.json"))')/dist/functions"
cp "${function_dir}/index.mjs" "${function_dir}/host.json" "${app_dir}/"
node -e '
const fs = require("fs");
const [dir] = process.argv.slice(1);
fs.writeFileSync(`${dir}/package.json`, JSON.stringify({ name: "hot-updater-azure-function", private: true, type: "module", main: "index.mjs" }));
fs.writeFileSync(`${dir}/local.settings.json`, JSON.stringify({
  IsEncrypted: false,
  Values: {
    FUNCTIONS_WORKER_RUNTIME: "node",
    AzureWebJobsStorage: "",
    HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING: process.env.HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING,
    HOT_UPDATER_AZURE_BLOB_CONTAINER: process.env.HOT_UPDATER_AZURE_BLOB_CONTAINER,
    HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING: process.env.HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING,
  },
}));
' "${app_dir}"

exec node "${script_dir}/e2e-host.mjs" "${app_dir}"
