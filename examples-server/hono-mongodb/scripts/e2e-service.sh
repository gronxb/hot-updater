#!/usr/bin/env bash
set -euo pipefail

service_port="${PORT:?PORT is required}"
mongo_port=$((service_port + 24000))
export COMPOSE_PROJECT_NAME="hot-updater-mongodb-${service_port}"
export HOT_UPDATER_E2E_MONGODB_PORT="${mongo_port}"

port_pids="$(lsof -tiTCP:"${service_port}" -sTCP:LISTEN || true)"
if [[ -n "${port_pids}" ]]; then
  kill -9 ${port_pids}
fi

mongo_pids="$(lsof -tiTCP:"${mongo_port}" -sTCP:LISTEN || true)"
if [[ -n "${mongo_pids}" ]]; then
  kill -9 ${mongo_pids}
fi

docker compose down -v --remove-orphans >/dev/null 2>&1 || true
docker compose up -d --remove-orphans

for attempt in $(seq 1 60); do
  if docker compose exec -T mongodb mongosh --quiet --eval 'try { rs.status().myState } catch (error) { 0 }' | grep -q 1; then
    echo "mongodb-ready port=${mongo_port} attempt=${attempt}"
    break
  fi
  if [[ "${attempt}" = "60" ]]; then
    echo "mongodb-not-ready port=${mongo_port}" >&2
    exit 1
  fi
  sleep 1
done

export TEST_MONGODB_URL="mongodb://localhost:${mongo_port}/hot_updater_${service_port}?replicaSet=rs0&directConnection=true"
cp .env.hotupdater src/.env.hotupdater
node ../../packages/hot-updater/dist/index.mjs db migrate src/db.ts --yes
exec bun src/index.ts
