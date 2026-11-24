#!/usr/bin/env bash
set -euo pipefail

project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ -r $project/REVISION ]] || { printf '%s\n' '请从带有 REVISION 的云端部署包运行。' >&2; exit 1; }
revision=$(cat "$project/REVISION")
[[ $revision =~ ^[0-9a-f]{40}$ && $project == "/home/ubuntu/temporary-room-chat-${revision:0:7}" ]] ||
  { printf '%s\n' '部署目录和版本标识不匹配。' >&2; exit 1; }
accounts=/home/ubuntu/temporary-room-chat/accounts.sqlite3
state=/var/lib/temporary-room-chat-v2
config=/etc/temporary-room-chat-v2
unit_dir=/etc/systemd/system
front=temporary-room-chat-v2-nginx.service
backend=temporary-room-chat-v2.service
units=("$backend" temporary-room-chat-v2-api.service
       temporary-room-chat-v2-worker.service temporary-room-chat-v2-capture.service)
services=("$front" "${units[@]}")

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail '请使用 sudo bash upgrade-cloud.sh。'
[[ $(pwd -P) == "$project" && $(cat REVISION) == "$revision" ]] ||
  fail "请从 $project 运行此版本的脚本。"
exec 9>/run/lock/temporary-room-chat-release.lock
flock -n 9 || fail '已有一次升级正在执行。'

verify_release() {
  local unit
  for unit in "${services[@]}"; do
    systemctl is-active --quiet "$unit" || return 1
  done
  for unit in "${units[@]}"; do
    [[ $(systemctl show "$unit" -p WorkingDirectory --value) == "$project" ]] || return 1
  done
  runuser -u ubuntu -- "$project/.venv/bin/python" - "${expected_policy:-}" <<'PY'
import asyncio
import json
import ssl
import sys
from aiohttp import ClientSession, ClientTimeout

async def check():
    tls = ssl.create_default_context()
    options = {'ssl': tls, 'server_hostname': '43.129.182.26',
               'headers': {'Host': '43.129.182.26'}}
    async with ClientSession(timeout=ClientTimeout(total=6)) as session:
        async with session.get('https://127.0.0.1/', **options) as response:
            html = await response.text()
            assert response.status == 200
            assert all(f'id="{name}"' in html for name in
                       ('older-messages', 'notice-send-code', 'navigation-toggle', 'room-navigation'))
        async with session.get('https://127.0.0.1/app.js', **options) as response:
            script = await response.text()
            assert response.status == 200 and '"eye-off"' in script and 'verification_pending' in script
            assert 'temporary-chat-navigation-collapsed' in script
            assert 'chat_ack' in script and 'client_id' in script
        for asset in ('invite.js', 'invite.css', 'qrcode.js'):
            async with session.get('https://127.0.0.1/' + asset, **options) as response:
                assert response.status == 200 and len(await response.read()) > 100
        async with session.get('https://127.0.0.1/api/register/policy', **options) as response:
            assert response.status == 200
            policy = await response.json()
            assert isinstance(policy['email_registration'], bool)
            if sys.argv[1]:
                assert policy == json.loads(sys.argv[1]), '邮件开关或注册策略与升级前不同'
        async with session.get('https://127.0.0.1/api/notices/contact', **options) as response:
            assert response.status == 401
        async with session.ws_connect('wss://127.0.0.1/ws', **options) as ws:
            await ws.send_json({'type': 'auth_mode'})
            mode = await ws.receive_json()
            assert mode['type'] == 'auth_mode' and mode['required'] is True
    print('新版页面、HTTPS、WSS、注册策略和通知接口验证通过。')

asyncio.run(check())
PY
}

current=$(systemctl show "$backend" -p WorkingDirectory --value)
expected_policy=$(curl --noproxy '*' -fsS --max-time 8 \
  --connect-to '43.129.182.26:443:127.0.0.1:443' 'https://43.129.182.26/api/register/policy')
if [[ $current == "$project" ]]; then
  verify_release || fail '新版已配置，但验证失败，请检查服务日志。'
  printf '版本 %s 已在运行。\n' "$revision"
  exit 0
fi
case "$current" in
  /home/ubuntu/temporary-room-chat-v2|/home/ubuntu/temporary-room-chat-1b8a2b7|/home/ubuntu/temporary-room-chat-7977350|/home/ubuntu/temporary-room-chat-fb410cd|/home/ubuntu/temporary-room-chat-737bb3e|/home/ubuntu/temporary-room-chat-41238cc) ;;
  *) fail "当前部署目录未识别：$current。服务未切换，请把此行反馈。" ;;
esac
[[ -f $config/env && -f $accounts && -f $config/nginx.conf ]] || fail '现有配置不完整，服务未切换。'
for unit in "${units[@]}"; do
  file="$unit_dir/$unit"
  [[ -f $file && ! -L $file &&
     $(systemctl show "$unit" -p WorkingDirectory --value) == "$current" ]] ||
    fail "服务使用了不同的目录或额外配置：$unit。服务未切换。"
  dropins=$(systemctl show "$unit" -p DropInPaths --value)
  if [[ -n $dropins ]]; then
    expected="/etc/systemd/system/$unit.d/95-gmail-outbound.conf"
    [[ $unit == temporary-room-chat-v2-api.service || $unit == temporary-room-chat-v2-worker.service ]] &&
      [[ $dropins == "$expected" ]] || fail "存在未识别的服务覆盖配置：$unit"
    diff -q "$expected" <(printf '[Service]\nEnvironmentFile=/etc/temporary-room-chat-v2/gmail-outbound.env\n') >/dev/null ||
      fail "邮件服务覆盖配置内容不匹配：$unit"
    [[ -r $config/gmail-outbound.env ]] || fail 'Gmail 配置文件不存在。'
  fi
  grep -Fxq "WorkingDirectory=$current" "$file" &&
    grep -Fq "ExecStart=$current/" "$file" || fail "无法识别服务配置：$unit"
