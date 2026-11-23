"""Local registration-code checks. SMTP capture stays on 127.0.0.1; no external mail."""
import json
import os
import sqlite3
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from email import policy as email_policy
from email.parser import BytesParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from assistant.registration import request_registration_code
from integration import Peer

BINARY = ROOT / 'build' / 'chat_server'
CERTS = ROOT / 'tls' / 'certs'
CHAT_PORT = 18481
API_PORT = 18094
CAPTURE_HTTP = 18099
SMTP_PORT = 11027
PASSWORD = 'email-pass-2026'


def post(payload):
    request = urllib.request.Request(
        f'http://127.0.0.1:{API_PORT}/api/register/code',
        data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode())


def registration_policy():
    with urllib.request.urlopen(f'http://127.0.0.1:{API_PORT}/api/register/policy', timeout=5) as response:
        return json.loads(response.read().decode())


def inbox_messages(folder):
    messages = []
    for path in sorted(folder.glob('*.eml')):
        message = BytesParser(policy=email_policy.default).parsebytes(path.read_bytes())
        body = message.get_body(preferencelist=('plain',)).get_content()
        code = ''
        for line in body.splitlines():
            if line.startswith('注册码：'):
                code = line.split('：', 1)[1].strip()
        messages.append((str(message['Subject']), str(message['To']), code, body))
    return messages


def wait_for(port):
    import socket
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            with socket.create_connection(('127.0.0.1', port), 0.2):
                return
        except OSError:
            time.sleep(0.05)
    raise AssertionError(f'port {port} did not open')


def exchange(peer, name, invite, email=None):
    payload = {'type': 'register', 'name': name, 'password': PASSWORD, 'invite': invite}
    if email is not None:
        payload['email'] = email
    while True:
        peer.send(payload)
        message = peer.receive()
        if message.get('type') == 'error' and message.get('code') == 'auth_busy':
            time.sleep(1.1)
            continue
        return message


