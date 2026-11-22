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
export CHAT_INTERNAL_WS="ws://127.0.0.1:${CHAT_PORT:-8081}/ws"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://43.129.182.26}"
export AI_MODE=rules ALLOW_EXTERNAL_EMAIL=0 SMTP_HOST=127.0.0.1 SMTP_PORT=1025
unset SMTP_USERNAME SMTP_PASSWORD SMTP_SSL
cmake -S . -B build >/dev/null
cmake --build build -j2 >/dev/null
pids=()
cleanup() { trap - EXIT INT TERM; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait || true; }
trap cleanup EXIT INT TERM
./build/chat_server --anonymous-loopback --port "${CHAT_PORT:-8081}" --ttl 86400 >"$ASSISTANT_STATE/chat.log" 2>&1 & pids+=("$!")
"$PYTHON" assistant/service.py capture >"$ASSISTANT_STATE/inbox.log" 2>&1 & pids+=("$!")
"$PYTHON" assistant/service.py serve >"$ASSISTANT_STATE/api.log" 2>&1 & pids+=("$!")
"$PYTHON" assistant/service.py worker >"$ASSISTANT_STATE/worker.log" 2>&1 & pids+=("$!")
printf '本地预览 http://127.0.0.1:8090\n真实本地 SMTP 收件箱 http://127.0.0.1:8025\n所有提醒仅投递 @example.test，本地规则提取，非 AI。\n'
# Exit as soon as a service fails, rather than leaving a half-working demo.
wait -n "${pids[@]}"
