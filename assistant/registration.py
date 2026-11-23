"""Opt-in registration codes delivered by SMTP.

Default is off. This does not replace organizer-issued invites. A code is
created only after the address is accepted for delivery, and it is deleted
again if SMTP rejects the message. The code is never returned to the caller.
"""
from ipaddress import ip_address
import os
import re
import secrets
import smtplib
import sqlite3
import ssl
import time
from email.message import EmailMessage

EMAIL_RE = re.compile(
    r'^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
)
GENERIC = {'ok': True}
FAILED = {'error': '邮件未能发出，没有生成可用注册码'}


def enabled():
    return os.environ.get('REGISTRATION_EMAIL') == '1'


def normalize_email(value):
    if not isinstance(value, str):
        raise ValueError('email')
    text = value.strip().lower()
    if not text or len(text) > 254 or any(ord(ch) <= 32 or ord(ch) == 127 for ch in text):
        raise ValueError('email')
    if not EMAIL_RE.fullmatch(text):
        raise ValueError('email')
    return text


def env_int(name, default, low, high):
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


def recipient_allowed(email):
    external = os.environ.get('ALLOW_EXTERNAL_EMAIL') == '1'
    host = os.environ.get('SMTP_HOST', '127.0.0.1')
    if not external and (host not in ('127.0.0.1', 'localhost') or not email.endswith('@example.test')):
        return False
    return True


def accounts_path():
    return os.environ.get('ACCOUNTS_DB', '')


