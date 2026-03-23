#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENARIO_PATH="${SCRIPT_DIR}/../../.maestro/scenarios/release-ota-recovery.yaml"

node "${SCRIPT_DIR}/run-maestro-scenario.mjs" \
  --platform android \
  --scenario "${SCENARIO_PATH}" \
  "$@"
