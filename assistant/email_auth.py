"""Issue single-use email sign-in challenges for the C authentication service."""
from contextlib import closing
from hashlib import sha256
from ipaddress import ip_address
from pathlib import Path
import os
import re
import secrets
import smtplib
import sqlite3
import ssl
import time
from email.message import EmailMessage

if __package__:
    from .backend import deliver, recipient_allowed
else:
    from backend import deliver, recipient_allowed

EMAIL_RE = re.compile(
    r'^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
)
FAILED = {'error': '验证码暂时无法发送，请稍后重试'}


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


def accounts_path():
    return os.environ.get('ACCOUNTS_DB', '')


def verified_email(account):
    path = accounts_path()
    if not path:
        return None
    try:
        with closing(sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)) as conn:
            row = conn.execute('SELECT email FROM accounts WHERE name=?', (account,)).fetchone()
    except sqlite3.Error:
        return None
    address = row[0] if row else None
    return address if isinstance(address, str) and address and recipient_allowed(address) else None


def connect(path):
    # 由聊天服务初始化共享数据库，网关只打开现有数据库。
    conn = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=rw', uri=True,
                           timeout=5, isolation_level=None)
    conn.row_factory = sqlite3.Row
    return conn


def login_ready():
    path = accounts_path()
    if not path:
        return False
    try:
        with closing(connect(path)) as conn:
            conn.execute('SELECT key, proof, email, expires, attempts FROM login_challenges LIMIT 0')
            conn.execute('SELECT bucket, hits, window_start FROM login_limits LIMIT 0')
            return True
    except sqlite3.Error:
        return False


def bump(conn, bucket, limit, window, now):
    row = conn.execute(
        'SELECT hits, window_start FROM login_limits WHERE bucket=?', (bucket,)
    ).fetchone()
    if row is None or now - int(row['window_start']) >= window:
        conn.execute(
            'INSERT INTO login_limits(bucket, hits, window_start) VALUES (?,?,?) '
            'ON CONFLICT(bucket) DO UPDATE SET hits=1, window_start=excluded.window_start',
            (bucket, 1, now),
        )
        return True
    if int(row['hits']) >= limit:
        return False
    conn.execute('UPDATE login_limits SET hits=hits+1 WHERE bucket=?', (bucket,))
    return True


def send_login_code(email, code, ttl):
    message = EmailMessage()
    message['From'] = os.environ.get('SMTP_FROM', 'itinerary@example.test')
    message['To'] = email
    message['Subject'] = '临时房间聊天室登录验证码'
    message['Message-ID'] = f'<{secrets.token_hex(16)}@local.test>'
    message.set_content(
        f'登录验证码：{code}\n'
        f'约 {ttl} 秒内有效，使用后立即失效。\n'
        '请在请求验证码的页面输入，勿将验证码分享给他人。若非本人操作，请忽略。\n'
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


def request_login_code(db_path, email, ip):
    try:
        email = normalize_email(email)
    except ValueError:
        return 400, {'error': '邮箱格式无效'}
    if not db_path:
        return 503, FAILED
    if not recipient_allowed(email):
        return 403, {'error': '本地预览请使用 @example.test 邮箱'}

    ttl = env_int('LOGIN_CODE_TTL', 300, 30, 1800)
    resend = env_int('LOGIN_RESEND_SECONDS', 60, 1, 3600)
    window = env_int('LOGIN_LIMIT_WINDOW', 600, 60, 86400)
    ip_max = env_int('LOGIN_IP_LIMIT', 12, 1, 100)
    email_max = env_int('LOGIN_EMAIL_LIMIT', 4, 1, 20)
    now = int(time.time())
    challenge = secrets.token_hex(32)
    code = f'{secrets.randbelow(1000000):06d}'
    key = sha256(challenge.encode()).digest()
    proof = sha256(f'{challenge}:{code}'.encode()).digest()
    try:
        with closing(connect(db_path)) as conn:
            conn.execute('BEGIN IMMEDIATE')
            conn.execute('DELETE FROM login_challenges WHERE expires<=?', (now,))
            conn.execute('DELETE FROM login_limits WHERE window_start<=?', (now - max(window, resend),))
            if not bump(conn, 'ip:' + ip, ip_max, window, now):
                conn.commit()
                return 429, {'error': '请求次数过多，请稍后再试', 'retry_after': window}
            recent = conn.execute('SELECT window_start FROM login_limits WHERE bucket=?',
                                  ('resend:' + email,)).fetchone()
            if recent and (wait := resend - (now - recent['window_start'])) > 0:
                conn.commit()
                return 429, {'error': '请稍后再发送验证码', 'retry_after': wait}
            if not bump(conn, 'email:' + email, email_max, window, now):
                conn.commit()
                return 429, {'error': '请求次数过多，请稍后再试', 'retry_after': window}
            bump(conn, 'resend:' + email, 1, resend, now)
            conn.execute('INSERT INTO login_challenges(key,proof,email,expires) VALUES (?,?,?,?)',
                         (key, proof, email, now + ttl))
            conn.commit()
            try:
                send_login_code(email, code, ttl)
            except (OSError, smtplib.SMTPException, ValueError, ssl.SSLError):
                conn.execute('DELETE FROM login_challenges WHERE key=?', (key,))
                print('login email failed: smtp', flush=True)
                return 503, FAILED
    except sqlite3.Error:
        print('login email failed: sqlite', flush=True)
        return 503, FAILED
    return 200, {'challenge': challenge, 'retry_after': resend}