done
for unit in "${services[@]}"; do
  systemctl is-active --quiet "$unit" || fail "当前服务未运行：$unit"
done
runuser -u ubuntu -- test -w "$accounts" || fail '服务账号无法写入账号数据库。'

printf '编译并测试 %s，旧版继续提供服务。\n' "$revision"
runuser -u ubuntu -- cmake -S "$project" -B "$project/build"
runuser -u ubuntu -- cmake --build "$project/build" -j2
runuser -u ubuntu -- ctest --test-dir "$project/build" --output-on-failure
runuser -u ubuntu -- python3 -m venv "$project/.venv"
runuser -u ubuntu -- "$project/.venv/bin/python" -m pip --disable-pip-version-check install \
  -r "$project/assistant/requirements-lock.txt"
runuser -u ubuntu -- "$project/.venv/bin/python" -m pip check
/usr/sbin/nginx -t -c "$config/nginx.conf"

umask 077
install -d -m 0700 /var/backups/temporary-room-chat
backup=$(mktemp -d "/var/backups/temporary-room-chat/${revision:0:7}.XXXXXX")
mkdir "$backup/units" "$backup/staged"
cp "$config/env" "$backup/env"
if [[ -f $config/gmail-outbound.env ]]; then
  cp "$config/gmail-outbound.env" "$backup/gmail-outbound.env"
fi
for unit in "${units[@]}"; do
  cp "$unit_dir/$unit" "$backup/units/$unit"
  sed "s|$current/|$project/|g; s|^WorkingDirectory=$current$|WorkingDirectory=$project|" \
    "$backup/units/$unit" > "$backup/staged/$unit"
done

install_units() {
  local unit
  for unit in "${units[@]}"; do
    install -m 0644 "$1/$unit" "$unit_dir/$unit" || return 1
  done
  systemctl daemon-reload
}
rollback_needed=0
on_exit() {
  local status=$?
  trap - EXIT
  if (( status != 0 && rollback_needed )); then
    printf '新版启动或验证失败，正在恢复上一版服务。\n' >&2
    systemctl stop "${services[@]}" || true
    if install_units "$backup/units" && systemctl start "${services[@]}" &&
       systemctl is-active --quiet "${services[@]}" &&
       [[ $(systemctl show "$backend" -p WorkingDirectory --value) == "$current" ]] &&
       curl --noproxy '*' -fsS --retry 3 --retry-connrefused --max-time 8 \
         --connect-to '43.129.182.26:443:127.0.0.1:443' 'https://43.129.182.26/api/register/policy' >/dev/null; then
      printf '已恢复旧版服务。数据库快照和配置备份：%s。\n' "$backup" >&2
    else
      printf '自动恢复未完成，请检查服务日志。备份：%s。\n' "$backup" >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

room_db=$(python3 - "$backend" "$accounts" <<'PYROOM'
import subprocess
import sys
from pathlib import Path

unit, accounts = sys.argv[1:]
pid = subprocess.check_output(['systemctl', 'show', unit, '-p', 'MainPID', '--value'], text=True).strip()
directory = subprocess.check_output(['systemctl', 'show', unit, '-p', 'WorkingDirectory', '--value'], text=True).strip()
process = Path('/proc') / pid
environment = dict(item.split(b'=', 1) for item in (process / 'environ').read_bytes().split(b'\0') if b'=' in item)
args = (process / 'cmdline').read_bytes().decode().split('\0')
room_db = environment.get(b'CHAT_ROOMS_DB', b'').decode() or accounts + '.rooms.sqlite3'
if '--rooms-db' in args:
    room_db = args[args.index('--rooms-db') + 1]
path = Path(room_db)
print(path if path.is_absolute() else Path(directory) / path)
PYROOM
)
printf '开始切换。当前连接会断开；旧版仅在内存中的房间无法迁移，升级后新建房间开始持久保存。\n'
rollback_needed=1
systemctl stop "${services[@]}"
python3 - "$backup" "$accounts" "$state" "$room_db" <<'PY'
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

backup, accounts, state, room_db = map(Path, sys.argv[1:])
for name, path in [('accounts.sqlite3', accounts),
                   ('rooms.sqlite3', room_db),
                   ('assistant.sqlite3', state / 'assistant.sqlite3'),
                   ('notices.sqlite3', state / 'notices.sqlite3')]:
    if path.is_file():
        with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as source:
            with closing(sqlite3.connect(backup / name)) as dest:
                source.backup(dest)
                assert dest.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
PY
printf '现有数据库和服务配置已备份到 %s。\n' "$backup"
install_units "$backup/staged"
systemctl start "${services[@]}"
for attempt in {1..8}; do
  if verify_release; then
    rollback_needed=0
    printf '腾讯云已升级到 %s。\n' "$revision"
    printf '房间库默认位置：%s.rooms.sqlite3；若原配置设置 CHAT_ROOMS_DB，则继续使用原设置。\n' "$accounts"
    exit 0
  fi
  sleep 1
done
fail '新版服务未通过验证。'
