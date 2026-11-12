#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
PYTHON_BIN="${PYTHON_BIN:-python3}"
if [[ ! -x .venv/bin/python ]]; then
  "$PYTHON_BIN" -m venv .venv
fi
.venv/bin/python -c 'import sys; assert sys.version_info >= (3,11), "Python 3.11+ required"'
.venv/bin/python -m pip install --disable-pip-version-check -r backend/requirements.txt
(
  cd frontend
  npm ci --no-audit --no-fund
  npm run build
)
printf '\nCapability Launcher: http://127.0.0.1:8000\n\n'
exec .venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
