#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node --experimental-strip-types "${SCRIPT_DIR}/run-flow.ts" --platform ios "$@"
