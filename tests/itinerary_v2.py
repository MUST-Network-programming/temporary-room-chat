"""Real local C chat + HTTP workflow + one-minute SMTP MIME delivery (no browser)."""
import asyncio, json, os, secrets, sqlite3, subprocess, sys, tempfile, time, unittest
from datetime import datetime, timedelta
from email import policy
from email.parser import BytesParser
from pathlib import Path
from aiohttp import ClientSession, ClientTimeout
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from assistant.service import local_extract, validate, sanitize_extraction, FIELDS, TZ, PENDING

class ExtractionTests(unittest.TestCase):
    def test_missing(self):
        d=local_extract([{'type':'chat','text':'明天出去玩吧','nickname':'成员'}])
        self.assertTrue(all(d[k]==PENDING for k in FIELDS))
    def test_conflict(self):
        d=local_extract([{'type':'chat','text':'集合时间：08:30；集合时间：09:00；日期：明天；车辆座位数：45'}],datetime(2026,11,22,tzinfo=TZ))
        self.assertEqual(d['meeting_time'],PENDING); self.assertTrue(d['conflicts'])
        self.assertEqual(d['date'],'2026-11-23'); self.assertEqual(d['seats'],'45')
    def test_invalid_extraction_pending(self):
        d=sanitize_extraction({'date':'2026-02-30','meeting_time':'25:30','seats':'0'})
        self.assertEqual(d['date'],PENDING);self.assertEqual(d['meeting_time'],PENDING);self.assertEqual(d['seats'],PENDING)
    def test_date_timezone(self):
        with self.assertRaises(ValueError): validate({'date':'2026-02-30'})
        with self.assertRaises(ValueError): validate({'meeting_time':'8:30+00:00'})
        self.assertEqual(TZ.utcoffset(datetime.now()).total_seconds(),28800)
    def test_confirm_missing(self):
        with self.assertRaises(ValueError): validate({},confirming=True)

async def receive(ws,kind):
    for _ in range(120):
        d=await asyncio.wait_for(ws.receive_json(),5)
        if d['type']==kind: return d
    raise AssertionError(kind)

