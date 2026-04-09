#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: run_fixci.sh <all|build|test:type|type|typecheck|lint|test|test:integration|integration> [log_root]

Run the FixCI command sequence from the current repository.
Logs are written to <log_root>/<timestamp>/.
EOF
}

normalize_step() {
  case "${1:-all}" in
    all | build | lint | test | test:integration | integration)
      printf '%s\n' "$1"
      ;;
    test:type | type | typecheck)
      printf 'test:type\n'
      ;;
    *)
      printf 'Unknown step: %s\n\n' "${1:-}" >&2
      usage >&2
      exit 2
      ;;
  esac
}

run_named_step() {
  local order="$1"
  local step_name="$2"
  shift 2

  local safe_name log_file status tail_pid
  safe_name="${step_name//:/-}"
  log_file="${LOG_DIR}/${order}-${safe_name}.log"

  printf '==> [%s] %s\n' "$step_name" "$*"

  : >"$log_file"
  {
    printf 'cwd: %s\n' "$PWD"
    printf 'step: %s\n' "$step_name"
    printf 'command: %s\n\n' "$*"
  } >>"$log_file"

  tail -n +1 -f "$log_file" &
  tail_pid=$!

  set +e
  "$@" >>"$log_file" 2>&1
  status=$?
  set -e

  kill "$tail_pid" >/dev/null 2>&1 || true
  wait "$tail_pid" 2>/dev/null || true

  if [[ $status -ne 0 ]]; then
    printf '\n[FAIL] %s\n' "$step_name" >&2
    printf 'log: %s\n' "$log_file" >&2
    return "$status"
  fi

  printf '\n[OK] %s\n' "$step_name"
  printf 'log: %s\n' "$log_file"
}

run_step() {
  case "$1" in
    build)
      run_named_step "01" "build" pnpm -w build
      ;;
    test:type)
      run_named_step "02" "test:type" pnpm -w test:type
      ;;
    lint)
      run_named_step "03" "lint" pnpm -w lint
      ;;
    test)
      run_named_step "04" "test" pnpm -w test
      ;;
    test:integration | integration)
      run_named_step "05" "test:integration" pnpm -w test:integration
      ;;
    *)
      printf 'Unsupported canonical step: %s\n' "$1" >&2
      exit 2
      ;;
  esac
}

INPUT_STEP="${1:-all}"
if [[ "$INPUT_STEP" == "-h" || "$INPUT_STEP" == "--help" ]]; then
  usage
  exit 0
fi

STEP="$(normalize_step "$INPUT_STEP")"
LOG_ROOT="${2:-.codex/fix-ci}"

if ! command -v pnpm >/dev/null 2>&1; then
  printf 'pnpm is required but was not found in PATH.\n' >&2
  exit 127
fi

if git_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  cd "$git_root"
fi

if [[ ! -f package.json && ! -f pnpm-workspace.yaml ]]; then
  printf 'Run this script inside a repository with package.json or pnpm-workspace.yaml.\n' >&2
  exit 2
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="${LOG_ROOT%/}/${TIMESTAMP}"
mkdir -p "$LOG_DIR"

printf 'log directory: %s\n' "$LOG_DIR"

if [[ "$STEP" == "all" ]]; then
  for current_step in build "test:type" lint test "test:integration"; do
    run_step "$current_step"
  done
  printf '\n[GREEN] Full FixCI sequence passed.\n'
else
  run_step "$STEP"
fi
