#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/e2e-env.sh"

docker rm -f "${COSMOS_CONTAINER}" "${AZURITE_CONTAINER}" >/dev/null 2>&1 || true
