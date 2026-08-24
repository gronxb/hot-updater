#!/usr/bin/env bash
set -euo pipefail

rm -f .env.hotupdater src/.env.hotupdater
if [[ -n "${PORT:-}" ]]; then
  port_pids="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN || true)"
  if [[ -n "${port_pids}" ]]; then
    kill -9 ${port_pids}
  fi
fi
