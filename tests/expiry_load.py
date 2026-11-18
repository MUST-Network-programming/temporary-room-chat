"""短 TTL 和多连接广播验收。"""
from integration import Peer, ROOT
import subprocess, time, socket, sys, ssl
binary=str((ROOT/(sys.argv[1] if len(sys.argv)>1 else 'build/chat_server')).resolve())
context=None
extra=[]
if len(sys.argv)>2:
    certs=ROOT/sys.argv[2]
    context=ssl.create_default_context(cafile=str(certs/'ca.crt'))
    extra=['--cert',str(certs/'server.crt'),'--key',str(certs/'server.key')]
def launch(ttl):
    process=subprocess.Popen([binary,'--anonymous-loopback','--port','18766','--ttl',str(ttl),*extra],cwd=ROOT,stdout=subprocess.DEVNULL)
    for _ in range(50):
        assert process.poll() is None
        try:
            with socket.create_connection(('127.0.0.1',18766),timeout=.1): pass
            return process
        except OSError: time.sleep(.1)
    raise AssertionError('startup timeout')
p=launch(2)
try:
    a=Peer(18766,context); a.send({'type':'create','nickname':'expire'}); code=a.until('joined')['room']
    assert a.until('closed')['reason']; a.close()
    b=Peer(18766,context); b.send({'type':'join','room':code,'nickname':'late'}); b.until('error'); b.close()
    print('PASS expiry closes room and rejects late join')
finally: p.terminate(); p.wait()
p=launch(120); peers=[]
try:
    for i in range(20):
        peer=Peer(18766,context); peers.append(peer)
        peer.send({'type':'create','nickname':'user0'} if i==0 else {'type':'join','room':code,'nickname':f'user{i}'})
        code=peer.until('joined')['room']
    # 20 个连接同时在线，验证每次广播的顺序和内容。
    for number in range(40):
        payload=f'{number:03d}'+('中'*600)
        peers[number%20].send({'type':'chat','text':payload})
        for peer in peers: assert peer.until('chat')['text']==payload
    print('PASS 20 concurrent clients, 40 broadcasts, 800 exact deliveries')
finally:
    for peer in peers: peer.close()
    p.terminate(); p.wait()
