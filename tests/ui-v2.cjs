// DOM integration only. No browser, screenshots or synthetic inbox receipts.
const {JSDOM,VirtualConsole}=require('jsdom');
const WS=require('ws');const fs=require('fs');const assert=require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'..');const errors=[];const sockets=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<160;i++){if(fn())return;await pause(30);}throw Error('timeout '+label);}
function client(){const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
 const d=new JSDOM(fs.readFileSync(root+'/web/index.html','utf8'),{url:'http://127.0.0.1:8090',runScripts:'outside-only',virtualConsole:vc,pretendToBeVisual:true});
 const w=d.window;w.matchMedia=()=>({matches:false,addEventListener(){}});w.ResizeObserver=class{observe(){}};w.TextEncoder=TextEncoder;
 w.WebSocket=class extends WS{constructor(...args){super(...args);sockets.push(this);}};
 w.fetch=(url,options)=>fetch(new URL(url,w.location).href,options);w.confirm=()=>true;
 w.eval(fs.readFileSync(root+'/web/app.js','utf8'));return d;
}
const get=(d,id)=>d.window.document.getElementById(id);const click=(d,id)=>get(d,id).click();
function submit(d,id){get(d,id).dispatchEvent(new d.window.Event('submit',{bubbles:true,cancelable:true}));}
function send(d,text){get(d,'message').value=text;get(d,'message').dispatchEvent(new d.window.Event('input'));submit(d,'message-form');}
(async()=>{const a=client(),b=client();try{
 await until(()=>!get(a,'lobby').hidden && !get(b,'lobby').hidden,'lobbies');
 get(a,'nickname').value='DOM房主';click(a,'create');await until(()=>!get(a,'room-view').hidden,'create');
 const code=get(a,'room-id').textContent;get(b,'nickname').value='DOM游客';get(b,'room-code').value=code;submit(b,'entry-form');await until(()=>get(a,'member-count').textContent==='2','join');
 click(a,'rename');get(a,'rename-input').value='行程功能验收';submit(a,'rename-form');await until(()=>get(b,'room-name').textContent==='行程功能验收','rename');
 send(b,'<img src=x onerror=alert(1)> 你好');await until(()=>get(a,'messages').textContent.includes('<img'),'escaped chat');assert.equal(get(a,'messages').querySelectorAll('img').length,0);
 const tomorrow=new Date(Date.now()+86400000).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
 send(b,`日期：${tomorrow}；集合时间：08:30；集合地点：酒店大堂；目的地：城市博物馆`);await until(()=>get(a,'messages').textContent.includes('城市博物馆'),'discussion');
 click(b,'itinerary-toggle');await until(()=>get(b,'extraction-mode').textContent.includes('非 AI'),'label');assert.equal(get(b,'owner-tools').hidden,true);
 get(b,'subscriber-email').value='dom-traveler@example.test';submit(b,'subscription-form');await until(()=>get(b,'subscription-state').textContent.includes('已订阅'),'subscribe');
 send(a,'@行程助手 生成行程');await until(()=>!get(a,'itinerary-form').hidden,'@ generated draft');
 assert.equal(get(a,'trip-meeting_place').value,'酒店大堂');assert.equal(get(a,'trip-transport').value,'待确认');
 get(a,'trip-meeting_place').value='酒店一楼大堂';submit(a,'itinerary-form');await until(()=>get(a,'pinned-itinerary').textContent.includes('酒店一楼大堂'),'confirm pinned');
 await until(()=>get(b,'messages').textContent.includes('房主已确认'),'publish');
 await until(()=>get(a,'messages').querySelector('.is-current-pin .itinerary-version-label')?.textContent.includes('当前置顶'),'v1 current pin label');
 assert.match(get(a,'messages').querySelector('.itinerary-announcement .message-text').textContent,/已确认行程 v1|置顶行程 · v1/);
 click(b,'itinerary-close');click(b,'pinned-itinerary');await until(()=>!get(b,'itinerary-form').hidden,'member read');assert.equal(get(b,'trip-meeting_time').readOnly,true);
 get(a,'trip-meeting_time').value='08:40';click(a,'save-itinerary');await until(()=>get(a,'itinerary-version').textContent.includes('v2'),'new draft');submit(a,'itinerary-form');await until(()=>get(a,'pinned-itinerary').textContent.includes('08:40'),'new confirm');
 await until(()=>get(a,'messages').querySelector('.is-historical .itinerary-version-label')?.textContent.includes('历史版本') && get(a,'messages').querySelector('.is-current-pin .itinerary-version-label')?.textContent.includes('v2'),'v1 historical, v2 current');
 assert.equal(get(a,'messages').querySelectorAll('.itinerary-announcement').length,2);
 assert.match(get(a,'messages').querySelector('.is-historical .message-text').textContent,/已确认行程 v1|置顶行程 · v1/);
 click(b,'unsubscribe');await until(()=>get(b,'subscription-state').textContent.startsWith('未订阅'),'unsubscribe');
 get(a,'theme').value='dark';get(a,'theme').dispatchEvent(new a.window.Event('change'));assert.equal(a.window.document.documentElement.dataset.theme,'dark');
 assert.equal(get(a,'theme-button').textContent,'深色');
 click(a,'theme-button');assert.equal(get(a,'theme-button').getAttribute('aria-expanded'),'true');
 const lightOpt=a.window.document.getElementById('theme-opt-light'); lightOpt.click();
 assert.equal(a.window.document.documentElement.dataset.theme,'light');
 assert.equal(get(a,'theme-button').textContent,'浅色');
 assert.equal(get(a,'theme-menu').hidden,true);
 get(a,'theme').value='dark';get(a,'theme').dispatchEvent(new a.window.Event('change'));assert.equal(a.window.document.documentElement.dataset.theme,'dark');
 click(a,'close-room');await until(()=>get(b,'room-view').hidden,'owner close');
 assert.deepEqual(errors,[]);console.log('PASS DOM real WS chat, escaping, rename, @→draft, owner edit/confirm, read-only member, subscriptions, v2 pin labels (historical vs current), accessible theme picker, dark theme, close; no browser/visual QA performed');
 }finally{for(const s of sockets)s.close();a.window.close();b.window.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
