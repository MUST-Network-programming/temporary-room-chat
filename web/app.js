'use strict';
// 浏览器只持有当前标签页的会话；令牌不能当成昵称，恢复身份由服务器验证。
const $ = id => document.getElementById(id);
const colorScheme = matchMedia('(prefers-color-scheme: dark)');
const themeControl = $('theme');
try {
  const saved = localStorage.getItem('temporary-chat-theme');
  if (saved === 'light' || saved === 'dark') themeControl.value = saved;
} catch (_) {}
function applyTheme() {
  const dark = themeControl.value === 'dark' || (themeControl.value === 'system' && colorScheme.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#161917' : '#f7f8f7';
}
themeControl.addEventListener('change', () => {
  applyTheme();
  try { localStorage.setItem('temporary-chat-theme', themeControl.value); } catch (_) {}
});
colorScheme.addEventListener('change', applyTheme);
applyTheme();

const stickers = {wave:'👋', ok:'👌', party:'🎉', heart:'💚'};
const stickerNames = {wave:'打招呼', ok:'收到', party:'庆祝', heart:'喜欢'};
const recentKey = 'temporary-chat-recent';
let recent = [];
try {
  const saved = JSON.parse(localStorage.getItem(recentKey));
  if (Array.isArray(saved)) recent = saved.filter(item => item && /^[A-Z0-9]{6}$/.test(item.room) && typeof item.name === 'string').slice(0, 5);
} catch (_) {}
function renderRecent() {
  const select = $('recent');
  select.replaceChildren(new Option('选择最近房间', ''));
  for (const item of recent) select.add(new Option(item.name + ' · ' + item.room, item.room));
  $('recent-field').hidden = !recent.length;
  $('room-recent').hidden = !recent.length;
  $('room-recent-list').replaceChildren(...recent.map(item => {
    const entry = document.createElement('li');
    entry.textContent = item.name + ' · ' + item.room;
    if (item.room === session?.room) entry.setAttribute('aria-current', 'true');
    return entry;
  }));
}
function setRoomName(name) {
  $('room-name').textContent = name;
  recent = [{room:session.room, name}, ...recent.filter(item => item.room !== session.room)].slice(0, 5);
  try { localStorage.setItem(recentKey, JSON.stringify(recent)); } catch (_) {}
  renderRecent();
}
const loginKey = 'temporary-chat-account';
let account = null, loginToken = null, authRequired = null, authPending = false;
let resumingLogin = false, registering = false;
try { loginToken = sessionStorage.getItem(loginKey); } catch (_) {}
function saveLogin(token) {
  loginToken = token;
  try {
    if (token) sessionStorage.setItem(loginKey, token);
    else sessionStorage.removeItem(loginKey);
  } catch (_) {}
}
function showLobby() {
  const allowed = authRequired === false || Boolean(account);
  $('account-panel').hidden = authRequired !== true || allowed;
  $('lobby').hidden = !allowed || !$('room-view').hidden;
  $('nickname-field').hidden = authRequired !== false;
  $('logout').hidden = $('signed-in').hidden = !account;
  $('signed-in').textContent = account ? '当前账号 ' + account : '';
}
function restoreRoom() {
  if (!session) return;
  restoring = true; pending = true;
  send(authRequired ? {type:'join', room:session.room} : {type:'join', ...session});
}
const storageKey = 'temporary-chat-session';
let socket, retryTimer, heartbeatTimer, attempts = 0, lastReceived = 0;
let session = null, joined = false, pending = false, restoring = false;
try { session = JSON.parse(sessionStorage.getItem(storageKey)); } catch (_) { /* 禁止存储时仍可正常聊天。 */ }
if (!session || typeof session.room !== 'string' || typeof session.nickname !== 'string') session = null;
const bytes = value => new TextEncoder().encode(value).length;
function persist() {
  try { session ? sessionStorage.setItem(storageKey, JSON.stringify(session)) : sessionStorage.removeItem(storageKey); } catch (_) { /* 隐私模式下不保证刷新恢复。 */ }
}
function notice(text = '') {
  const target = !$('room-view').hidden ? $('room-notice') :
    !$('account-panel').hidden ? $('account-notice') : $('notice');
  for (const id of ['notice', 'account-notice', 'room-notice']) {
    const element = $(id);
    element.textContent = element === target ? text : '';
    element.hidden = element !== target || !text;
  }
}
const compactRoom = matchMedia('(max-width: 680px)');
function showRoomInfo(expanded) {
  $('room-info').setAttribute('aria-expanded', String(expanded));
  $('room-sidebar').classList.toggle('expanded', expanded);
}
$('room-info').addEventListener('click', () => {
  const expanded = $('room-info').getAttribute('aria-expanded') === 'true';
  showRoomInfo(!expanded);
});
function resizeDraft() {
  const input = $('message');
  // 先清掉旧高度，删除文字或发送后才能缩回一行。
  input.style.height = 'auto';
  input.style.height = (input.scrollHeight + 2) + 'px';
}
function draftChanged() {
  resizeDraft();
  controls();
}
function controls() {
  const online = socket && socket.readyState === WebSocket.OPEN;
  const allowed = authRequired === false || Boolean(account);
  $('account-submit').disabled = !online || authPending;
  $('create').disabled = $('join').disabled = !online || !allowed || pending;
  $('send').disabled = !online || !joined || !$('message').value.trim();
  $('rename').disabled = !online || !joined;
  $('leave').disabled = !online || !joined;
  $('close-room').disabled = !online || !joined;
}
function connection(text, online = false) {
  $('status').textContent = text;
  $('status').classList.toggle('connected', online);
  controls();
}
function send(data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(data));
  return true;
}
function resetRoom(message) {
  session = null; joined = false; pending = false; restoring = false; persist();
  $('room-view').hidden = true; showLobby();
  showRoomInfo(false); $('room-settings').open = false;
  showExpressions(false);
  $('close-room').hidden = true; $('members').replaceChildren();
  $('member-count').textContent = '0';
  notice(message); controls();
}
const messageList = $('messages');
const latestButton = $('latest');
let followingLatest = true;