def direct_guards(database):
    saved = {key: os.environ.get(key) for key in (
        'REGISTRATION_EMAIL', 'ALLOW_EXTERNAL_EMAIL', 'SMTP_HOST', 'SMTP_PORT', 'ACCOUNTS_DB',
        'REGISTRATION_IP_LIMIT', 'REGISTRATION_EMAIL_LIMIT')}
    try:
        os.environ['REGISTRATION_EMAIL'] = '0'
        status, body = request_registration_code(str(database), 'person@example.test', '203.0.113.5')
        assert status == 403 and 'code' not in body, body
        os.environ['REGISTRATION_EMAIL'] = '1'
        os.environ['ALLOW_EXTERNAL_EMAIL'] = '0'
        os.environ['SMTP_HOST'] = '127.0.0.1'
        os.environ['SMTP_PORT'] = '1'
        os.environ['ACCOUNTS_DB'] = str(database)
        status, body = request_registration_code(str(database), 'person@real-domain.com', '203.0.113.5')
        assert status == 403 and 'code' not in body, body
        os.environ['REGISTRATION_IP_LIMIT'] = '2'
        os.environ['REGISTRATION_EMAIL_LIMIT'] = '5'
        first, _ = request_registration_code(str(database), 'fail-one@example.test', '203.0.113.9')
        second, _ = request_registration_code(str(database), 'fail-two@example.test', '203.0.113.9')
        third, limited = request_registration_code(str(database), 'fail-three@example.test', '203.0.113.9')
        assert first == 503 and second == 503 and third == 429, (first, second, third, limited)
        assert '注册码' not in json.dumps(limited)
        with sqlite3.connect(database) as connection:
            unused = connection.execute('SELECT count(*) FROM invites WHERE used=0').fetchone()[0]
        assert unused == 0
        print('PASS disabled mode, external address rejected, SMTP failure leaves no code, IP rate limit')
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def main():
    assert BINARY.is_file(), 'C server is not built'
    assert (CERTS / 'ca.crt').is_file(), 'local test certificates are missing'
    direct_guards(Path('/tmp') / f'reg-guard-{os.getpid()}.sqlite3')
    import tempfile
    temp = tempfile.TemporaryDirectory(prefix='reg-email-')
    root = Path(temp.name)
    database = root / 'accounts.sqlite3'
    inbox = root / 'inbox'
    inbox.mkdir()
    env = os.environ.copy()
    env.update(
        REGISTRATION_EMAIL='1', ALLOW_EXTERNAL_EMAIL='0', SMTP_HOST='127.0.0.1', SMTP_PORT=str(SMTP_PORT),
        SMTP_FROM='register@example.test', ACCOUNTS_DB=str(database), ASSISTANT_STATE=str(root),
        REGISTRATION_CODE_TTL='600', REGISTRATION_RESEND_SECONDS='1', REGISTRATION_IP_LIMIT='20',
        REGISTRATION_EMAIL_LIMIT='6', REGISTRATION_LIMIT_WINDOW='600', AI_MODE='rules',
    )
    env.pop('SMTP_USERNAME', None)
    env.pop('SMTP_PASSWORD', None)
    python = sys.executable
    logs = {}

    def spawn(args, name):
        handle = open(root / f'{name}.log', 'w')
        logs[name] = handle
        return subprocess.Popen(args, cwd=ROOT, env=env, stdout=handle, stderr=subprocess.STDOUT)

    capture = spawn([python, 'assistant/service.py', 'capture', '--port', str(CAPTURE_HTTP)], 'capture')
    api = spawn([python, 'assistant/service.py', 'serve', '--port', str(API_PORT)], 'api')
    chat = spawn([
        str(BINARY), '--accounts', str(database), '--port', str(CHAT_PORT),
        '--cert', str(CERTS / 'server.crt'), '--key', str(CERTS / 'server.key'),
    ], 'chat')
    anonymous = spawn([str(BINARY), '--anonymous-loopback', '--port', '18482', '--ttl', '30'], 'anonymous')
    context = ssl.create_default_context(cafile=str(CERTS / 'ca.crt'))
    try:
        wait_for(SMTP_PORT)
        wait_for(API_PORT)
        wait_for(CHAT_PORT)
        wait_for(18482)
        # Capture binds SMTP immediately, but the inbox directory is the assistant state inbox.
        capture_inbox = root / 'inbox'
        assert registration_policy()['email_registration'] is True and registration_policy()['local_only'] is True
        status, body = post({'email': 'Owner@Example.TEST'})
        assert status == 200 and body == {'ok': True} and 'code' not in body
        time.sleep(0.4)
        messages = inbox_messages(capture_inbox)
        assert len(messages) == 1, messages
        subject, recipient, code, _body = messages[0]
        assert recipient == 'owner@example.test'
        assert code and code not in subject and len(code) == 32
        status, again = post({'email': 'owner@example.test'})
        assert status == 429 and 'retry_after' in again and 'code' not in again
        assert len(inbox_messages(capture_inbox)) == 1
        peer = Peer(CHAT_PORT, context)
        wrong = exchange(peer, 'ownerone', '0' * 32, 'owner@example.test')
        assert wrong['type'] == 'error' and wrong['code'] == 'invite_invalid'
        created = exchange(peer, 'ownerone', code, 'owner@example.test')
        assert created['type'] == 'authenticated' and created['name'] == 'ownerone'
        peer.close()
        replay = exchange(Peer(CHAT_PORT, context), 'ownertwo', code, 'owner@example.test')
        assert replay['type'] == 'error' and replay['code'] == 'invite_invalid'
        with sqlite3.connect(database) as connection:
            assert connection.execute('SELECT count(*) FROM accounts').fetchone()[0] == 1
            assert connection.execute('SELECT email FROM accounts WHERE name=?', ('ownerone',)).fetchone()[0] == 'owner@example.test'
        status, hidden = post({'email': 'owner@example.test'})
        assert status == 200 and hidden == {'ok': True}
        assert len(inbox_messages(capture_inbox)) == 1
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT count(*) FROM invites WHERE email=? AND used=0", ('owner@example.test',)).fetchone()[0] == 0

        status, _ = post({'email': 'burn@example.test'})
        assert status == 200
        time.sleep(0.3)
        burn = [item[2] for item in inbox_messages(capture_inbox) if item[1] == 'burn@example.test'][-1]
        burner = Peer(CHAT_PORT, context)
        for _ in range(5):
            failed = exchange(burner, 'burnuser', burn, 'other@example.test')
            assert failed['code'] == 'invite_invalid'
            time.sleep(1.05)
        burned = exchange(burner, 'burnuser', burn, 'burn@example.test')
        assert burned['type'] == 'error' and burned['code'] == 'invite_invalid'
        burner.close()

        status, _ = post({'email': 'expire@example.test'})
        assert status == 200
        time.sleep(0.3)
        expired_code = [item[2] for item in inbox_messages(capture_inbox) if item[1] == 'expire@example.test'][-1]
        with sqlite3.connect(database) as connection:
            connection.execute('UPDATE invites SET expires=? WHERE code=?', (int(time.time()) - 5, expired_code))
        expired = exchange(Peer(CHAT_PORT, context), 'expireuser', expired_code, 'expire@example.test')
        assert expired['type'] == 'error' and expired['code'] == 'invite_expired'

        time.sleep(1.1)
        before = len(inbox_messages(capture_inbox))
        status, _ = post({'email': 'expire@example.test'})
        assert status == 200
        time.sleep(0.3)
        refreshed = [item[2] for item in inbox_messages(capture_inbox) if item[1] == 'expire@example.test']
        assert len(refreshed) == 2 and refreshed[-1] != expired_code
        stale = exchange(Peer(CHAT_PORT, context), 'expireuser', expired_code, 'expire@example.test')
        assert stale['code'] == 'invite_invalid'
        renewed = exchange(Peer(CHAT_PORT, context), 'expireuser', refreshed[-1], 'expire@example.test')
        assert renewed['type'] == 'authenticated'
        assert len(inbox_messages(capture_inbox)) >= before + 1

        invite = subprocess.check_output(
            [str(BINARY), '--accounts', str(database), '--issue-invite'], text=True
        ).strip()
        assert len(invite) == 32 and invite not in Path(root / 'api.log').read_text()
        manual = exchange(Peer(CHAT_PORT, context), 'manualuser', invite)
        assert manual['type'] == 'authenticated' and manual['name'] == 'manualuser'

        status, fresh = post({'email': 'race@example.test'})
        assert status == 200 and fresh == {'ok': True}
        time.sleep(0.3)
        race_code = [item[2] for item in inbox_messages(capture_inbox) if item[1] == 'race@example.test'][-1]
        def once(index, bucket):
            try:
                message = exchange(Peer(CHAT_PORT, context), f'raceuser{index}', race_code, 'race@example.test')
                bucket.append(message.get('type') if message.get('type') == 'authenticated' else message.get('code'))
            except Exception as exc:
                bucket.append(type(exc).__name__)

        bucket = []
        threads = [threading.Thread(target=once, args=(index, bucket)) for index in (1, 2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
        assert sorted(bucket) == ['authenticated', 'invite_invalid'], bucket
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT count(*) FROM accounts WHERE name LIKE 'raceuser%'").fetchone()[0] == 1

        anon = Peer(18482)
        anon.send({'type': 'create', 'nickname': 'anon'})
        assert len(anon.until('joined')['room']) == 6
        anon.close()

        log_text = ''.join(path.read_text(errors='replace') for path in root.glob('*.log'))
        for secret in inbox_messages(capture_inbox):
            assert secret[2] not in log_text
        assert PASSWORD not in log_text and invite not in ''.join(
            (root / name).read_text(errors='replace') for name in ('api.log', 'chat.log', 'capture.log', 'anonymous.log')
        )
        print('PASS email registration: success, wrong code, expiry, replay, cooldown, resend invalidation, '
              'existing address hidden, organizer invite, concurrent consume, anonymous chat')
    finally:
        for process in (capture, api, chat, anonymous):
            if process.poll() is None:
                process.terminate()
        for process in (capture, api, chat, anonymous):
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        for handle in logs.values():
            handle.close()
        temp.cleanup()


if __name__ == '__main__':
    main()
