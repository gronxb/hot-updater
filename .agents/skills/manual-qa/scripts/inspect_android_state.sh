#!/usr/bin/env bash
set -euo pipefail

SERIAL="${1:-}"
PACKAGE_NAME="${2:-com.hotupdaterexample}"

ADB_ARGS=()
if [[ -n "${SERIAL}" ]]; then
  ADB_ARGS+=(-s "${SERIAL}")
fi

ANDROID_DATA_DIR="/sdcard/Android/data/${PACKAGE_NAME}/files"

echo "serial=${SERIAL:-default}"
echo "package_name=${PACKAGE_NAME}"
echo "data_dir=${ANDROID_DATA_DIR}"
echo

read_file() {
  local path="$1"
  echo "== ${path} =="
  if adb "${ADB_ARGS[@]}" shell "[ -f '${path}' ]" >/dev/null 2>&1; then
    adb "${ADB_ARGS[@]}" shell "cat '${path}'"
  else
    echo "MISSING"
  fi
  echo
}

read_file "${ANDROID_DATA_DIR}/bundle-store/metadata.json"
read_file "${ANDROID_DATA_DIR}/bundle-store/launch-report.json"
read_file "${ANDROID_DATA_DIR}/bundle-store/crashed-history.json"

echo "== bundle-store files =="
if adb "${ADB_ARGS[@]}" shell "[ -d '${ANDROID_DATA_DIR}/bundle-store' ]" >/dev/null 2>&1; then
  adb "${ADB_ARGS[@]}" shell "find '${ANDROID_DATA_DIR}/bundle-store' -maxdepth 2 -type f | sort"
else
  echo "MISSING"
fi
