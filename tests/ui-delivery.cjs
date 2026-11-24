const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
function page() {
  const errors = [], sockets = [], timers = new Map();
  const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'web/index.html'), 'utf8'), { url: 'https://chat.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.ResizeObserver = class { observe() {} }; w.TextEncoder = TextEncoder;
  w.fetch = async () => ({ ok: true, json: async () => ({}) });
  w.confirm = () => true;
  let timerId = 0;
  w.setTimeout = (fn, delay) => { const id = ++timerId; timers.set(id, {fn, delay}); return id; };
  w.clearTimeout = id => timers.delete(id);
  w.WebSocket = class { static OPEN = 1; constructor() { this.readyState = 1; this.sent = []; sockets.push(this); } send(raw) { if (this.throwSend) throw Error('disconnected'); this.sent.push(JSON.parse(raw)); } };
  w.eval(fs.readFileSync(path.join(root, 'web/app.js'), 'utf8'));
  const get = id => w.document.getElementById(id);
  const receive = data => sockets.at(-1).onmessage({ data: JSON.stringify(data) });
  const join = (nickname = 'alice', room = 'ABC123') => receive({ type: 'joined', nickname, room, name: '测试', history_before: 'cursor', expires: 1800000000 });
  receive({ type: 'auth_mode', required: false }); join();
  return { w, get, receive, join, errors, sockets, timers,
    submit(text) { get('message').value = text; get('message-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); return sockets.at(-1).sent.filter(x => x.type === 'chat').at(-1); },
    rows() { return [...get('messages').querySelectorAll('.chat-message')]; },
    expire() { for (const [id, timer] of [...timers]) if (timer.delay === 15000) { timers.delete(id); timer.fn(); } },
    reconnect() { sockets.at(-1).onclose(); const retry = [...timers].find(([,t]) => t.delay > 0 && t.delay < 15000); timers.delete(retry[0]); retry[1].fn(); receive({type:'auth_mode',required:false}); join(); },
    close() { w.close(); } };
}

test('text remains pending until server echo; ack/history do not duplicate and new draft survives', () => {
  const p = page(); try {
    const request = p.submit('hello');
    assert.match(request.client_id, /^[a-f0-9]{32}$/);
    assert.equal(p.rows().length, 1);
    assert.match(p.rows()[0].textContent, /发送中/);
    p.get('message').value = 'new draft';
    const message = { ...request, nickname:'alice', message_id: 'm1', sent_at: 1700000000 };
    p.receive(message); p.receive({ type:'chat_ack', client_id: request.client_id, message });
    assert.equal(p.rows().length, 1);
    assert.doesNotMatch(p.rows()[0].textContent, /发送中|发送失败/);
    assert.equal(p.get('message').value, 'new draft');
    assert.match(p.rows()[0].querySelector('time').textContent, /^\d{2}:\d{2}$/);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('timeout and correlated rejection retain content; retry reuses ID and never overwrites draft', () => {
  const p = page(); try {
    const request = p.submit('keep me'); p.expire();
    assert.match(p.rows()[0].textContent, /发送失败/);
    p.get('message').value = 'newer';
    p.rows()[0].querySelector('button').click();
    assert.equal(p.sockets.at(-1).sent.at(-1).client_id, request.client_id);
    assert.equal(p.get('message').value, 'newer');
    p.receive({type:'error', client_id:request.client_id, message:'限流，请稍后重试'});
    assert.match(p.rows()[0].textContent, /限流/);
    assert.match(p.rows()[0].textContent, /keep me/);
    assert.equal(p.rows()[0].querySelector('[role="status"]').getAttribute('aria-live'), 'polite');
  } finally { p.close(); }
});

test('disconnect retains pending per identity and replay confirms it without duplication', () => {
  const p = page(); try {
    const request = p.submit('reconnect me'); p.get('message').value = 'draft'; p.reconnect();
    assert.equal(p.rows().length, 1);
    assert.equal(p.get('message').value, 'draft');
    p.receive({...request,nickname:'alice',sent_at:1700000000});
    assert.equal(p.rows().length, 1);
    assert.doesNotMatch(p.rows()[0].textContent,/发送失败|发送中/);
    p.join('bob'); assert.equal(p.rows().length,0);
  } finally { p.close(); }
});

test('socket send exception preserves draft and exposes recoverable failure', () => {
  const p = page(); try {
    p.sockets.at(-1).throwSend = true; p.submit('draft on throw');
    assert.equal(p.get('message').value, 'draft on throw');
    assert.equal(p.rows().length,1);
    assert.match(p.rows()[0].textContent,/发送失败/);
    assert.deepEqual(p.errors,[]);
  } finally { p.close(); }
});

test('history prepend groups chronological dates and leaves legacy timestamps unknown', () => {
  const p = page(); try {
    p.receive({type:'chat', nickname:'bob', text:'today',sent_at:1700136000,message_id:'new'});
    p.receive({type:'chat', nickname:'bob', text:'legacy'});
    p.join();
    p.receive({type:'chat', nickname:'bob', text:'today',sent_at:1700136000,message_id:'new'});
    p.get('older-messages').click();
    p.receive({type:'history',before:'',messages:[{type:'chat',nickname:'bob',text:'old',sent_at:1699963200,message_id:'old'}, {type:'chat',nickname:'bob',text:'same day',sent_at:1700136000,message_id:'same'}]});
    assert.deepEqual(p.rows().map(row => row.querySelector('.message-text').textContent),['old','same day','today']);
    assert.equal(p.get('messages').querySelectorAll('.message-date').length,2);
    p.receive({type:'chat',nickname:'bob',text:'legacy'});
    assert.equal(p.rows().at(-1).querySelector('time'),null);
  } finally { p.close(); }
});


test('ack-only confirms pending and sequence deduplicates legacy history', () => {
  const p = page(); try {
    const request = p.submit('ack only');
    const message = {...request, nickname:'alice', sequence:'42', sent_at:1700000000};
    p.receive({type:'chat_ack',client_id:request.client_id,message});
    assert.equal(p.rows().length,1);
    assert.doesNotMatch(p.rows()[0].textContent,/发送中|发送失败/);
    p.receive({type:'chat',nickname:'bob',text:'legacy id',sequence:'43'});
    p.get('older-messages').click();
    p.receive({type:'history',before:'',messages:[{type:'chat',nickname:'bob',text:'legacy id',sequence:'43'}]});
    assert.equal(p.rows().length,2);
  } finally { p.close(); }
});

test('explicit leave clears pending, while another sender cannot confirm own client ID', () => {
  const p = page(); try {
    const request = p.submit('mine');
    p.receive({...request,nickname:'bob',sent_at:1700000000});
    assert.equal(p.rows().length,2);
    assert.equal(p.rows().filter(row => row.dataset.delivery === 'sending').length,1);
    p.get('leave').click(); p.receive({type:'closed',reason:'left'}); p.join();
    assert.equal(p.rows().length,0);
  } finally { p.close(); }
});


test('reconnect replay keeps confirmed optimistic messages in chronological order', () => {
 const p = page(); try {
   const request = p.submit('mine after old'); p.reconnect();
   p.receive({type:'chat',nickname:'bob',text:'before',sent_at:1699999900,sequence:'1'});
   p.receive({...request,nickname:'alice',sent_at:1700000000,sequence:'2'});
   p.receive({type:'chat',nickname:'bob',text:'after',sent_at:1700000100,sequence:'3'});
   assert.deepEqual(p.rows().map(row => row.querySelector('.message-text').textContent),['before','mine after old','after']);
 } finally { p.close(); }
});


test('own server-confirmed messages show confirmation without implying a read receipt', () => {
  const p = page(); try {
    const request = p.submit('confirmed');
    p.receive({...request,nickname:'alice',sent_at:1700000000,sequence:'50'});
    let status = p.rows()[0].querySelector('.message-delivery');
    assert.equal(status.textContent,'已确认');
    assert.match(status.title,/服务器已接收/);
    assert.match(status.title,/不代表.*已读/);
    p.join();
    p.receive({...request,nickname:'alice',sent_at:1700000000,sequence:'50'});
    status = p.rows()[0].querySelector('.message-delivery');
    assert.equal(status.textContent,'已确认');
    p.receive({type:'chat',text:'friend',nickname:'bob',client_id:'b'.repeat(32),sent_at:1700000001});
    assert.equal(p.rows()[1].querySelector('.message-delivery'),null);
  } finally { p.close(); }
});
