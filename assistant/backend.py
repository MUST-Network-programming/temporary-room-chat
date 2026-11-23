"""Connections shared by the itinerary service, chat bot and room notices."""
import os
import smtplib
import ssl

from aiohttp import ClientSession, ClientTimeout, WSMsgType, web

SECRET = os.environ.get('ASSISTANT_SHARED_SECRET', '')
C_URL = os.environ.get('CHAT_INTERNAL_WS', 'ws://127.0.0.1:8080/ws')


def chat_ssl():
    if C_URL.startswith('wss:'):
        return ssl.create_default_context(cafile=os.environ.get('CHAT_CA_FILE') or None)
    return True


class ChatError(Exception):
    def __init__(self, message):
        self.code = message['code']
        super().__init__(message['message'])


async def chat_rpc(action, response, **fields):
    if len(SECRET) < 32:
        raise web.HTTPServiceUnavailable(text='未配置助手内部共享密钥')
    async with ClientSession(timeout=ClientTimeout(total=8)) as session:
        async with session.ws_connect(C_URL, ssl=chat_ssl(), max_msg_size=512 * 1024) as ws:
            await ws.send_json(dict(type=action, secret=SECRET, **fields))
            incoming = await ws.receive(timeout=8)
            if incoming.type != WSMsgType.TEXT:
                raise OSError('Chat server closed the internal connection')
            message = incoming.json()
    if message['type'] == 'error':
        raise ChatError(message)
    if message['type'] != response:
        raise OSError('Chat server returned an unexpected response')
    return message


async def model_completion(messages, **options):
    if os.environ.get('AI_MODE') != 'openai' or not os.environ.get('AI_API_KEY'):
        raise ValueError('AI provider 未配置')
    model = os.environ.get('AI_MODEL', 'gpt-4.1-mini')
    url = os.environ.get('AI_BASE_URL', 'https://api.openai.com/v1').rstrip('/')
    async with ClientSession(timeout=ClientTimeout(total=45)) as session:
        async with session.post(url + '/chat/completions',
                                headers={'Authorization': 'Bearer ' + os.environ['AI_API_KEY']},
                                json=dict(model=model, messages=messages, **options)) as response:
            if response.status != 200:
                raise ValueError('AI provider 返回错误，请检查后台配置')
            data = await response.json()
    return data['choices'][0]['message']['content'], model


def local_mail_only():
    return os.environ.get('ALLOW_EXTERNAL_EMAIL') != '1'


def deliver(message):
    host = os.environ.get('SMTP_HOST', '127.0.0.1')
    port = int(os.environ.get('SMTP_PORT', '1025'))
    if local_mail_only() and (host not in ('127.0.0.1', 'localhost') or
                              not str(message['To']).endswith('@example.test')):
        raise ValueError('已阻止外部邮件投递')
    use_ssl = os.environ.get('SMTP_SSL') == '1'
    smtp = (smtplib.SMTP_SSL(host, port, timeout=10, context=ssl.create_default_context())
            if use_ssl else smtplib.SMTP(host, port, timeout=10))
    try:
        if not local_mail_only() and not use_ssl:
            smtp.starttls(context=ssl.create_default_context())
        if os.environ.get('SMTP_USERNAME'):
            smtp.login(os.environ['SMTP_USERNAME'], os.environ.get('SMTP_PASSWORD', ''))
        refused = smtp.send_message(message)
        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)
    finally:
        # DATA already established the delivery result. QUIT cannot change it.
        smtp.close()
