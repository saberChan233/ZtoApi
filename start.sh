#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${PORT:=9090}"
: "${DEFAULT_KEY:=sk-your-key}"
: "${DEBUG_MODE:=true}"
: "${DEFAULT_STREAM:=true}"
: "${DASHBOARD_ENABLED:=true}"
: "${AUTO_CAPTCHA_PURE_CODE_ENABLED:=true}"
: "${AUTO_CAPTCHA_PURE_CODE_LOADER_ONLY:=true}"
: "${AUTO_CAPTCHA_PURE_CODE_SCRIPT_FETCH_MODE:=auto}"
: "${AUTO_CAPTCHA_PURE_CODE_WORKER_MAX_OLD_SPACE_MB:=512}"

export PORT
export DEFAULT_KEY
export DEBUG_MODE
export DEFAULT_STREAM
export DASHBOARD_ENABLED
export AUTO_CAPTCHA_PURE_CODE_ENABLED
export AUTO_CAPTCHA_PURE_CODE_LOADER_ONLY
export AUTO_CAPTCHA_PURE_CODE_SCRIPT_FETCH_MODE
export AUTO_CAPTCHA_PURE_CODE_WORKER_MAX_OLD_SPACE_MB

for cmd in deno node curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "缺少依赖: $cmd" >&2
    exit 1
  fi
done

echo "==> 启动 ZtoApi"
echo "ROOT: $ROOT_DIR"
echo "PORT: $PORT"
echo "DEFAULT_KEY: ${DEFAULT_KEY:0:8}..."
echo "AUTO_CAPTCHA_PURE_CODE_ENABLED: $AUTO_CAPTCHA_PURE_CODE_ENABLED"
echo "AUTO_CAPTCHA_PURE_CODE_LOADER_ONLY: $AUTO_CAPTCHA_PURE_CODE_LOADER_ONLY"
echo
echo "访问地址:"
echo "  http://127.0.0.1:${PORT}/"
echo "  http://127.0.0.1:${PORT}/dashboard"
echo "  http://127.0.0.1:${PORT}/v1/models"
echo

exec deno run \
  --allow-net \
  --allow-env \
  --allow-read \
  --allow-write \
  --allow-run \
  main.ts
