#!/usr/bin/env bash
# Local preview ONLY. Never deploys or sends outside the box.
set -euo pipefail
cd "$(dirname "$0")/.."
export ASSISTANT_STATE="${ASSISTANT_STATE:-$PWD/.local-v2}"
mkdir -p "$ASSISTANT_STATE"
chmod 700 "$ASSISTANT_STATE"
export PYTHON="${PYTHON:-$PWD/.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then echo '先运行 python3 -m venv .venv && .venv/bin/pip install -r assistant/requirements.txt'; exit 1; fi
export ASSISTANT_SHARED_SECRET="${ASSISTANT_SHARED_SECRET:-$("$PYTHON" -c 'import secrets; print(secrets.token_hex(32))')}"
chat_args=(--anonymous-loopback)
gateway_url=http://127.0.0.1:8090
export CHAT_INTERNAL_WS="ws://127.0.0.1:${CHAT_PORT:-8081}/ws"
unset GATEWAY_TLS_CERT GATEWAY_TLS_KEY
if [[ ${1:-} == --accounts ]]; then
  cert_dir="${PREVIEW_TLS_DIR:-$PWD/tls/certs}"
  if [[ ! -r "$cert_dir/server.crt" || ! -r "$cert_dir/server.key" || ! -r "$cert_dir/ca.crt" ]]; then
    echo '请先用 python3 tls/make_certs.py 生成预览证书'
    exit 1
  fi
  account_db="${PREVIEW_ACCOUNT_DB:-$ASSISTANT_STATE/accounts.sqlite3}"
  export ACCOUNTS_DB="$account_db"
  export CHAT_INTERNAL_WS="wss://127.0.0.1:${CHAT_PORT:-8081}/ws"
  export CHAT_CA_FILE="$cert_dir/ca.crt"
  export GATEWAY_TLS_CERT="$cert_dir/server.crt" GATEWAY_TLS_KEY="$cert_dir/server.key"
  chat_args=(--accounts "$account_db" --cert "$GATEWAY_TLS_CERT" --key "$GATEWAY_TLS_KEY")
  gateway_url=https://127.0.0.1:8090
elif [[ $# -ne 0 ]]; then
  echo '用法：scripts/preview-v2.sh [--accounts]'
  exit 1
fi
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://43.129.182.26}"
export AI_MODE=rules ALLOW_EXTERNAL_EMAIL=0 SMTP_HOST=127.0.0.1 SMTP_PORT=1025
export REGISTRATION_EMAIL=0
unset SMTP_USERNAME SMTP_PASSWORD SMTP_SSL
cmake -S . -B build >/dev/null
cmake --build build -j2 >/dev/null
pids=()
cleanup() { trap - EXIT INT TERM; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait || true; }
trap cleanup EXIT INT TERM
./build/chat_server "${chat_args[@]}" --port "${CHAT_PORT:-8081}" --ttl 86400 >"$ASSISTANT_STATE/chat.log" 2>&1 & pids+=("$!")
"$PYTHON" assistant/service.py capture >"$ASSISTANT_STATE/inbox.log" 2>&1 & pids+=("$!")
"$PYTHON" assistant/service.py serve >"$ASSISTANT_STATE/api.log" 2>&1 & pids+=("$!")
"$PYTHON" assistant/service.py worker >"$ASSISTANT_STATE/worker.log" 2>&1 & pids+=("$!")
printf '本地预览 %s\n真实本地 SMTP 收件箱 http://127.0.0.1:8025\n邮件只投递到本地 @example.test 收件箱。群聊助手使用固定演示回复。\n' "$gateway_url"
while :; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      exit 1
    fi
  done
  sleep 1
done
