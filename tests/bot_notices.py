"""Exercise server-side bot triggers and durable SMTP notices with real WSS."""
import asyncio
import json
import os
import re
import secrets
import smtplib
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from email import policy
from email.parser import BytesParser
from pathlib import Path
from zoneinfo import ZoneInfo
from unittest.mock import patch

from aiohttp import ClientSession, web

from accounts import login_payload, seed_account
from integration import ROOT

CERTS = ROOT / 'tls/certs'
SHANGHAI = ZoneInfo('Asia/Shanghai')


async def failed_verification():
    sys.path.insert(0, str(ROOT))
    from assistant import notices
    with tempfile.TemporaryDirectory(prefix='notice-verification-') as temp:
        with patch.object(notices, 'STATE', Path(temp)):
            notices.initialize()
            with notices.database() as conn:
                conn.execute('INSERT INTO contacts VALUES(?,?)', ('bound', 'old@example.test'))
            with patch.object(notices, 'deliver', side_effect=smtplib.SMTPRecipientsRefused({})):
                response = await notices.start_verification('bound', {'email': 'new@example.test'})
            state = notices.contact('bound')
            assert response.status == 503 and state['email'] == 'old@example.test'
            assert state['verification_pending'] is False and 0 < state['retry_after'] <= 60
    print('PASS failed replacement consumes its code and preserves binding and cooldown', flush=True)


def free_ports(count):
    sockets = [socket.socket() for _ in range(count)]
    try:
        for listener in sockets:
            listener.bind(('127.0.0.1', 0))
        return [listener.getsockname()[1] for listener in sockets]
    finally:
        for listener in sockets:
            listener.close()


async def until(ws, kind):
    while True:
        message = await ws.receive_json(timeout=5)
        if message['type'] == kind or message['type'] == 'error':
            assert message['type'] == kind, message
            return message


async def ready(session, url, ssl_context=None):
    for _ in range(80):
        try:
            async with session.get(url, ssl=ssl_context) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        await asyncio.sleep(.1)
    raise AssertionError(f'Local service failed to start: {url}')


def scheduled_in(seconds):
    return datetime.fromtimestamp(time.time() + seconds, SHANGHAI).replace(tzinfo=None).isoformat(timespec='seconds')


