#!/usr/bin/env bash
set -euo pipefail

service_port="${PORT:?PORT is required}"
port_pids="$(lsof -tiTCP:"${service_port}" -sTCP:LISTEN || true)"
if [[ -n "${port_pids}" ]]; then
  kill -9 ${port_pids}
fi

mkdir -p data
export TEST_DB_PATH="$(pwd)/data/hot-updater-${service_port}.db"
# Each run starts from an empty database; an older layout is never converted.
rm -f "${TEST_DB_PATH}" "${TEST_DB_PATH}-wal" "${TEST_DB_PATH}-shm"
cp .env.hotupdater src/.env.hotupdater

node ../../packages/hot-updater/dist/index.mjs db generate src/db.ts --yes
./node_modules/.bin/drizzle-kit push
# drizzle-kit creates the tables; db migrate writes the settings rows the server checks.
node ../../packages/hot-updater/dist/index.mjs db migrate src/db.ts --yes
exec ./node_modules/.bin/tsx src/index.ts