function scrollToLatest() {
  followingLatest = true;
  messageList.scrollTop = messageList.scrollHeight;
  latestButton.hidden = true;
}
messageList.addEventListener('scroll', () => {
  followingLatest = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight <= 24;
  latestButton.hidden = followingLatest;
});
latestButton.addEventListener('click', () => {
  scrollToLatest();
  messageList.focus({preventScroll:true});
});
new ResizeObserver(() => {
  if (followingLatest) scrollToLatest();
}).observe(messageList);

function appendMessage(node) {
  // 阅读旧消息时保留位置，清理最早的 DOM 节点也不改变正在读的内容。
  messageList.append(node);
  while (messageList.children.length > 500) {
    const previousHeight = messageList.scrollHeight;
    const previousTop = messageList.scrollTop;
    messageList.firstElementChild.remove();
    if (!followingLatest) messageList.scrollTop = previousTop - (previousHeight - messageList.scrollHeight);
  }
  if (followingLatest) scrollToLatest();
  else latestButton.hidden = false;
}
function systemMessage(text) {
  const p = document.createElement('p');
  p.className = 'system-message';
  p.textContent = text;
  appendMessage(p);
}
function onMessage(event) {
  let data;
  try { data = JSON.parse(event.data); } catch (_) { notice('收到无法识别的消息。'); return; }
  lastReceived = Date.now();
  switch (data.type) {
    case 'auth_mode':
      authRequired = data.required;
      if (authRequired && loginToken) {
        resumingLogin = true; authPending = true;
        send({type:'authenticate', token:loginToken});
      } else if (!authRequired) restoreRoom();
      if (!joined) showLobby();
      controls(); break;
    case 'authenticated':
      const shouldRestore = resumingLogin && session?.nickname === data.name;
      $('invite-code').value = '';
      account = data.name; authPending = resumingLogin = false;
      saveLogin(data.token);
      if (shouldRestore) restoreRoom();
      else if (session) { session = null; persist(); }
      showLobby(); notice(); controls(); break;
    case 'joined': {
      const wasRestoring = restoring;
      session = {room:data.room, nickname:data.nickname, token:data.token};
      joined = true; pending = false; restoring = false; attempts = 0; persist();
      $('lobby').hidden = true; $('room-view').hidden = false;
      $('room-id').textContent = data.room; $('identity').textContent = `${data.nickname}${data.owner ? ' · 房主' : ''}`;
      $('close-room').hidden = !data.owner;
      $('expiry').textContent = `房间到期：${new Date(data.expires * 1000).toLocaleString('zh-CN')}`;
      $('rename').hidden = !data.owner;
      setRoomName(data.name || '同行房间');
      followingLatest = true;
      latestButton.hidden = true;
      messageList.replaceChildren();
      systemMessage(wasRestoring ? '已恢复连接，以下是房间保留的最近消息。' : '已加入房间。');
      notice(); draftChanged();
      if (!compactRoom.matches) $('message').focus();
      break;
    }
    case 'members':
      $('members').replaceChildren();
      if (Array.isArray(data.members)) {
        for (const name of data.members) { const li = document.createElement('li'); li.textContent = name; $('members').append(li); }
        $('member-count').textContent = String(data.members.length);
      }
      break;
    case 'renamed': if (session) setRoomName(data.name); break;
    case 'sticker':
    case 'chat': {
      const article = document.createElement('article');
      article.className = `chat-message${session && data.nickname === session.nickname ? ' own' : ''}`;
      const name = document.createElement('p'); name.className = 'message-name'; name.textContent = data.nickname;
      const text = document.createElement('p'); text.className = 'message-text'; text.textContent = data.type === 'sticker' ? stickers[data.id] : data.text;
      if (data.type === 'sticker') {
        text.classList.add('sticker-message');
        text.setAttribute('aria-label', stickerNames[data.id] || '贴图');
      }
      article.append(name, text); appendMessage(article); break;
    }
    case 'closed':
      resetRoom(data.reason === 'left' ? '已离开房间。' :
        data.reason === 'expired' ? '房间已到期。' : '房间已关闭。');
      break;
    case 'error':
      // 恢复失败不循环提交无效令牌；让用户明确选择新的房间。
      if (data.code === 'login_expired' || data.code === 'login_required') {
        account = null; authPending = resumingLogin = false;
        saveLogin(null); resetRoom(data.message);
      } else if (authPending) {
        authPending = resumingLogin = false; notice(data.message); controls();
      } else if (data.code === 'session_replaced') resetRoom('此会话已在另一连接恢复，请重新加入。');
      else if (restoring) resetRoom(`无法恢复房间：${data.message}。请重新加入。`);
      else { pending = false; notice(data.message || '操作失败，请重试。'); controls(); }
      break;
    case 'pong': break;
  }
}
function connect() {
  clearTimeout(retryTimer);
  connection('正在连接…');
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket.onopen = () => {
    lastReceived = Date.now(); connection('已连接', true);
    send({type:'auth_mode'});
    if (!session) attempts = 0;
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastReceived > 45000) { socket.close(); return; }
      send({type:'ping'});
    }, 15000);
  };
  socket.onmessage = onMessage;
  socket.onerror = () => { /* close 事件统一安排重连，避免重复计时器。 */ };
  socket.onclose = () => {
    clearInterval(heartbeatTimer); joined = false; pending = false;
    account = null; authPending = resumingLogin = false;
    // 1、2、4…秒指数退避，加入随机抖动，最终等待不超过 15 秒。
    const base = Math.min(15000, 1000 * 2 ** Math.min(attempts++, 5));
    const delay = Math.min(15000, base * (.8 + Math.random() * .4));
    connection(`连接中断，${Math.ceil(delay / 1000)} 秒后重试`);
    retryTimer = setTimeout(connect, delay);
  };
}
function enter(type) {
  const nickname = $('nickname').value.trim();
  const room = $('room-code').value.trim().toUpperCase();
  if (!authRequired && (!nickname || bytes(nickname) > 48)) { notice('请输入昵称，长度不超过 48 个 UTF-8 字节（约 16 个汉字）。'); $('nickname').focus(); return; }
  if (type === 'join' && !/^[A-Z0-9]{6}$/.test(room)) { notice('请填写完整的 6 位房间加入码。'); $('room-code').focus(); return; }
  notice(); pending = true;
  if (!send({type, ...(authRequired ? {} : {nickname}), ...(type === 'join' ? {room} : {})})) { pending = false; notice('连接尚未恢复，请稍后重试。'); }
  controls();
}
$('account-toggle').addEventListener('click', () => {
  registering = !registering;
  $('account-title').textContent = registering ? '注册账号' : '登录聊天室';
  $('account-description').textContent = registering ? '用一次性注册码创建同行账号。' : '使用你的同行账号继续。';
  $('account-submit').textContent = registering ? '注册并登录' : '登录';
  $('account-toggle').textContent = registering ? '已有账号，去登录' : '注册账号';
  $('invite-field').hidden = !registering;
  $('invite-code').required = registering;
  $('account-password').autocomplete = registering ? 'new-password' : 'current-password';
  notice();
});
$('account-form').addEventListener('submit', event => {
  event.preventDefault();
  if (location.protocol !== 'https:') { notice('请通过 HTTPS 登录。'); return; }
  const password = $('account-password').value;
  const request = {type:registering ? 'register' : 'login', name:$('account-name').value.trim(), password};
  if (registering) request.invite = $('invite-code').value.trim();
  authPending = send(request);
  if (authPending) $('account-password').value = '';
  controls();
});
$('logout').addEventListener('click', () => {
  if (send({type:'logout'})) {
    account = null; saveLogin(null); resetRoom('已退出登录。');
  }
});
$('entry-form').addEventListener('submit', e => { e.preventDefault(); enter('join'); });
$('create').addEventListener('click', () => enter('create'));
$('message-form').addEventListener('submit', e => {
  e.preventDefault(); const text = $('message').value.trim();
  if (!text) return;
  if (bytes(text) > 2048) { notice('消息太长，请控制在 2048 个 UTF-8 字节以内（约 682 个汉字）。'); return; }
  if (joined && send({type:'chat', text})) {
    scrollToLatest();
    $('message').value = '';
    draftChanged();
    showExpressions(false);
    notice();
    $('message').focus({preventScroll:true});
  }
});
$('message').addEventListener('input', draftChanged);
window.addEventListener('resize', resizeDraft);
$('message').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$('send').disabled) $('message-form').requestSubmit();
  }
});
$('leave').addEventListener('click', () => {
  if (!$('close-room').hidden && !confirm('你是房主。离开会关闭房间，所有人都将退出。确认离开？')) return;
  if (send({type:'leave'})) resetRoom('已离开房间。');
});
$('close-room').addEventListener('click', () => { if (confirm('关闭后所有成员都会退出，加入码立即失效。确认关闭？')) send({type:'close'}); });
$('copy-code').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('room-id').textContent); notice('加入码已复制。'); }
  catch (_) { notice(`请手动复制加入码：${$('room-id').textContent}`); }
});
$('transport').textContent = location.protocol === 'https:' ? '当前连接：HTTPS / WSS' : '当前连接：HTTP / WS（未加密）';
renderRecent();
$('recent').addEventListener('change', event => {
  if (event.target.value) $('room-code').value = event.target.value;
});
$('rename').addEventListener('click', () => {
  const name = prompt('输入新的群名', $('room-name').textContent)?.trim();
  if (name === undefined) return;
  if (!name || bytes(name) > 64) { notice('群名需要 1–64 个 UTF-8 字节。'); return; }
  send({type:'rename', name});
});
function showExpressions(open) {
  $('expression-options').hidden = !open;
  $('expression-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('expression-options').scrollTop = 0;
}
$('expression-toggle').addEventListener('click', () => {
  showExpressions($('expression-options').hidden);
});
$('message-form').addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('expression-options').hidden) {
    showExpressions(false);
    $('expression-toggle').focus({preventScroll:true});
  }
});
function expressionButton(group, label, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', onClick);
  $(group).append(button);
}
const emojiChoices = [
  '😀', '😊', '😂', '🤣', '😍', '🥳', '😎', '🤔',
  '😅', '😭', '😮', '😴', '👍', '👌', '🙌', '👏',
  '🙏', '👋', '❤️', '💚', '💙', '🔥', '✨', '🎉',
  '✅', '☕', '🍕', '🐱', '🐶', '🌈'
];
for (const emoji of emojiChoices)
  expressionButton('emoji-options', emoji, '插入 ' + emoji, () => {
    const input = $('message');
    // 表情加在光标处，保留发送前的草稿与输入位置。
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (bytes(input.value.slice(0, start) + emoji + input.value.slice(end)) > 2048) {
      notice('消息已达到 2048 个 UTF-8 字节。');
      return;
    }
    input.setRangeText(emoji, start, end, 'end');
    draftChanged();
    if (!compactRoom.matches) input.focus({preventScroll:true});
  });
for (const [id, emoji] of Object.entries(stickers))
  expressionButton('sticker-options', emoji, '发送贴图 ' + stickerNames[id], () => {
    if (joined && send({type:'sticker', id})) {
      scrollToLatest();
      showExpressions(false);
      $('expression-toggle').focus({preventScroll:true});
    }
  });
connect();
