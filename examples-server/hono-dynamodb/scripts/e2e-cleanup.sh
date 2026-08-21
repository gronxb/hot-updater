#!/usr/bin/env bash
set -euo pipefail

service_port="${PORT:?PORT is required}"
export DYNAMODB_PORT=$((service_port + 18000))
export MINIO_API_PORT=$((service_port + 16000))
export MINIO_CONSOLE_PORT=$((service_port + 17000))
export COMPOSE_PROJECT_NAME="hot-updater-hono-dynamodb-${service_port}"

docker compose down -v --remove-orphans >/dev/null 2>&1 || true
