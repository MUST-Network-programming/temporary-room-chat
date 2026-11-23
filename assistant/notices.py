"""Verified email contacts and scheduled room notices that outlive a chat room."""
import asyncio
import hashlib
import hmac
import os
import re
import secrets
import smtplib
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path
from zoneinfo import ZoneInfo

from aiohttp import web

if __package__:
    from .backend import SECRET, ChatError, chat_rpc, deliver, local_mail_only
    from .registration import verified_email
else:
    from backend import SECRET, ChatError, chat_rpc, deliver, local_mail_only
    from registration import verified_email

TZ = ZoneInfo('Asia/Shanghai')
STATE = Path(os.environ.get('ASSISTANT_STATE', str(Path(__file__).resolve().parents[1] / '.local-v2')))
EMAIL = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
IDENTIFIER = re.compile(r'[a-f0-9]{32}')
SCHEMA = '''
CREATE TABLE IF NOT EXISTS contacts(account TEXT PRIMARY KEY, email TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS challenges(
    account TEXT PRIMARY KEY, email TEXT NOT NULL, digest TEXT NOT NULL,
    requested REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notices(
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, room TEXT NOT NULL, room_name TEXT NOT NULL,
    owner TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, due REAL NOT NULL,
    members INTEGER NOT NULL, recipients INTEGER NOT NULL, created REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled', revision INTEGER NOT NULL DEFAULT 1,
    shown_revision INTEGER NOT NULL DEFAULT 0, UNIQUE(owner, request_id)
);
CREATE INDEX IF NOT EXISTS notices_by_room ON notices(room);
CREATE INDEX IF NOT EXISTS notices_by_owner ON notices(owner, created);
CREATE TABLE IF NOT EXISTS deliveries(
    notice TEXT NOT NULL REFERENCES notices(id), account TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(notice, account)
);
CREATE INDEX IF NOT EXISTS deliveries_by_account ON deliveries(account, status);
'''


def initialize():
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with database() as conn:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.executescript(SCHEMA)


