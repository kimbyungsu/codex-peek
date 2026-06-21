#!/usr/bin/env sh
# codex-bridge 설치 런처 (Windows Git Bash / macOS / Linux)
# 실제 작업은 install.js(node 코어)가 한다 — 이 래퍼는 node로 넘겨주기만.
# 사용법: sh install.sh [--dry-run | uninstall [--purge] | status | --help]
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "❌ node 를 찾을 수 없습니다. Node.js 설치 후 다시 실행하세요." >&2
  exit 1
fi
exec node "$DIR/install.js" "$@"
