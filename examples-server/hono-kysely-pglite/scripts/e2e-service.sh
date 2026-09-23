#!/usr/bin/env bash
set -euo pipefail

service_port="${PORT:?PORT is required}"
port_pids="$(lsof -tiTCP:"${service_port}" -sTCP:LISTEN || true)"
if [[ -n "${port_pids}" ]]; then
  kill -9 ${port_pids}
fi

mkdir -p data
export TEST_DB_PATH="$(pwd)/data/kysely-${service_port}"
# Each run starts from an empty database; an older layout is never converted.
rm -rf "${TEST_DB_PATH}"
cp .env.hotupdater src/.env.hotupdater

node ../../packages/hot-updater/dist/index.mjs db generate src/db.ts --yes
node ../../packages/hot-updater/dist/index.mjs db migrate src/db.ts --yes
exec ./node_modules/.bin/tsx src/index.ts