async def integration():
    with tempfile.TemporaryDirectory(prefix='chat-itinerary-v2-') as temp:
        state=Path(temp); env={**os.environ,'ASSISTANT_STATE':temp,'ASSISTANT_SHARED_SECRET':secrets.token_hex(32),'CHAT_INTERNAL_WS':'ws://127.0.0.1:18081/ws','AI_MODE':'rules','ALLOW_EXTERNAL_EMAIL':'0','SMTP_HOST':'127.0.0.1','SMTP_PORT':'11025','PUBLIC_BASE_URL':'https://43.129.182.26'}
        processes=[]; handles=[]
        def start(args,name):
            f=open(state/(name+'.log'),'a'); handles.append(f)
            p=subprocess.Popen(args,cwd=ROOT,env=env,stdout=f,stderr=subprocess.STDOUT);processes.append(p);return p
        def service(role,port=None): return [sys.executable,'assistant/service.py',role]+(['--port',str(port)] if port else [])
        start([str(ROOT/'build/chat_server'),'--anonymous-loopback','--port','18081','--ttl','86400'],'c')
        start(service('serve',18090),'api'); start(service('capture',18025),'capture')
        worker=start(service('worker'),'worker')
        try:
            async with ClientSession(timeout=ClientTimeout(total=20)) as s:
                for _ in range(100):
                    try:
                        async with s.get('http://127.0.0.1:18090/') as r:
                            if r.status==200: break
                    except OSError: pass
                    await asyncio.sleep(.1)
                a=await s.ws_connect('http://127.0.0.1:18090/ws'); b=await s.ws_connect('http://127.0.0.1:18090/ws')
                await a.send_json({'type':'create','nickname':'测试房主'}); aj=await receive(a,'joined')
                await b.send_json({'type':'join','room':aj['room'],'nickname':'测试游客'}); bj=await receive(b,'joined')
                # Two days ahead keeps the previous-evening 20:00 reminder in the future.
                # The scheduler omits past standard times, so a next-day meeting after 20:00
                # Asia/Shanghai would correctly create only the remaining jobs.
                at=(datetime.now(TZ)+timedelta(days=2)).date().isoformat()
                discussion=f'日期：{at}；集合时间：08:30；集合地点：酒店大堂；目的地：城市博物馆；交通：旅游巴士；停留时长：90分钟；游览结束集合时间：11:20；再次集合地点：景点东门停车区；车辆座位数：45；注意事项：携带身份证和饮用水；行程安排：08:45乘车，09:30游览'
                await b.send_json({'type':'chat','text':discussion}); assert (await receive(a,'chat'))['text']==discussion
                await a.send_json({'type':'chat','text':'@行程助手 生成明日行程草稿'}); await receive(a,'chat')
                async def api(action,token=aj['assistant_token'],body=None,status=200):
                    async with s.request('POST' if body is not None else 'GET','http://127.0.0.1:18090/api/itinerary/'+action,headers={'Authorization':'Bearer '+token},json=body) as r:
                        data=await r.json(); assert r.status==status,(action,r.status,data);return data
                await api('state',token='a'*64,status=403)
                for act in ('extract','save','confirm'):
                    await api(act,token=bj['assistant_token'],body={},status=403)
                await api('subscribe',token=bj['assistant_token'],body={'active':True,'email':'tourist@example.test'})
                await api('subscribe',token=bj['assistant_token'],body={'active':True,'email':'nobody@real-domain.com'},status=400)
                draft=await api('extract',body={}); assert '非 AI' in draft['mode']; assert draft['data']['meeting_place']=='酒店大堂'
                draft['data']['meeting_place']='酒店一楼大堂'
                await api('save',body={'version':draft['version'],'data':draft['data']})
                await api('confirm',body={'version':draft['version'],'data':draft['data'],'demo':True})
                published=await receive(b,'chat')
                while published['nickname']!='行程助手': published=await receive(b,'chat')
                assert '酒店一楼大堂' in published['text'] and '房主已确认' in published['text']
                await api('confirm',body={'version':draft['version'],'data':draft['data'],'demo':True},status=409)
                before=await api('state'); assert len(before['jobs'])==3
                # New confirmed version cancels old jobs and schedules replacement jobs.
                draft['data']['meeting_time']='08:40'
                saved=await api('save',body={'version':draft['version'],'data':draft['data']})
                await api('confirm',body={'version':saved['version'],'data':draft['data'],'demo':True})
                state1=await api('state')
                assert all(j['status']=='cancelled' for j in state1['jobs'] if j['version']==1)
                assert len([j for j in state1['jobs'] if j['version']==2 and j['status']=='pending'])==3
                member_state=await api('state',token=bj['assistant_token']); assert member_state['draft'] is None
                # Restart both API and worker before the due time: persisted jobs remain scheduled.
                worker.terminate(); worker.wait(timeout=5); worker=start(service('worker'),'worker-restart')
                processes[1].terminate();processes[1].wait(timeout=5);start(service('serve',18090),'api-restart')
                for _ in range(50):
                    try:
                        async with s.get('http://127.0.0.1:18090/') as r:
                            if r.status==200: break
                    except OSError: pass
                    await asyncio.sleep(.1)
                a=await s.ws_connect('http://127.0.0.1:18090/ws');b=await s.ws_connect('http://127.0.0.1:18090/ws')
                await a.send_json({'type':'join','room':aj['room'],'nickname':'测试房主','token':aj['token']});await receive(a,'joined')
                await b.send_json({'type':'join','room':aj['room'],'nickname':'测试游客','token':bj['token']});await receive(b,'joined')

                async def heartbeats():
                    while True:
                        await asyncio.sleep(15)
                        await a.send_json({'type':'ping'});await b.send_json({'type':'ping'})
                heartbeat=asyncio.create_task(heartbeats())
                print('PASS live chat → @ invocation + authenticated extraction → owner edit/confirm → v2 cancels v1; nonowner denied; persistent restart',flush=True)
                start_wait=time.monotonic()
                deadline=time.monotonic()+75
                while time.monotonic()<deadline:
                    await asyncio.sleep(2)
                    with sqlite3.connect(state/'assistant.sqlite3') as c:
                        count=c.execute("SELECT count(*) FROM jobs WHERE status='sent'").fetchone()[0]
                    if count: break
                else: raise AssertionError('one-minute SMTP job did not send')
                files=list((state/'inbox').glob('*.eml')); assert len(files)==1,len(files)
                msg=BytesParser(policy=policy.default).parsebytes(files[0].read_bytes())
                assert msg['To']=='tourist@example.test' and '08:40' in str(msg['Subject'])
                assert '酒店一楼大堂' in msg.get_body(preferencelist=('plain',)).get_content()
                assert 'https://43.129.182.26' in msg.get_body(preferencelist=('plain',)).get_content()
                if os.environ.get('ITINERARY_TEST_ARTIFACTS'):
                    out=Path(os.environ['ITINERARY_TEST_ARTIFACTS']);out.mkdir(parents=True,exist_ok=True)
                    (out/'actual-local-smtp-v2.eml').write_bytes(files[0].read_bytes())
                after=await api('state'); assert len(after['logs'])==1 and after['logs'][0]['status']=='sent'
                # Simulate an interrupted persisted sending intent; restart must mark uncertain, never retry.
                worker.terminate();worker.wait(timeout=5)
                with sqlite3.connect(state/'assistant.sqlite3') as c:
                    c.execute("UPDATE jobs SET status='sending' WHERE id=(SELECT id FROM jobs WHERE status='pending' AND version=2 LIMIT 1)");c.commit()
                worker=start(service('worker'),'worker-restart-after-send')
                await asyncio.sleep(2)
                assert len(list((state/'inbox').glob('*.eml')))==1
                recovery=await api('state'); assert any(j['status']=='uncertain' for j in recovery['jobs'])
                await api('subscribe',token=bj['assistant_token'],body={'active':False})
                final=await api('state'); assert not any(j['status']=='pending' for j in final['jobs'])
                # Member leaves; token is revoked in C and can no longer read or subscribe.
                heartbeat.cancel()
                await b.send_json({'type':'leave'});await receive(b,'closed')
                await api('state',token=bj['assistant_token'],status=403)
                await a.close();await b.close()
                print(f'PASS actual one-minute SMTP delivery ({time.monotonic()-start_wait:.1f}s waited), parsed MIME, sent log, restart dedup, unsubscribe cancellation, left-member rejection',flush=True)
        finally:
            for p in processes:
                if p.poll() is None: p.terminate()
            for p in processes:
                try: p.wait(timeout=5)
                except subprocess.TimeoutExpired: p.kill();p.wait()
            for h in handles: h.close()
            for p in state.glob('*.log'):
                text=p.read_text()
                if 'Traceback' in text: print(p.name,text)

if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(ExtractionTests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful(): sys.exit(1)
    asyncio.run(integration())
