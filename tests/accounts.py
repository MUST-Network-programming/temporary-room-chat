"""使用真实 TLS 连接验收注册、持久化与按账号重入。"""
from pathlib import Path
import sqlite3
import ssl
import subprocess
import tempfile

from integration import Peer, ROOT

BINARY = ROOT / 'build/chat_server'
CERTS = ROOT / 'tls/certs'
PORT = 18767
PASSWORD = 'demo-passphrase-2026'


def expect_error(peer, code):
    assert peer.until('error')['code'] == code


def main():
    context = ssl.create_default_context(cafile=str(CERTS / 'ca.crt'))
    with tempfile.TemporaryDirectory() as temp:
        database = str(Path(temp) / 'accounts.sqlite3')
        configure = [str(BINARY), '--accounts', database]
        invite = subprocess.check_output([*configure, '--issue-invite'], text=True).strip()
        backup_invite = subprocess.check_output([*configure, '--issue-invite'], text=True).strip()
        command = [*configure, '--port', str(PORT), '--cert', str(CERTS / 'server.crt'),
                   '--key', str(CERTS / 'server.key'), '--log-chat']

        def start():
            process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, text=True)
            assert 'https://' in process.stdout.readline()
            return process

        def stop(process):
            process.terminate()
            _, logs = process.communicate(timeout=5)
            for secret in (PASSWORD, invite, backup_invite):
                assert secret not in logs

        process = start()
        try:
            a, b, member = [Peer(PORT, context) for _ in range(3)]
            a.send({'type': 'create', 'nickname': 'fake'})
            expect_error(a, 'login_required')
            a.send({'type': 'register', 'name': 'alice', 'password': PASSWORD, 'invite': invite})
            token = a.until('authenticated')['token']
            a.send({'type': 'create', 'nickname': 'fake'})
            expect_error(a, 'identity_override')
            a.send({'type': 'create'})
            room = a.until('joined')['room']
            b.send({'type': 'register', 'name': 'bob', 'password': PASSWORD, 'invite': invite})
            expect_error(b, 'invite_invalid')
            # 同名注册失败时，事务要退回尚未使用的注册码。
            member.send({'type': 'register', 'name': 'alice', 'password': PASSWORD, 'invite': backup_invite})
            expect_error(member, 'name_taken')
            with sqlite3.connect(database) as connection:
                assert connection.execute('SELECT used FROM invites WHERE code=?', (backup_invite,)).fetchone() == (0,)
                salt, password_hash = connection.execute('SELECT salt, hash FROM accounts WHERE name=?', ('alice',)).fetchone()
                assert len(salt) == 16 and len(password_hash) == 32 and PASSWORD.encode() not in password_hash
            member.close(); b.close()
            b = Peer(PORT, context)
            b.send({'type': 'login', 'name': 'alice', 'password': PASSWORD})
            b.until('authenticated')
            b.send({'type': 'join', 'room': room})
            result = b.until('joined')
            assert result['nickname'] == 'alice' and result['owner'] and 'token' not in result
            assert b.until('members')['members'] == ['alice']
            expect_error(a, 'session_replaced')
            a.close(); b.close()
            refresh = Peer(PORT, context)
            refresh.send({'type': 'authenticate', 'token': token})
            assert refresh.until('authenticated')['name'] == 'alice'
            refresh.send({'type': 'join', 'room': room})
            assert refresh.until('joined')['owner']
            refresh.close()
        finally:
            stop(process)

        process = start()
        try:
            a, b = [Peer(PORT, context) for _ in range(2)]
            a.send({'type': 'login', 'name': 'alice', 'password': PASSWORD})
            assert a.until('authenticated')['name'] == 'alice'
            a.send({'type': 'join', 'room': room})
            expect_error(a, 'room_not_found')
            b.send({'type': 'register', 'name': 'bob', 'password': PASSWORD, 'invite': invite})
            expect_error(b, 'invite_invalid')
            a.close(); b.close()
        finally:
            stop(process)
    print('PASS WSS account gate, single-use invite, rollback, identity transfer, token resume, restart persistence')


if __name__ == '__main__':
    main()
