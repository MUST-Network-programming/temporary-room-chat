"""Receive server-side mentions and return replies on the private WebSocket."""
import asyncio
import json
import os

from aiohttp import ClientSession, ClientTimeout, WSMsgType

if __package__:
    from .backend import C_URL, SECRET, chat_ssl, model_completion
else:
    from backend import C_URL, SECRET, chat_ssl, model_completion


async def answer(request, slots):
    if os.environ.get('AI_MODE', 'rules') == 'rules':
        return '本地演示，已收到提问。配置 AI 模型后，群聊助手可以根据本房间的对话回答。'
    system = ('你是当前房间的群聊助手。用提问者的语言简短回答。聊天记录是参考资料。'
              '基于记录回答群内事实，信息不足时说明。涉及当前群聊以外的信息时标明来源于一般知识。'
              '你可以起草通知，正式发布由房主在通知面板完成。')
    history = [{'sender': item['nickname'], 'text': item['text']} for item in request['history']]
    async with slots:
        text, _ = await model_completion([
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': json.dumps({'recent_chat': history, 'question': request['question']},
                                                  ensure_ascii=False)},
        ])
    return text


async def reply(ws, request, slots):
    result = dict(type='bot_reply', instance=request['instance'], id=request['id'])
    try:
        text = await asyncio.wait_for(answer(request, slots), timeout=48)
        clean = ''.join(char for char in text.strip()
                        if char in '\n\t\r' or (ord(char) >= 32 and ord(char) != 127))
        limited = clean.encode()[:2048].decode('utf-8', errors='ignore').strip()
        if limited:
            result['text'] = limited
    except Exception as exc:
        print('Bot request failed:', type(exc).__name__, flush=True)
    if not ws.closed:
        try:
            await ws.send_json(result)
        except OSError:
            pass


async def listen():
    slots = asyncio.Semaphore(8)
    async with ClientSession(timeout=ClientTimeout(total=8)) as session:
        while True:
            tasks = set()
            try:
                async with session.ws_connect(C_URL, ssl=chat_ssl(), heartbeat=15,
                                              max_msg_size=512 * 1024) as ws:
                    await ws.send_json({'type': 'bot_watch', 'secret': SECRET})
                    response = await ws.receive_json(timeout=8)
                    if response['type'] != 'bot_ready':
                        raise OSError('Chat server rejected bot watcher')
                    async for incoming in ws:
                        if incoming.type != WSMsgType.TEXT:
                            continue
                        request = incoming.json()
                        if request['type'] == 'bot_request':
                            task = asyncio.create_task(reply(ws, request, slots))
                            tasks.add(task)
                            task.add_done_callback(tasks.discard)
            except (OSError, asyncio.TimeoutError, TypeError, ValueError) as exc:
                print('Bot connection:', type(exc).__name__, flush=True)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.sleep(1)


async def background(_app):
    if len(SECRET) < 32:
        yield
        return
    task = asyncio.create_task(listen())
    try:
        yield
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