@contextmanager
def database():
    conn = sqlite3.connect(STATE / 'notices.sqlite3', timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def code_digest(account, email, code):
    return hmac.new(SECRET.encode(), f'{account}\0{email}\0{code}'.encode(), 'sha256').hexdigest()


def mail(email, subject, body, message_id):
    message = EmailMessage()
    message['From'] = os.environ.get('SMTP_FROM', 'notices@example.test')
    message['To'] = email
    message['Subject'] = subject
    message['Date'] = datetime.now(TZ)
    message['Message-ID'] = f'<{message_id}@temporary-chat>'
    message.set_content(body)
    return message


async def start_verification(account, payload):
    raw = payload.get('email')
    email = raw.strip().lower() if isinstance(raw, str) else ''
    if len(email) > 254 or not EMAIL.fullmatch(email):
        raise ValueError('请输入有效邮箱')
    if local_mail_only() and not email.endswith('@example.test'):
        raise ValueError('本地预览使用 @example.test 邮箱')
    now = time.time()
    code = f'{secrets.randbelow(1_000_000):06d}'
    digest = code_digest(account, email, code)
    with database() as conn:
        conn.execute('BEGIN IMMEDIATE')
        pending = conn.execute('SELECT requested FROM challenges WHERE account=?', (account,)).fetchone()
        if pending and now - pending['requested'] < 60:
            raise web.HTTPTooManyRequests(text='一分钟内只能发送一次验证码')
        conn.execute('''INSERT INTO challenges(account,email,digest,requested) VALUES(?,?,?,?)
                     ON CONFLICT(account) DO UPDATE SET email=excluded.email,digest=excluded.digest,
                     requested=excluded.requested,attempts=0''', (account, email, digest, now))
    try:
        message = mail(email, '同行 · 邮箱验证码', f'你的邮箱验证码是 {code}，10 分钟内有效。\n',
                       'verify-' + uuid.uuid4().hex)
        await asyncio.to_thread(deliver, message)
    except (OSError, smtplib.SMTPException, ValueError) as exc:
        print('Verification email failed:', type(exc).__name__, flush=True)
        raise web.HTTPServiceUnavailable(text='验证码邮件发送失败，请稍后重试') from exc


def confirm_email(account, payload):
    code = payload.get('code')
    if not isinstance(code, str) or not re.fullmatch(r'[0-9]{6}', code):
        raise ValueError('请输入六位验证码')
    with database() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute('SELECT * FROM challenges WHERE account=?', (account,)).fetchone()
        if not row or time.time() - row['requested'] > 600 or row['attempts'] >= 5:
            raise ValueError('验证码已失效，请重新发送')
        correct = hmac.compare_digest(row['digest'], code_digest(account, row['email'], code))
        if correct:
            conn.execute('''INSERT INTO contacts VALUES(?,?)
                         ON CONFLICT(account) DO UPDATE SET email=excluded.email''', (account, row['email']))
            # Keep the send timestamp for the resend limit after a successful verification.
            conn.execute('UPDATE challenges SET digest=?,attempts=5 WHERE account=?', ('', account))
        else:
            conn.execute('UPDATE challenges SET attempts=attempts+1 WHERE account=?', (account,))
    if not correct:
        raise ValueError('验证码有误')


def contact(account):
    with database() as conn:
        row = conn.execute('SELECT email FROM contacts WHERE account=?', (account,)).fetchone()
    return {'email': row['email'] if row else None,
            'registration_email': verified_email(account) if not row else None,
            'local_only': local_mail_only()}


def use_registration_email(account):
    email = verified_email(account)
    if not email:
        raise ValueError('当前没有可用于接收通知的注册邮箱')
    with database() as conn:
        conn.execute('INSERT INTO contacts(account,email) VALUES(?,?) ON CONFLICT(account) DO NOTHING',
                     (account, email))
        current = conn.execute('SELECT email FROM contacts WHERE account=?', (account,)).fetchone()
        if current['email'] != email:
            raise web.HTTPConflict(text='已有通知邮箱，请先解除绑定')


def unbind_email(account):
    with database() as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute('DELETE FROM contacts WHERE account=?', (account,))
        conn.execute('UPDATE challenges SET digest=?,attempts=5 WHERE account=?', ('', account))
        conn.execute("UPDATE deliveries SET status='skipped' WHERE account=? AND status='pending'", (account,))


def bound_members(conn, members):
    slots = ','.join('?' for _ in members)
    rows = conn.execute(f'SELECT account,email FROM contacts WHERE account IN ({slots})', members)
    return [row['account'] for row in rows if not local_mail_only() or row['email'].endswith('@example.test')]


def future_time(payload):
    raw = payload.get('due')
    if not isinstance(raw, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?', raw):
        raise ValueError('请选择北京时间的发送日期和时间')
    try:
        due = datetime.fromisoformat(raw).replace(tzinfo=TZ).timestamp()
    except (ValueError, OverflowError) as exc:
        raise ValueError('发送日期或时间无效') from exc
    if due <= time.time():
        raise ValueError('发送时间必须晚于当前时间')
    return due


def due_string(timestamp):
    return datetime.fromtimestamp(timestamp, TZ).isoformat(timespec='seconds')


def notice_text(payload, key, label, size, multiline=False):
    raw = payload.get(key)
    value = raw.strip() if isinstance(raw, str) else ''
    if (not value or any(char == '\x7f' or (ord(char) < 32 and
                         not (multiline and char in '\n\r\t')) for char in value)):
        raise ValueError(f'请输入有效的{label}')
    try:
        if len(value.encode()) <= size:
            return value
    except UnicodeEncodeError:
        raise ValueError(f'{label}含有无效字符') from None
    raise ValueError(f'{label}最多 {size} 个 UTF-8 字节')


def identifier(value):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValueError('通知编号无效')
    return value


def publish(context, payload, request_id):
    owner, room, members = context['account'], context['instance'], context['recipients']
    title = notice_text(payload, 'title', '标题', 240)
    body = notice_text(payload, 'body', '正文', 2048, multiline=True)
    due = future_time(payload)
    with database() as conn:
        conn.execute('BEGIN IMMEDIATE')
        existing = conn.execute('SELECT id FROM notices WHERE owner=? AND request_id=?',
                                (owner, request_id)).fetchone()
        if existing:
            return existing['id']
        if conn.execute('SELECT count(*) FROM notices WHERE room=?', (room,)).fetchone()[0] >= 64:
            raise web.HTTPConflict(text='本房间已达到通知数量上限')
        recipients = bound_members(conn, members)
        notice_id = uuid.uuid4().hex
        conn.execute('''INSERT INTO notices(id,request_id,room,room_name,owner,title,body,due,members,recipients,created)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?)''', (notice_id, request_id, room, context['name'], owner,
                     title, body, due, len(members), len(recipients), time.time()))
        conn.executemany('INSERT INTO deliveries(notice,account) VALUES(?,?)',
                         [(notice_id, account) for account in recipients])
    return notice_id


def change_notice(owner, payload, action):
    notice_id = identifier(payload.get('id'))
    due = future_time(payload) if action == 'reschedule' else None
    with database() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute('SELECT status,due FROM notices WHERE id=? AND owner=?', (notice_id, owner)).fetchone()
        if not row:
            raise web.HTTPNotFound(text='找不到这条通知')
        if action == 'cancel' and row['status'] == 'cancelled':
            return notice_id
        if row['status'] != 'scheduled' or row['due'] <= time.time():
            raise web.HTTPConflict(text='只能修改或撤销尚未到达发送时间的通知')
        if action == 'cancel':
            conn.execute("UPDATE notices SET status='cancelled',revision=revision+1 WHERE id=?", (notice_id,))
            conn.execute("UPDATE deliveries SET status='cancelled' WHERE notice=? AND status='pending'", (notice_id,))
        else:
            conn.execute('UPDATE notices SET due=?,revision=revision+1 WHERE id=?', (due, notice_id))
    return notice_id


def mine(owner):
    with database() as conn:
        rows = conn.execute('''SELECT id,room_name,title,body,due,members,recipients,status FROM notices
                              WHERE owner=? ORDER BY created DESC''', (owner,)).fetchall()
        counts = {}
        for row in conn.execute('''SELECT d.notice,d.status,count(*) AS total FROM deliveries d
                                JOIN notices n ON n.id=d.notice WHERE n.owner=? GROUP BY d.notice,d.status''', (owner,)):
            counts.setdefault(row['notice'], {})[row['status']] = row['total']
    return [dict(row, due=due_string(row['due']), deliveries=counts.get(row['id'], {})) for row in rows]


async def announce(notice_id):
    with database() as conn:
        notice = conn.execute('SELECT * FROM notices WHERE id=? AND shown_revision<revision', (notice_id,)).fetchone()
    if not notice:
        return
    revision = notice['revision']
    try:
        await chat_rpc('notice_card', 'notice_ack', instance=notice['room'], id=notice_id, title=notice['title'],
                       text=notice['body'], due=due_string(notice['due']), status=notice['status'],
                       revision=str(revision))
    except ChatError as exc:
        if exc.code != 'room_not_found':
            print('Notice announcement rejected:', exc.code, flush=True)
            return
    except (OSError, asyncio.TimeoutError, web.HTTPServiceUnavailable):
        return
    with database() as conn:
        conn.execute('UPDATE notices SET shown_revision=? WHERE id=? AND shown_revision<?',
                     (revision, notice_id, revision))


async def identity(request, room=False):
    header = request.headers.get('Authorization', '')
    login = header[7:] if header.startswith('Bearer ') else ''
    if not re.fullmatch('[a-f0-9]{64}', login):
        raise web.HTTPUnauthorized(text='请先登录账号')
    try:
        if room:
            return await chat_rpc('notice_room', 'notice_context', login=login,
                                  token=request.headers.get('X-Room-Token', ''))
        return await chat_rpc('account_identity', 'account_context', login=login)
    except ChatError as exc:
        error = web.HTTPUnauthorized if exc.code == 'login_required' else web.HTTPForbidden
        raise error(text=str(exc)) from exc


async def api(request):
    action = request.match_info['action']
    if request.method == 'GET':
        account = (await identity(request))['account']
        data = contact(account) if action == 'contact' else {'notices': mine(account)}
        return web.json_response(data)
    payload = await request.json()
    if not isinstance(payload, dict):
        raise ValueError('请求内容无效')
    if action == 'preview':
        context = await identity(request, room=True)
        with database() as conn:
            count = len(bound_members(conn, context['recipients']))
        return web.json_response({'members': len(context['recipients']), 'recipients': count})
    if action == 'publish':
        request_id = identifier(payload.get('request_id'))
        account = (await identity(request))['account']
        with database() as conn:
            previous = conn.execute('SELECT id FROM notices WHERE owner=? AND request_id=?',
                                    (account, request_id)).fetchone()
        notice_id = previous['id'] if previous else publish(await identity(request, room=True), payload, request_id)
        await announce(notice_id)
        return web.json_response({'id': notice_id})
    account = (await identity(request))['account']
    if action in ('cancel', 'reschedule'):
        await announce(change_notice(account, payload, action))
    elif action == 'send-code':
        await start_verification(account, payload)
    elif action == 'verify':
        confirm_email(account, payload)
    elif action == 'use-registration-email':
        use_registration_email(account)
    elif action == 'unbind':
        unbind_email(account)
    return web.json_response({'ok': True})


def routes(app):
    initialize()
    app.router.add_get(r'/api/notices/{action:contact|mine}', api)
    app.router.add_post(r'/api/notices/{action:preview|publish|cancel|reschedule|send-code|verify|use-registration-email|unbind}', api)


def claim():
    with database() as conn:
        conn.execute('BEGIN IMMEDIATE')
        rows = conn.execute('''SELECT n.id,n.room_name,n.title,n.body,n.due,d.account,c.email
                               FROM deliveries d JOIN notices n ON n.id=d.notice
                               LEFT JOIN contacts c ON c.account=d.account
                               WHERE d.status='pending' AND n.status='scheduled' AND n.due<=?
                               ORDER BY n.due LIMIT 8''', (time.time(),)).fetchall()
        jobs = []
        for row in rows:
            can_send = row['email'] and (not local_mail_only() or row['email'].endswith('@example.test'))
            conn.execute('UPDATE deliveries SET status=? WHERE notice=? AND account=?',
                         ('sending' if can_send else 'skipped', row['id'], row['account']))
            if can_send:
                jobs.append(row)
    return jobs


async def send_email(job):
    try:
        destination = hashlib.sha256(job['account'].encode()).hexdigest()[:16]
        message = mail(job['email'], f"【重要通知】{job['title']}",
                       f"{job['room_name']}\n\n{job['body']}\n",
                       f"notice-{job['id']}-{destination}")
        await asyncio.to_thread(deliver, message)
        status = 'sent'
    except (smtplib.SMTPResponseException, smtplib.SMTPRecipientsRefused, ValueError, ConnectionRefusedError):
        status = 'failed'
    except Exception as exc:
        print('Notice email result uncertain:', type(exc).__name__, flush=True)
        status = 'uncertain'
    with database() as conn:
        conn.execute("UPDATE deliveries SET status=? WHERE notice=? AND account=? AND status IN ('sending','uncertain')",
                     (status, job['id'], job['account']))


async def replay_cards():
    with database() as conn:
        pending = conn.execute('SELECT id FROM notices WHERE shown_revision<revision ORDER BY created LIMIT 4').fetchall()
    await asyncio.gather(*(announce(row['id']) for row in pending))


async def dispatch_due():
    while jobs := claim():
        await asyncio.gather(*(send_email(job) for job in jobs))


async def poll(action):
    while True:
        try:
            await action()
        except Exception as exc:
            print('Notice scheduler:', type(exc).__name__, flush=True)
        await asyncio.sleep(1)


async def worker():
    initialize()
    with database() as conn:
        conn.execute("UPDATE deliveries SET status='uncertain' WHERE status='sending'")
    await asyncio.gather(poll(dispatch_due), poll(replay_cards))
