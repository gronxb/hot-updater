#!/usr/bin/env bash
set -euo pipefail

service_port="${PORT:?PORT is required}"
mongo_port=$((service_port + 24000))
export COMPOSE_PROJECT_NAME="hot-updater-mongodb-${service_port}"

docker compose down -v --remove-orphans >/dev/null 2>&1 || true
rm -f .env.hotupdater src/.env.hotupdater

port_pids="$(lsof -tiTCP:"${service_port}" -sTCP:LISTEN || true)"
if [[ -n "${port_pids}" ]]; then
  kill -9 ${port_pids}
fi

mongo_pids="$(lsof -tiTCP:"${mongo_port}" -sTCP:LISTEN || true)"
if [[ -n "${mongo_pids}" ]]; then
  kill -9 ${mongo_pids}
fi
