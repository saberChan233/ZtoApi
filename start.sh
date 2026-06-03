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
: "${AUTO_CAPTCHA_BACKGROUND_PREFETCH:=true}"
: "${AUTO_CAPTCHA_PURE_CODE_LOADER_ONLY:=true}"
: "${AUTO_CAPTCHA_PURE_CODE_SCRIPT_FETCH_MODE:=auto}"
: "${AUTO_CAPTCHA_PURE_CODE_WORKER_MAX_OLD_SPACE_MB:=512}"
: "${OPENAI_ENABLED:=}"
: "${ANTHROPIC_ENABLED:=}"
: "${OLLAMA_ENABLED:=}"

export PORT
export DEFAULT_KEY
export DEBUG_MODE
export DEFAULT_STREAM
export DASHBOARD_ENABLED
export AUTO_CAPTCHA_PURE_CODE_ENABLED
export AUTO_CAPTCHA_BACKGROUND_PREFETCH
export AUTO_CAPTCHA_PURE_CODE_LOADER_ONLY
export AUTO_CAPTCHA_PURE_CODE_SCRIPT_FETCH_MODE
export AUTO_CAPTCHA_PURE_CODE_WORKER_MAX_OLD_SPACE_MB
export OPENAI_ENABLED
export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.openai.com/v1}"
export OPENAI_MODELS="${OPENAI_MODELS:-}"
export ANTHROPIC_ENABLED
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com/v1}"
export ANTHROPIC_MODELS="${ANTHROPIC_MODELS:-}"
export OLLAMA_ENABLED
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434/v1}"
export OLLAMA_MODELS="${OLLAMA_MODELS:-}"
export CUSTOM_PROVIDER_IDS="${CUSTOM_PROVIDER_IDS:-}"

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
echo "AUTO_CAPTCHA_BACKGROUND_PREFETCH: $AUTO_CAPTCHA_BACKGROUND_PREFETCH"
echo "AUTO_CAPTCHA_PURE_CODE_LOADER_ONLY: $AUTO_CAPTCHA_PURE_CODE_LOADER_ONLY"
echo "OPENAI_ENABLED: ${OPENAI_ENABLED:-auto}"
echo "ANTHROPIC_ENABLED: ${ANTHROPIC_ENABLED:-auto}"
echo "OLLAMA_ENABLED: ${OLLAMA_ENABLED:-auto}"
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
