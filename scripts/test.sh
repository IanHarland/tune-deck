#!/usr/bin/env bash
# Run both suites. Backend (pytest) and frontend (vitest) are separate tool
# chains, so this just runs them in order and fails if either does.
#
#   scripts/test.sh          both suites
#   scripts/test.sh py       backend only
#   scripts/test.sh js       frontend only
set -euo pipefail
cd "$(dirname "$0")/.."

PY=".venv/bin/python"
[ -x "$PY" ] || PY="python3"

run_py() {
  echo "=== backend (pytest) ==="
  "$PY" -m pytest "$@"
}

run_js() {
  echo "=== frontend (vitest) ==="
  (cd frontend && npm test --silent)
}

case "${1:-all}" in
  py) shift; run_py "$@" ;;
  js) run_js ;;
  *)  run_py && run_js ;;
esac
