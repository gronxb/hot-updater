#!/usr/bin/env bash
set -euo pipefail

UDID="${1:-}"
BUNDLE_ID="${2:-org.reactjs.native.example.HotUpdaterExample}"

if [[ -z "${UDID}" ]]; then
  UDID="$(xcrun simctl list devices booted | awk -F '[()]' '/Booted/ { print $2; exit }')"
fi

if [[ -z "${UDID}" ]]; then
  echo "No booted iOS simulator found." >&2
  exit 1
fi

DATA_DIR="$(xcrun simctl get_app_container "${UDID}" "${BUNDLE_ID}" data)"
DOCS_DIR="${DATA_DIR}/Documents"
STORE_DIR="${DOCS_DIR}/bundle-store"

echo "udid=${UDID}"
echo "bundle_id=${BUNDLE_ID}"
echo "data_dir=${DATA_DIR}"
echo

for path in \
  "${STORE_DIR}/metadata.json" \
  "${STORE_DIR}/launch-report.json" \
  "${STORE_DIR}/crashed-history.json"; do
  echo "== ${path} =="
  if [[ -f "${path}" ]]; then
    cat "${path}"
  else
    echo "MISSING"
  fi
  echo
done

echo "== bundle-store files =="
if [[ -d "${STORE_DIR}" ]]; then
  find "${STORE_DIR}" -maxdepth 2 -type f | sort
else
  echo "MISSING"
fi
