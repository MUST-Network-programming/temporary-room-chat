"""真实 TCP/WebSocket 端到端验收，仅使用 Python 标准库。"""
import base64, hashlib, json, os, socket, ssl, struct, subprocess, sys, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
class Peer:
    def __init__(self, port, context=None, hostname='localhost'):
        self.s = socket.create_connection(('127.0.0.1', port), timeout=3)
        if context: self.s = context.wrap_socket(self.s, server_hostname=hostname)
        key = base64.b64encode(os.urandom(16)).decode()
        request = f'GET /ws HTTP/1.1\r\nHost: localhost:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'.encode()
        # 故意将 HTTP 握手分成两次发送。
        self.s.sendall(request[:23]); time.sleep(.01); self.s.sendall(request[23:])
        response = b''
        while not response.endswith(b'\r\n\r\n'): response += self.s.recv(1)
        assert b'101' in response, response
        accept = base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        assert accept in response
    def frame(self, data, opcode=1, final=True):
        mask = os.urandom(4)
        head = bytes([(128 if final else 0)|opcode])
        head += bytes([128|len(data)]) if len(data)<126 else bytes([254])+struct.pack('!H',len(data))
        return head+mask+bytes(v^mask[i%4] for i,v in enumerate(data))
    def send(self, obj, fragmented=False):
        data = json.dumps(obj,ensure_ascii=False).encode()
        if fragmented:
            frame=self.frame(data[:5],final=False)+self.frame(data[5:],opcode=0)
        else: frame=self.frame(data)
        self.s.sendall(frame[:3]); time.sleep(.01); self.s.sendall(frame[3:])
    def exact(self,n):
        result=b''
        while len(result)<n:
            chunk=self.s.recv(n-len(result))
            if not chunk: raise EOFError('连接已关闭')
            result+=chunk
        return result
    def receive(self):
        a,b=self.exact(2); length=b&127
        if length==126: length=struct.unpack('!H',self.exact(2))[0]
        if length==127: length=struct.unpack('!Q',self.exact(8))[0]
        data=self.exact(length)
        if a&15==8: return {'type':'ws_close'}
        return json.loads(data)
    def until(self, kind):
        for _ in range(100):
            msg=self.receive()
            if msg['type']==kind: return msg
        raise AssertionError('missing '+kind)
    def close(self): self.s.close()
def scenario(port, context=None):
    a,b,c=[Peer(port,context) for _ in range(3)]
    try:
        a.send({'type':'create','nickname':'房主'},True); joined=a.until('joined'); code=joined['room']
        b.send({'type':'join','room':code,'nickname':'同学'}); bj=b.until('joined')
        c.send({'type':'create','nickname':'另一个房间'}); c.until('joined')
        b.send({'type':'chat','text':'你好 network'},True)
        assert a.until('chat')['text']=='你好 network'
        assert b.until('chat')['nickname']=='同学'
        c.send({'type':'ping'})
        while True:
            message=c.receive(); assert message['type']!='chat','房间串消息'
            if message['type']=='pong': break
        b.close(); time.sleep(.15); b=Peer(port,context)
        b.send({'type':'join','room':code,'nickname':'同学','token':bj['token']}); assert b.until('joined')['token']==bj['token']
        b.send({'type':'close'}); b.until('error')
        b.send({'type':'chat','text':'x'*2049}); b.until('error')
        b.send({'type':'unknown'}); b.until('error')
        a.close(); time.sleep(.15); a=Peer(port,context)
        a.send({'type':'join','room':code,'nickname':'房主','token':joined['token']}); assert a.until('joined')['owner']
        b.send({'type':'rename','name':'禁止改名'})
        assert b.until('error')['code']=='forbidden'
        a.send({'type':'rename','name':'周末同行'})
        assert a.until('renamed')['name']==b.until('renamed')['name']=='周末同行'
        b.send({'type':'sticker','id':'unknown'})
        assert b.until('error')['code']=='invalid_sticker'
        for i in range(101):
            b.send({'type':'chat','text':str(i)})
            assert a.until('chat')['text']==b.until('chat')['text']==str(i)
        b.send({'type':'sticker','id':'wave'})
        assert a.until('sticker')['id']==b.until('sticker')['id']=='wave'
        late=Peer(port,context)
        try:
            late.send({'type':'join','room':code,'nickname':'新成员'})
            assert late.until('joined')['name']=='周末同行'
            assert [late.receive()['text'] for _ in range(99)]==list(map(str,range(2,101)))
            assert late.receive()['id']=='wave'
            assert late.receive()['type']=='members'
        finally: late.close()
        print('PASS owner rename, rejected sticker, latest 100 in order on late join')
        a.send({'type':'close'}); b.until('closed')
        c.send({'type':'leave'}); c.send({'type':'join','room':code,'nickname':'late'}); c.until('error')
        bad=Peer(port,context); bad.s.sendall(b'\x81\x02{}'); assert bad.until('ws_close'); bad.close()
        print('PASS rooms, isolation, partial reads, fragmentation, reconnect, owner authorization, limits, invalid frames')
    finally:
        for p in (a,b,c): p.close()
def main():
    binary=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'build/chat_server'
    assert binary.is_file(), 'C 服务端尚未构建'
    port=18765
    command=[str(binary),'--anonymous-loopback','--port',str(port),'--ttl','30']
    context=None
    if len(sys.argv)>2:
        certs=Path(sys.argv[2]); command += ['--cert',str(certs/'server.crt'),'--key',str(certs/'server.key')]
        context=ssl.create_default_context(cafile=str(certs/'ca.crt'))
    process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            assert process.poll() is None, process.stdout.read().decode()
            try:
                with socket.create_connection(('127.0.0.1',port),timeout=.1): pass
                break
            except OSError: time.sleep(.1)
        else: raise AssertionError('服务端启动超时')
        scenario(port,context)
        if context:
            for ctx, hostname in [(ssl.create_default_context(),'localhost'),(context,'wrong.example')]:
                try: Peer(port,ctx,hostname)
                except ssl.SSLCertVerificationError: pass
                else: raise AssertionError('错误证书被接受')
            print('PASS trusted certificate, untrusted CA rejected, hostname mismatch rejected')
    finally:
        process.terminate(); process.wait(timeout=5)
if __name__=='__main__': main()
