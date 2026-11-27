"""Check the C account protocol through a real TLS connection."""
from hashlib import pbkdf2_hmac, sha256
from pathlib import Path
import secrets
import sqlite3
import ssl
import subprocess
import tempfile
import time

from integration import Peer, ROOT

BINARY = ROOT / 'build/chat_server'
CERTS = ROOT / 'tls/certs'
PORT = 18767
PASSWORD = 'demo-passphrase-2026'


def seed_account(database, name, email=None):
    salt = secrets.token_bytes(16)
    digest = pbkdf2_hmac('sha256', PASSWORD.encode(), salt, 600000)
    with sqlite3.connect(database) as conn:
        conn.execute('INSERT INTO accounts(name, salt, hash, email) VALUES (?,?,?,?)',
                     (name, salt, digest, email))


def login_payload(database, email, *, code='012345', ttl=300):
    challenge = secrets.token_hex(32)
    with sqlite3.connect(database) as conn:
        conn.execute('INSERT INTO login_challenges(key,proof,email,expires) VALUES (?,?,?,?)',
                     (sha256(challenge.encode()).digest(), sha256(f'{challenge}:{code}'.encode()).digest(),
                      email, int(time.time()) + ttl))
    return {'type': 'email_login', 'challenge': challenge, 'code': code}


def expect_error(peer, code):
    response = peer.until('error')
    assert response['code'] == code, response


def main():
    context = ssl.create_default_context(cafile=str(CERTS / 'ca.crt'))
    with tempfile.TemporaryDirectory() as temp:
        database = Path(temp) / 'accounts.sqlite3'
        # A pre-email database still opens, and the existing name remains its identity.
        with sqlite3.connect(database) as conn:
            conn.execute('CREATE TABLE accounts(name TEXT PRIMARY KEY,salt BLOB NOT NULL,hash BLOB NOT NULL)')
        command = [str(BINARY), '--accounts', str(database), '--port', str(PORT),
                   '--cert', str(CERTS / 'server.crt'), '--key', str(CERTS / 'server.key'), '--log-chat']

        def start():
            process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, text=True)
            assert 'https://' in process.stdout.readline()
            return process

        def stop(process):
            process.terminate()
            _, logs = process.communicate(timeout=5)
            assert PASSWORD not in logs and '012345' not in logs

        process = start()
        try:
            seed_account(database, 'alice')
            seed_account(database, 'verified', 'verified@example.test')
            a, b = [Peer(PORT, context) for _ in range(2)]
            a.send({'type': 'create', 'nickname': 'fake'})
            expect_error(a, 'login_required')
            a.send({'type': 'chat', 'text': 'pending', 'client_id': 'f' * 32})
            rejected = a.until('error')
            assert rejected['code'] == 'login_required' and rejected['client_id'] == 'f' * 32
            for kind in ('login', 'register'):
                a.send({'type': kind, 'name': 'alice', 'password': PASSWORD, 'invite': 'f' * 32})
                expect_error(a, 'invalid_json')
            a.send(login_payload(database, 'expired@example.test', ttl=-1))
            expect_error(a, 'code_invalid')

            migrate = dict(login_payload(database, 'owner@example.test'),
                           legacy_name='alice', legacy_password=PASSWORD)
            b.send(dict(migrate, legacy_password='wrong-passphrase'))
            expect_error(b, 'migration_invalid')
            a.send(migrate)
            # Verification requests on each connection are throttled for one second.
            if (result := a.receive())['type'] == 'error':
                assert result['code'] == 'auth_busy'
                time.sleep(1)
                a.send(migrate)
                result = a.until('authenticated')
            assert result['type'] == 'authenticated' and result['name'] == 'alice'
            token = result['token']
            a.send({'type': 'create', 'nickname': 'fake'})
            expect_error(a, 'identity_override')
            a.send({'type': 'create'})
            room = a.until('joined')['room']

            time.sleep(1)
            b.send(migrate)
            expect_error(b, 'code_invalid')
            time.sleep(1)
            taken = dict(login_payload(database, 'verified@example.test'),
                         legacy_name='alice', legacy_password=PASSWORD)
            b.send(taken)
            expect_error(b, 'email_taken')
            b.close()
            b = Peer(PORT, context)
            b.send(login_payload(database, 'owner@example.test'))
            assert b.until('authenticated')['name'] == 'alice'
            b.send({'type': 'join', 'room': room})
            assert b.until('joined')['owner']
            expect_error(a, 'session_replaced')
            a.close()
            b.close()

            refresh = Peer(PORT, context)
            refresh.send({'type': 'authenticate', 'token': token})
            assert refresh.until('authenticated')['name'] == 'alice'
            refresh.close()
        finally:
            stop(process)

        process = start()
        try:
            a = Peer(PORT, context)
            a.send(login_payload(database, 'owner@example.test'))
            assert a.until('authenticated')['name'] == 'alice'
            a.send({'type': 'join', 'room': room})
            assert a.until('joined')['owner']
            a.close()
        finally:
            stop(process)
    print('PASS TLS account gate, legacy migration, single-use code, session resume, persisted ownership')


if __name__ == '__main__':
    main()