async def run(state):
    chat_port, gateway_port, smtp_port, inbox_port, model_port = free_ports(5)
    context = ssl.create_default_context(cafile=str(CERTS / 'ca.crt'))
    chat_url = f'wss://127.0.0.1:{chat_port}/ws'
    api_url = f'https://127.0.0.1:{gateway_port}'
    model_requests = []

    async def model(request):
        data = await request.json()
        assert request.headers['Authorization'] == 'Bearer local-test-key'
        model_requests.append(json.loads(data['messages'][-1]['content']))
        return web.json_response({'choices': [{'message': {'content': '集合地点是东门。'}}]})

    test_provider = web.Application()
    test_provider.router.add_post('/v1/chat/completions', model)
    runner = web.AppRunner(test_provider)
    await runner.setup()
    await web.TCPSite(runner, '127.0.0.1', model_port).start()
    env = {
        **os.environ, 'ASSISTANT_STATE': str(state), 'ASSISTANT_SHARED_SECRET': secrets.token_hex(32),
        'CHAT_INTERNAL_WS': chat_url, 'CHAT_CA_FILE': str(CERTS / 'ca.crt'),
        'GATEWAY_TLS_CERT': str(CERTS / 'server.crt'), 'GATEWAY_TLS_KEY': str(CERTS / 'server.key'),
        'AI_MODE': 'openai', 'AI_API_KEY': 'local-test-key',
        'AI_BASE_URL': f'http://127.0.0.1:{model_port}/v1', 'AI_MODEL': 'local-test-model',
        'ALLOW_EXTERNAL_EMAIL': '0', 'SMTP_HOST': '127.0.0.1', 'SMTP_PORT': str(smtp_port),
        'SMTP_FROM': 'notices@example.test', 'SMTP_USERNAME': '', 'SMTP_PASSWORD': '', 'SMTP_SSL': '0',
    }
    accounts = state / 'accounts.sqlite3'
    configure = [str(ROOT / 'build/chat_server'), '--accounts', str(accounts)]
    command = [*configure, '--port', str(chat_port), '--ttl', '60',
               '--cert', str(CERTS / 'server.crt'), '--key', str(CERTS / 'server.key')]
    python = [sys.executable, str(ROOT / 'assistant/service.py')]
    processes = []

    def start(name, args):
        with (state / f'{name}.log').open('a') as log:
            process = subprocess.Popen(args, cwd=ROOT, env=env, stdout=log, stderr=log)
        processes.append(process)
        return process

    def stop(process):
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)

    def inbox():
        return [BytesParser(policy=policy.default).parsebytes(file.read_bytes())
                for file in (state / 'inbox').glob('*.eml')]

    try:
        chat = start('c', command)
        server = start('gateway', [*python, 'serve', '--port', str(gateway_port)])
        worker = start('worker', [*python, 'worker'])
        start('inbox', [*python, 'capture', '--port', str(inbox_port)])
        async with ClientSession() as session:
            # Use the gateway for account/browser traffic and raw C WSS for one chat client.
            async def login(name, direct=False):
                url = chat_url if direct else api_url + '/ws'
                ws = await session.ws_connect(url, ssl=context)
                await ws.send_json(login_payload(accounts, f'{name}+login@example.test'))
                return ws, (await until(ws, 'authenticated'))['token']

            async def api(action, token, payload=None, room=None, expected=200):
                headers = {'Authorization': 'Bearer ' + token}
                if room:
                    headers['X-Room-Token'] = room
                async with session.request('POST' if payload is not None else 'GET',
                                           api_url + '/api/notices/' + action,
                                           headers=headers, json=payload, ssl=context) as response:
                    result = await response.json()
                    assert response.status == expected, (action, response.status, result)
                    return result

            async def bind(token, email):
                assert (await api('contact', token))['retry_after'] == 0
                sent = await api('send-code', token, {'email': email})
                assert sent['ok'] and 0 < sent['retry_after'] <= 60
                limited = await api('send-code', token, {'email': email}, expected=429)
                assert 0 < limited['retry_after'] <= sent['retry_after']
                pending = await api('contact', token)
                assert 0 < pending['retry_after'] <= limited['retry_after']
                assert pending['verification_pending'] is True
                assert sum('验证码' in msg['Subject'] and str(msg['To']) == email for msg in inbox()) == 1
                verification = next(msg for msg in inbox() if str(msg['To']) == email and '验证码' in msg['Subject'])
                code = re.search(r'\b\d{6}\b', verification.get_content()).group()
                await api('verify', token, {'code': '000000' if code != '000000' else '000001'}, expected=400)
                await api('verify', token, {'code': code})
                bound = await api('contact', token)
                assert bound['email'] == email and bound['verification_pending'] is False

            await ready(session, f'http://127.0.0.1:{inbox_port}')
            await ready(session, chat_url.removesuffix('/ws').replace('wss:', 'https:'), context)
            await ready(session, api_url, context)

            for name in ('alice', 'bob', 'claire', 'pat'):
                seed_account(accounts, name, f'{name}+login@example.test')
            alice, a = await login('alice')
            bob, b = await login('bob', direct=True)
            claire, _ = await login('claire')
            pat, p = await login('pat')
            await bind(a, 'alice@example.test')
            await bind(b, 'bob@example.test')
            await alice.send_json({'type': 'create'})
            room = await until(alice, 'joined')
            for member in (bob, claire):
                await member.send_json({'type': 'join', 'room': room['room']})
                await until(member, 'joined')
            await pat.send_json({'type': 'create'})
            await until(pat, 'joined')
            await pat.send_json({'type': 'chat', 'text': '其他房间的消息'})
            await until(pat, 'chat')
            await alice.send_json({'type': 'chat', 'text': '我们在东门集合。'})
            for ws in (alice, bob, claire):
                assert (await until(ws, 'chat'))['text'] == '我们在东门集合。'
            await bob.send_json({'type': 'chat', 'text': '@群聊助手 在哪集合？'})
            for ws in (alice, bob, claire):
                received = [await until(ws, 'chat') for _ in range(2)]
                assert received[-1]['text'] == '集合地点是东门。' and received[-1]['bot']
            await pat.send_json({'type': 'ping'})
            while (isolated := await pat.receive_json(timeout=5))['type'] != 'pong':
                assert isolated['type'] != 'chat', isolated
            assert len(model_requests) == 1
            assert [msg['text'] for msg in model_requests[0]['recent_chat']] == ['我们在东门集合。']
            assert await api('mine', p) == {'notices': []}
            print('PASS raw WSS member mention, one model request, same-room broadcast and isolated context', flush=True)

            await bob.close()
            roster = await until(alice, 'members')
            while 'bob' in roster['members'] or 'claire' not in roster['members']:
                roster = await until(alice, 'members')
            room_token = room['assistant_token']
            await api('preview', b, {}, room_token, 403)
            assert await api('preview', a, {}, room_token) == {'members': 3, 'recipients': 2}
            draft = {
                'title': '集合变更', 'body': '请在东门集合。', 'due': scheduled_in(60),
                'request_id': secrets.token_hex(16),
            }
            first = await api('publish', a, draft, room_token)
            card = await until(claire, 'notice')
            assert card['id'] == first['id'] and card['text'] == draft['body']
            assert await api('publish', a, draft, room_token) == first
            await api('cancel', p, first, expected=404)
            await api('cancel', a, first)
            cancelled = await until(claire, 'notice')
            assert cancelled['revision'] == 2 and cancelled['status'] == 'cancelled'
            second = await api('publish', a, dict(draft, title='确认集合', request_id=secrets.token_hex(16)), room_token)
            new_due = scheduled_in(11)
            await api('reschedule', a, dict(second, due=new_due))
            await alice.send_json({'type': 'close'})
            await until(claire, 'closed')
            for ws in (alice, claire, pat):
                await ws.close()
            stop(server)
            stop(worker)
            stop(chat)
            assert not [msg for msg in inbox() if '重要通知' in msg['Subject']]
            chat = start('c', command)
            start('gateway', [*python, 'serve', '--port', str(gateway_port)])
            start('worker', [*python, 'worker'])
            await asyncio.sleep(1)
            await api('mine', a, expected=401)
            alice, a = await login('alice')
            for _ in range(45):
                listings = (await api('mine', a))['notices']
                if any(row['id'] == second['id'] and row['deliveries'] == {'sent': 2} for row in listings):
                    break
                await asyncio.sleep(.4)
            else:
                raise AssertionError(f'Notice was not delivered: {listings}')
            notices = [msg for msg in inbox() if '重要通知' in msg['Subject']]
            assert sorted(str(msg['To']) for msg in notices) == ['alice@example.test', 'bob@example.test']
            assert all('确认集合' in msg['Subject'] and draft['body'] in msg.get_content() for msg in notices)
            assert next(row for row in listings if row['id'] == first['id'])['deliveries'] == {'cancelled': 2}
            await alice.close()
            print('PASS verified contacts, owner-only scheduling, idempotent cards, cancellation and restart-safe SMTP', flush=True)
    except Exception:
        for log in sorted(state.glob('*.log')):
            print(log.name, log.read_text()[-2500:], file=sys.stderr)
        raise
    finally:
        for process in reversed(processes):
            stop(process)
        await runner.cleanup()


if __name__ == '__main__':
    asyncio.run(failed_verification())
    with tempfile.TemporaryDirectory(prefix='chat-bot-notices-') as temp:
        asyncio.run(run(Path(temp)))
