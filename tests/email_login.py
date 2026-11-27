"""Send actual SMTP mail into a local capture server and sign in via the HTTPS gateway."""
import asyncio
from email import policy
from email.parser import BytesParser
from hashlib import sha256
import os
from pathlib import Path
import re
import secrets
import sqlite3
import ssl
import subprocess
import sys
import tempfile

from aiohttp import ClientSession

from accounts import BINARY, CERTS, ROOT
from bot_notices import free_ports, ready


async def run(state):
    chat, api, smtp, inbox = free_ports(4)
    account_db = state / 'accounts.sqlite3'
    cert, key, ca = [str(CERTS / name) for name in ('server.crt', 'server.key', 'ca.crt')]
    context = ssl.create_default_context(cafile=ca)
    base = f'https://127.0.0.1:{api}'
    env = {**os.environ, 'ASSISTANT_STATE': str(state), 'ASSISTANT_SHARED_SECRET': secrets.token_hex(32),
           'ACCOUNTS_DB': str(account_db), 'CHAT_INTERNAL_WS': f'wss://127.0.0.1:{chat}/ws',
           'CHAT_CA_FILE': ca, 'GATEWAY_TLS_CERT': cert, 'GATEWAY_TLS_KEY': key,
           'SMTP_HOST': '127.0.0.1', 'SMTP_PORT': str(smtp), 'SMTP_FROM': 'chat@example.test',
           'ALLOW_EXTERNAL_EMAIL': '0', 'SMTP_SSL': '0', 'SMTP_USERNAME': '', 'SMTP_PASSWORD': '',
           'LOGIN_RESEND_SECONDS': '2', 'LOGIN_LIMIT_WINDOW': '60', 'LOGIN_IP_LIMIT': '10'}
    app = [sys.executable, str(ROOT / 'assistant/service.py')]
    commands = [[str(BINARY), '--port', str(chat), '--accounts', str(account_db), '--cert', cert, '--key', key],
                [*app, 'serve', '--port', str(api)], [*app, 'capture', '--port', str(inbox)]]
    processes = [subprocess.Popen(cmd, env=env, cwd=ROOT) for cmd in commands]

    def capture(email):
        for item in (state / 'inbox').glob('*.eml'):
            message = BytesParser(policy=policy.default).parsebytes(item.read_bytes())
            if message['To'] == email and message['Subject'] == '临时房间聊天室登录验证码':
                yield re.search(r'登录验证码：([0-9]{6})', message.get_content()).group(1)

    async def request_code(session, email, expected=200):
        async with session.post(base + '/api/login/code', json={'email': email}, ssl=context) as response:
            data = await response.json()
            assert response.status == expected, (response.status, data)
            return data

    async def authenticate(session, payload, expected='authenticated'):
        async with session.ws_connect(base + '/ws', ssl=context) as ws:
            await ws.send_json(payload)
            reply = await ws.receive_json(timeout=5)
            assert reply['type'] == expected, reply
            return reply

    try:
        async with ClientSession() as session:
            await ready(session, f'http://127.0.0.1:{inbox}')
            await ready(session, f'https://127.0.0.1:{chat}', context)
            await ready(session, base, context)
            async with session.get(base + '/api/login/policy', ssl=context) as response:
                assert await response.json() == {'email_login': True, 'local_only': True}
            async with session.post(base + '/api/register/code', json={}, ssl=context) as response:
                assert response.status in (404, 405)
            await request_code(session, 'user@gmail.com', 403)
            address = 'person@example.test'
            data = await request_code(session, ' Person@EXAMPLE.TEST ')
            assert set(data) == {'challenge', 'retry_after'} and len(data['challenge']) == 64
            code, = capture(address)
            assert code not in data.values()
            await request_code(session, address, 429)
            payload = {'type': 'email_login', 'challenge': data['challenge'], 'code': code}
            wrong = dict(payload, code='000000' if code != '000000' else '999999')
            assert (await authenticate(session, wrong, 'error'))['code'] == 'code_invalid'
            # Parallel use of one challenge can issue exactly one session.
            async def compete():
                async with session.ws_connect(base + '/ws', ssl=context) as ws:
                    await ws.send_json(payload)
                    return await ws.receive_json(timeout=5)
            results = await asyncio.gather(compete(), compete())
            signed_in, = [reply for reply in results if reply['type'] == 'authenticated']
            assert [reply['code'] for reply in results if reply['type'] == 'error'] == ['code_invalid']
            name = signed_in['name']
            assert name.startswith('user_')
            with sqlite3.connect(account_db) as conn:
                assert conn.execute('SELECT name,email FROM accounts').fetchall() == [(name, address)]
                assert conn.execute('SELECT COUNT(*) FROM login_challenges').fetchone() == (0,)

            headers = {'Authorization': 'Bearer ' + signed_in['token']}
            async with session.get(base + '/api/notices/contact', headers=headers, ssl=context) as response:
                contact = await response.json()
                assert contact['email'] is None and contact['registration_email'] == address
            async with session.post(base + '/api/notices/use-registration-email', headers=headers, json={},
                                    ssl=context) as response:
                assert response.status == 200
            async with session.get(base + '/api/notices/contact', headers=headers, ssl=context) as response:
                assert (await response.json())['email'] == address

            await asyncio.sleep(2.05)
            data = await request_code(session, address)
            assert len(list(capture(address))) == 2
            # Match the code to the second request via the proof, even if filenames sort differently.
            challenge = data['challenge']
            with sqlite3.connect(account_db) as conn:
                proof, = conn.execute('SELECT proof FROM login_challenges').fetchone()
            code = next(code for code in capture(address) if sha256(f'{challenge}:{code}'.encode()).digest() == proof)
            assert (await authenticate(session, dict(payload, challenge=challenge, code=code)))['name'] == name

            # Failed delivery leaves no usable challenge or new account.
            processes[-1].terminate()
            processes[-1].wait(timeout=5)
            assert 'challenge' not in await request_code(session, 'failed@example.test', 503)
            with sqlite3.connect(account_db) as conn:
                assert conn.execute('SELECT COUNT(*) FROM login_challenges').fetchone() == (0,)
                assert conn.execute('SELECT COUNT(*) FROM accounts').fetchone() == (1,)
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            process.wait(timeout=5)


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='chat-email-login-') as directory:
        asyncio.run(run(Path(directory)))
    print('PASS HTTPS email login, SMTP capture/failure, atomic consumption, repeat login and explicit notice binding')
