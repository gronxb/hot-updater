#!/usr/bin/env bash
set -euo pipefail

service_port="${PORT:?PORT is required}"
port_pids="$(lsof -tiTCP:"${service_port}" -sTCP:LISTEN || true)"
if [[ -n "${port_pids}" ]]; then
  kill -9 ${port_pids}
fi

mkdir -p data
export TEST_DB_PATH="$(pwd)/data/prisma-${service_port}.db"
export DATABASE_URL="file:${TEST_DB_PATH}"
cp .env.hotupdater src/.env.hotupdater

./node_modules/.bin/prisma generate
node ../../packages/hot-updater/dist/index.mjs db generate src/db.ts --yes
RUST_LOG=info ./node_modules/.bin/prisma db push
node ../../packages/hot-updater/dist/index.mjs db migrate src/db.ts --yes
exec ./node_modules/.bin/tsx src/index.ts
