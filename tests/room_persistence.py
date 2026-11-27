"""通过真实 WSS 验证七天房间、历史分页和磁盘清理。"""
import os
import socket
import sqlite3
import ssl
import subprocess
import tempfile
import time
from pathlib import Path

from accounts import login_payload, seed_account
from integration import Peer, ROOT


def run(state):
    accounts = state / 'accounts.sqlite3'
    rooms = state / 'rooms.sqlite3'
    certs = ROOT / 'tls/certs'
    context = ssl.create_default_context(cafile=str(certs / 'ca.crt'))
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    configure = [str(ROOT / 'build/chat_server'), '--accounts', str(accounts)]
    secret = 'local-persistence-test-shared-secret'
    environment = {**os.environ, 'ASSISTANT_SHARED_SECRET': secret}
    command = [*configure, '--rooms-db', str(rooms), '--port', str(port),
               '--cert', str(certs / 'server.crt'), '--key', str(certs / 'server.key')]

    def start(ttl=604800):
        options = ['--ttl', str(ttl)] if ttl != 604800 else []
        process = subprocess.Popen([*command, *options], env=environment,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = process.stdout.readline()
        if not line:
            _, error = process.communicate(timeout=5)
            raise AssertionError(f'Room server did not start: {error}')
        assert f'TTL={ttl}' in line, line
        return process

    def authenticate(name):
        peer = Peer(port, context)
        peer.send(login_payload(accounts, f'{name}@example.test'))
        peer.until('authenticated')
        return peer

    first = start()
    try:
        seed_account(accounts, 'owner', 'owner@example.test')
        seed_account(accounts, 'member', 'member@example.test')
        owner = authenticate('owner')
        member = authenticate('member')
        owner.send({'type': 'create'})
        room = owner.until('joined')
        assert 604798 <= room['expires'] - time.time() <= 604800
        member.send({'type': 'join', 'room': room['room']})
        assert not member.until('joined')['owner']
        owner.send({'type': 'rename', 'name': '七天旅行'})
        assert owner.until('renamed')['name'] == '七天旅行'
        delivery_id = '0123456789abcdef0123456789abcdef'
        original_confirmation = None
        for index in range(123):
            text = f'旅行消息 {index}'
            outgoing = {'type': 'chat', 'text': text}
            if index == 0:
                outgoing['client_id'] = delivery_id
            member.send(outgoing)
            received = owner.until('chat')
            assert received['text'] == member.until('chat')['text'] == text
            assert isinstance(received['sent_at'], int)
            if index == 0:
                original_confirmation = member.until('chat_ack')['message']
                assert original_confirmation == received
                member.send(outgoing)
                assert member.receive() == {'type': 'chat_ack', 'client_id': delivery_id, 'message': received}
                owner.send({'type': 'ping'})
                assert owner.receive()['type'] == 'pong'  # 重试没有再次广播
        owner.send({'type': 'sticker', 'id': 'wave'})
        assert owner.until('sticker')['id'] == 'wave'
        owner.close()
        member.close()
    finally:
        first.kill()
        first.communicate(timeout=5)

    with sqlite3.connect(rooms) as db:
        members = db.execute('SELECT name,owner FROM members ORDER BY name').fetchall()
        assert members == [('member', 0), ('owner', 1)]
        assert db.execute('SELECT count(*) FROM messages').fetchone() == (124,)

    current = start()
    try:
        newcomer = Peer(port, context)
        newcomer.send({'type': 'history', 'before': '1'})
        assert newcomer.until('error')['code'] == 'login_required'
        newcomer.close()
        owner = authenticate('owner')
        owner.send({'type': 'join', 'room': room['room']})
        restored = owner.until('joined')
        assert restored['owner'] and restored['name'] == '七天旅行'
        assert restored['expires'] == room['expires']
        latest = [owner.receive() for _ in range(100)]
        assert [msg['text'] for msg in latest[:-1]] == [f'旅行消息 {i}' for i in range(24, 123)]
        assert latest[-1]['id'] == 'wave'
        assert owner.receive()['members'] == ['owner']
        older = []
        cursor = restored['history_before']
        while cursor:
            owner.send({'type': 'history', 'before': cursor})
            page = owner.until('history')
            older[0:0] = [msg['text'] for msg in page['messages']]
            cursor = page.get('before')
        assert older == [f'旅行消息 {i}' for i in range(24)]
        member = authenticate('member')
        member.send({'type': 'history', 'before': restored['history_before']})
        assert member.until('error')['code'] == 'not_joined'
        member.send({'type': 'join', 'room': room['room']})
        assert not member.until('joined')['owner']
        for _ in range(100):
            member.receive()
        assert member.receive()['type'] == 'members'
        assert owner.receive()['type'] == 'members'
        member.send({'type': 'chat', 'text': '旅行消息 0', 'client_id': delivery_id})
        assert member.receive() == {'type': 'chat_ack', 'client_id': delivery_id, 'message': original_confirmation}
        member.send({'type': 'chat', 'text': '更改内容', 'client_id': delivery_id})
        conflict = member.receive()
        assert conflict['code'] == 'client_id_conflict' and conflict['client_id'] == delivery_id
        owner.send({'type': 'ping'})
        assert owner.receive()['type'] == 'pong'
        with sqlite3.connect(rooms) as db:
            assert db.execute('SELECT count(*) FROM messages').fetchone() == (124,)
            assert db.execute('SELECT count(*) FROM chat_deliveries').fetchone() == (1,)
        member.close()
        worker = Peer(port, context)
        worker.send({'type': 'assistant_rpc', 'secret': secret, 'token': restored['assistant_token']})
        instance = worker.until('assistant_context')['instance']
        notice = {'type': 'notice_card', 'secret': secret, 'instance': instance, 'id': '1' * 32,
                  'title': '集合提醒', 'text': '请在东门集合', 'due': '2026-11-23T18:00:00+08:00',
                  'status': 'scheduled', 'revision': '1'}
        worker.send(notice)
        worker.until('notice_ack')
        announced = owner.until('notice')
        worker.close()
        owner.close()
    finally:
        current.terminate()
        current.communicate(timeout=5)

    current = start()
    try:
        owner = authenticate('owner')
        owner.send({'type': 'join', 'room': room['room']})
        reopened = owner.until('joined')
        assert reopened['owner']
        assert owner.until('notice')['sequence'] == announced['sequence']
        worker = Peer(port, context)
        worker.send(dict(notice, status='cancelled', revision='2'))
        worker.until('notice_ack')
        cancelled = owner.until('notice')
        assert cancelled['status'] == 'cancelled' and cancelled['sequence'] == announced['sequence']
        worker.close()
        with sqlite3.connect(rooms) as db:
            assert db.execute('SELECT count(*) FROM room_notice_messages').fetchone() == (1,)
            assert db.execute('SELECT count(*) FROM messages').fetchone() == (125,)
        owner.send({'type': 'close'})
        assert owner.until('closed')['reason'] == 'owner_closed'
        owner.send({'type': 'create'})
        expires = owner.until('joined')['room']
        owner.send({'type': 'chat', 'text': '到期时删除'})
        owner.until('chat')
        owner.close()
        with sqlite3.connect(rooms) as db:
            assert db.execute('SELECT count(*) FROM messages').fetchone() == (1,)
            assert db.execute('SELECT count(*) FROM room_notice_messages').fetchone() == (0,)
            assert db.execute('SELECT count(*) FROM chat_deliveries').fetchone() == (0,)
            db.execute('UPDATE rooms SET expires=? WHERE code=?', (int(time.time()) - 1, expires))
    finally:
        current.terminate()
        current.communicate(timeout=5)

    current = start(ttl=2)
    try:
        owner = authenticate('owner')
        owner.send({'type': 'create'})
        owner.until('joined')
        owner.send({'type': 'chat', 'text': '在线到期'})
        owner.until('chat')
        assert owner.until('closed')['reason'] == 'expired'
        owner.close()
        with sqlite3.connect(rooms) as db:
            for table in ('rooms', 'members', 'messages', 'chat_deliveries'):
                assert db.execute(f'SELECT count(*) FROM {table}').fetchone() == (0,), table
    finally:
        current.terminate()
        current.communicate(timeout=5)
    current = start()
    try:
        owner = authenticate('owner')
        for code in (expires, room['room']):
            owner.send({'type': 'join', 'room': code})
            assert owner.until('error')['code'] == 'room_not_found'
        owner.close()
        with sqlite3.connect(rooms) as db:
            for table in ('rooms', 'members', 'messages', 'chat_deliveries'):
                assert db.execute(f'SELECT count(*) FROM {table}').fetchone() == (0,), table
    finally:
        current.terminate()
        current.communicate(timeout=5)
    print('PASS seven-day TTL, abrupt restart, room identity and members, complete paged history, close and expiry cleanup')


if __name__ == '__main__':
    with tempfile.TemporaryDirectory() as directory:
        run(Path(directory))