def connect(path):
    conn = sqlite3.connect(path, timeout=5, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA busy_timeout=5000')
    ensure_schema(conn)
    return conn


def column_exists(conn, table, column):
    rows = conn.execute(f'PRAGMA table_info({table})').fetchall()
    return any(row[1] == column for row in rows)


def ensure_schema(conn):
    conn.execute('CREATE TABLE IF NOT EXISTS accounts(name TEXT PRIMARY KEY, salt BLOB NOT NULL, hash BLOB NOT NULL)')
    conn.execute('CREATE TABLE IF NOT EXISTS invites(code TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0)')
    alters = (
        ('invites', 'email', 'ALTER TABLE invites ADD COLUMN email TEXT'),
        ('invites', 'expires', 'ALTER TABLE invites ADD COLUMN expires INTEGER'),
        ('invites', 'attempts', 'ALTER TABLE invites ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0'),
        ('invites', 'issued', 'ALTER TABLE invites ADD COLUMN issued INTEGER'),
        ('accounts', 'email', 'ALTER TABLE accounts ADD COLUMN email TEXT'),
    )
    for table, column, sql in alters:
        if not column_exists(conn, table, column):
            conn.execute(sql)
    conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_unique ON accounts(email) WHERE email IS NOT NULL')
    conn.execute('CREATE INDEX IF NOT EXISTS invites_email ON invites(email)')
    conn.execute(
        'CREATE TABLE IF NOT EXISTS registration_limits('
        'bucket TEXT PRIMARY KEY, hits INTEGER NOT NULL, window_start INTEGER NOT NULL)'
    )


def bump(conn, bucket, limit, window, now):
    row = conn.execute(
        'SELECT hits, window_start FROM registration_limits WHERE bucket=?', (bucket,)
    ).fetchone()
    if row is None or now - int(row['window_start']) >= window:
        conn.execute(
            'INSERT INTO registration_limits(bucket, hits, window_start) VALUES (?,?,?) '
            'ON CONFLICT(bucket) DO UPDATE SET hits=1, window_start=excluded.window_start',
            (bucket, 1, now),
        )
        return True
    if int(row['hits']) >= limit:
        return False
    conn.execute('UPDATE registration_limits SET hits=hits+1 WHERE bucket=?', (bucket,))
    return True


def send_registration(email, code):
    """Transactional registration mail. Not an itinerary job and not retried."""
    from assistant.service import deliver

    message = EmailMessage()
    message['From'] = os.environ.get('SMTP_FROM', 'itinerary@example.test')
    message['To'] = email
    message['Subject'] = '临时房间聊天室注册码'
    message['Message-ID'] = f'<{secrets.token_hex(16)}@local.test>'
    ttl = env_int('REGISTRATION_CODE_TTL', 600, 1, 86400)
    message.set_content(
        '这是一次性注册码，请在页面填写，不要把注册码发给他人。\n'
        f'注册码：{code}\n'
        f'约 {ttl} 秒内有效，使用一次后立即失效。\n'
        '如果这不是你本人的操作，忽略本邮件即可。网页和服务器日志不会显示这个注册码。\n'
    )
    deliver(message)


def client_ip(request):
    peer = request.remote or 'unknown'
    try:
        peer_address = ip_address(peer)
    except ValueError:
        return 'unknown'
    if not peer_address.is_loopback:
        return str(peer_address)

    # 网关仅监听本机，公网入口须用 nginx 连接对端地址覆盖 X-Real-IP。
    # 忽略客户端可提供的转发链。缺失或不合法时按本机连接统一限流。
    try:
        address = ip_address(request.headers.get('X-Real-IP', '').strip())
    except ValueError:
        return str(peer_address)
    return str(address) if getattr(address, 'scope_id', None) is None else str(peer_address)


def request_registration_code(db_path, email, ip):
    if not enabled():
        return 403, {'error': '邮箱注册未开启'}
    if not db_path:
        return 503, FAILED
    try:
        email = normalize_email(email)
    except ValueError:
        return 400, {'error': '邮箱格式无效'}
    if not recipient_allowed(email):
        return 403, {'error': '当前邮件配置不允许向该地址发送'}
    ttl = env_int('REGISTRATION_CODE_TTL', 600, 1, 86400)
    resend = env_int('REGISTRATION_RESEND_SECONDS', 60, 1, 3600)
    window = env_int('REGISTRATION_LIMIT_WINDOW', 600, 1, 86400)
    ip_max = env_int('REGISTRATION_IP_LIMIT', 5, 1, 100)
    email_max = env_int('REGISTRATION_EMAIL_LIMIT', 3, 1, 20)
    now = int(time.time())
    code = secrets.token_hex(16)
    try:
        conn = connect(db_path)
    except sqlite3.Error:
        print('registration email failed', 'sqlite', flush=True)
        return 503, FAILED
    try:
        try:
            conn.execute('BEGIN IMMEDIATE')
            if not bump(conn, 'ip:' + ip, ip_max, window, now) or not bump(conn, 'em:' + email, email_max, window, now):
                conn.commit()
                return 429, {'error': '请稍后再请求注册码', 'retry_after': resend}
            existing = conn.execute('SELECT 1 FROM accounts WHERE email=?', (email,)).fetchone()
            if existing:
                # Same response as a real send so the endpoint does not reveal whether the address is registered.
                conn.commit()
                return 200, GENERIC
            recent = conn.execute(
                'SELECT issued FROM invites WHERE email=? AND used=0 ORDER BY issued DESC LIMIT 1', (email,)
            ).fetchone()
            if recent and recent['issued'] is not None and now - int(recent['issued']) < resend:
                conn.commit()
                wait = max(1, resend - (now - int(recent['issued'])))
                return 429, {'error': '请稍后再请求注册码', 'retry_after': wait}
            conn.execute(
                'INSERT INTO invites(code, used, email, expires, attempts, issued) VALUES (?,?,?,?,0,?)',
                (code, 0, email, now + ttl, now),
            )
            conn.commit()
        except sqlite3.Error:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
            print('registration email failed', 'sqlite', flush=True)
            return 503, FAILED
        try:
            send_registration(email, code)
        except (OSError, smtplib.SMTPException, ValueError, ssl.SSLError):
            try:
                conn.execute('BEGIN IMMEDIATE')
                conn.execute('DELETE FROM invites WHERE code=? AND used=0', (code,))
                conn.commit()
            except sqlite3.Error:
                try:
                    conn.rollback()
                except sqlite3.Error:
                    pass
            print('registration email failed', 'smtp', flush=True)
            return 503, FAILED
        try:
            conn.execute('BEGIN IMMEDIATE')
            conn.execute('UPDATE invites SET used=1 WHERE email=? AND used=0 AND code!=?', (email, code))
            conn.commit()
        except sqlite3.Error:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
        print('registration email accepted', flush=True)
        return 200, GENERIC
    finally:
        conn.close()
