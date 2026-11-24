"""真实 WebSocket 验证确认丢失后的重试不会重复广播或调用群聊助手。"""
import os
import socket
import subprocess
import time
from integration import Peer, ROOT


def main():
    with socket.socket() as available:
        available.bind(('127.0.0.1', 0))
        port = available.getsockname()[1]
    secret = 'delivery-protocol-local-worker-secret'
    process = subprocess.Popen([str(ROOT / 'build/chat_server'), '--anonymous-loopback', '--port', str(port)],
                               env={**os.environ, 'ASSISTANT_SHARED_SECRET': secret},
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    peers = []
    try:
        for _ in range(50):
            assert process.poll() is None
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=.1):
                    break
            except OSError:
                time.sleep(.05)
        sender, observer, worker = peers = [Peer(port) for _ in range(3)]
        sender.send({'type': 'create', 'nickname': 'sender'})
        room = sender.until('joined')
        observer.send({'type': 'join', 'room': room['room'], 'nickname': 'observer'})
        observer.until('joined')
        sender.until('members')
        observer.until('members')
        worker.send({'type': 'bot_watch', 'secret': secret})
        worker.until('bot_ready')
        outgoing = {'type': 'chat', 'text': '@群聊助手 请回答', 'client_id': '0123456789abcdef0123456789abcdef'}
        sender.send(outgoing)
        original = sender.until('chat')
        assert observer.receive() == original
        confirmation = sender.receive()
        assert confirmation == {'type': 'chat_ack', 'client_id': outgoing['client_id'], 'message': original}
        request = worker.receive()
        assert request['type'] == 'bot_request'
        sender.send(outgoing)
        assert sender.receive() == confirmation
        # 顺序屏障：重试后各连接的下一条帧只能是 pong。
        for peer in peers:
            peer.send({'type': 'ping'})
            assert peer.receive()['type'] == 'pong'
        worker.send({'type': 'bot_reply', 'instance': request['instance'], 'id': request['id'], 'text': 'confirmed once'})
        reply = sender.receive()
        assert reply['type'] == 'chat' and reply['bot'] and isinstance(reply['sent_at'], int)
        assert observer.receive() == reply
        print('PASS correlated ACK, unchanged retry payload, single broadcast and bot trigger, bot server timestamp')
    finally:
        for peer in peers:
            peer.close()
        process.terminate()
        process.communicate(timeout=5)


if __name__ == '__main__':
    main()
