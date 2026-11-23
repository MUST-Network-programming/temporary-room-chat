"use strict";
const iconPaths = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/><path d="M8 10h8M8 14h5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  users:
    '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-2-4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.1"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  smile:
    '<circle cx="12" cy="12" r="9"/><path d="M8 14a4 4 0 0 0 8 0M8 8.5h.01M16 8.5h.01"/>',
  send: '<path d="m21 3-7 18-4-7-7-4 18-7ZM10 14 21 3"/>',
};
for (const element of document.querySelectorAll("[data-icon]")) {
  const path = iconPaths[element.dataset.icon];
  if (path)
    element.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      path +
      "</svg>";
}

// 浏览器只持有当前标签页的会话；令牌不能当成昵称，恢复身份由服务器验证。
const $ = (id) => document.getElementById(id);
const colorScheme = matchMedia("(prefers-color-scheme: dark)");
const themeControl = $("theme");
try {
  const saved = localStorage.getItem("temporary-chat-theme");
  if (saved === "light" || saved === "dark") themeControl.value = saved;
} catch (_) {}
function applyTheme() {
  const dark =
    themeControl.value === "dark" ||
    (themeControl.value === "system" && colorScheme.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]').content = dark
    ? "#171717"
    : "#ffffff";
}
themeControl.addEventListener("change", () => {
  applyTheme();
  syncThemePicker();
  try {
    localStorage.setItem("temporary-chat-theme", themeControl.value);
  } catch (_) {}
});
colorScheme.addEventListener("change", applyTheme);
const themeButton = $("theme-button");
const themeMenu = $("theme-menu");
const themeOptions = [...themeMenu.querySelectorAll('[role="option"]')];
const themeLabels = { system: "跟随系统", light: "浅色", dark: "深色" };
function syncThemePicker() {
  const value = themeControl.value;
  themeButton.textContent = themeLabels[value] || themeLabels.system;
  for (const option of themeOptions) {
    option.setAttribute("aria-selected", String(option.dataset.value === value));
  }
}
function closeThemeMenu(returnFocus = false) {
  themeMenu.hidden = true;
  themeButton.setAttribute("aria-expanded", "false");
  if (returnFocus) themeButton.focus();
}
function openThemeMenu() {
  themeMenu.hidden = false;
  themeButton.setAttribute("aria-expanded", "true");
  const selected =
    themeOptions.find((option) => option.getAttribute("aria-selected") === "true") ||
    themeOptions[0];
  selected.focus();
}
function chooseTheme(value) {
  if (!themeLabels[value] || themeControl.value === value) {
    closeThemeMenu(true);
    return;
  }
  themeControl.value = value;
  themeControl.dispatchEvent(new Event("change"));
  closeThemeMenu(true);
}
themeButton.addEventListener("click", () => {
  if (themeMenu.hidden) openThemeMenu();
  else closeThemeMenu();
});
themeButton.addEventListener("keydown", (event) => {
  if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
    event.preventDefault();
    openThemeMenu();
    if (event.key === "ArrowUp") themeOptions[themeOptions.length - 1].focus();
  }
});
themeMenu.addEventListener("click", (event) => {
  const option = event.target.closest('[role="option"]');
  if (option) chooseTheme(option.dataset.value);
});
themeMenu.addEventListener("keydown", (event) => {
  const index = themeOptions.indexOf(document.activeElement);
  if (event.key === "Escape") {
    event.preventDefault();
    closeThemeMenu(true);
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    themeOptions[(index + 1) % themeOptions.length].focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    themeOptions[(index - 1 + themeOptions.length) % themeOptions.length].focus();
  } else if (event.key === "Home") {
    event.preventDefault();
    themeOptions[0].focus();
  } else if (event.key === "End") {
    event.preventDefault();
    themeOptions[themeOptions.length - 1].focus();
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (index >= 0) chooseTheme(themeOptions[index].dataset.value);
  } else if (event.key === "Tab") {
    closeThemeMenu();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!themeMenu.hidden && !event.target.closest(".theme-picker")) closeThemeMenu();
});
syncThemePicker();
applyTheme();

const stickers = { wave: "👋", ok: "👌", party: "🎉", heart: "💚" };
const stickerNames = {
  wave: "打招呼",
  ok: "收到",
  party: "庆祝",
  heart: "喜欢",
};
const recentKey = "temporary-chat-recent";
let recent = [];
try {
  const saved = JSON.parse(localStorage.getItem(recentKey));
  if (Array.isArray(saved))
    recent = saved
      .filter(
        (item) =>
          item &&
          /^[A-Z0-9]{6}$/.test(item.room) &&
          typeof item.name === "string",
      )
      .slice(0, 5);
} catch (_) {}
function renderRecent() {
  const select = $("recent");
  select.replaceChildren(new Option("选择最近房间", ""));
  for (const item of recent)
    select.add(new Option(item.name + " · " + item.room, item.room));
  $("recent-field").hidden = !recent.length;
  $("room-recent").hidden = !recent.length;
  const visibleRooms = recent.filter(matchesRoomSearch).length;
  $("recent-empty").hidden = visibleRooms > 0;
  $("recent-empty").textContent = recent.length
    ? "没有匹配的房间。试试其他名称或加入码。"
    : "还没有最近房间。";
  $("room-recent-list").replaceChildren(
    ...recent.map((item) => {
      const entry = document.createElement("li");
      const button = document.createElement("button");
      button.className = "recent-button";
      button.type = "button";
      const avatar = document.createElement("span");
      avatar.className = "recent-avatar";
      avatar.textContent = "#";
      const text = document.createElement("span");
      text.className = "recent-text";
      const title = document.createElement("strong");
      title.textContent = item.name;
      const code = document.createElement("small");
      code.textContent = item.room;
      text.append(title, code);
      button.append(avatar, text);
      if (item.room === session?.room)
        button.setAttribute("aria-current", "page");
      button.addEventListener("click", () => {
        if (session) {
          notice(
            item.room === session.room
              ? "你已在这个房间。"
              : "请先离开当前房间，再加入其他房间。",
          );
          return;
        }
        $("room-code").value = item.room;
        $("room-code").focus();
        notice("已填入房间码，确认昵称后加入。");
      });
      entry.append(button);
      entry.hidden = !matchesRoomSearch(item);
      return entry;
    }),
  );
}
function matchesRoomSearch(item) {
  const query = $("room-search").value.trim().toLowerCase();
  return !query || (item.name + " " + item.room).toLowerCase().includes(query);
}
$("room-search").addEventListener("input", renderRecent);
function syncWorkspace() {
  const inRoom = !$("room-view").hidden;
  $("page-label").textContent = inRoom
    ? $("room-name").textContent
    : "房间大厅";
  $("lobby-nav").classList.toggle("active", !inRoom);
  $("loading-panel").hidden = authRequired !== null;
}
$("lobby-nav").addEventListener("click", () => {
  if (session) {
    notice("你正在房间中，离开后即可返回大厅。");
    return;
  }
  showLobby();
});
function setRoomName(name) {
  $("room-name").textContent = name;
  syncWorkspace();
  recent = [
    { room: session.room, name },
    ...recent.filter((item) => item.room !== session.room),
  ].slice(0, 5);
  try {
    localStorage.setItem(recentKey, JSON.stringify(recent));
  } catch (_) {}
  renderRecent();
}
const loginKey = "temporary-chat-account";
let account = null,
  loginToken = null,
  authRequired = null,
  authPending = false;
let resumingLogin = false,
  registering = false;
try {
  loginToken = sessionStorage.getItem(loginKey);
} catch (_) {}
function saveLogin(token) {
  loginToken = token;
  try {
    if (token) sessionStorage.setItem(loginKey, token);
    else sessionStorage.removeItem(loginKey);
  } catch (_) {}
}
function showLobby() {
  const allowed = authRequired === false || Boolean(account);
  $("account-panel").hidden = authRequired !== true || allowed;
  $("lobby").hidden = !allowed || !$("room-view").hidden;
  $("nickname-field").hidden = authRequired !== false;
  $("join-description").textContent =
    authRequired === true
      ? "输入朋友分享的房间码，继续你们的对话。"
      : "输入昵称和6位房间码。";
  $("logout").hidden = $("signed-in").hidden = !account;
  $("signed-in").textContent = account ? "当前账号 " + account : "";
  syncWorkspace();
}
function restoreRoom() {
  if (!session) return;
  restoring = true;
  pending = true;
  send(
    authRequired
      ? { type: "join", room: session.room }
      : { type: "join", ...session },
  );
}
const storageKey = "temporary-chat-session";
let socket,
  retryTimer,
  heartbeatTimer,
  attempts = 0,
  lastReceived = 0;
let session = null,
  joined = false,
  pending = false,
  restoring = false;
try {
  session = JSON.parse(sessionStorage.getItem(storageKey));
} catch (_) {
  /* 禁止存储时仍可正常聊天。 */
}
if (
  !session ||
  typeof session.room !== "string" ||
  typeof session.nickname !== "string"
)
  session = null;
const bytes = (value) => new TextEncoder().encode(value).length;
function persist() {
  try {
    session
      ? sessionStorage.setItem(storageKey, JSON.stringify(session))
      : sessionStorage.removeItem(storageKey);
  } catch (_) {
    /* 隐私模式下不保证刷新恢复。 */
  }
}
function notice(text = "") {
  const target = !$("room-view").hidden
    ? $("room-notice")
    : !$("account-panel").hidden
      ? $("account-notice")
      : $("notice");
  for (const id of ["notice", "account-notice", "room-notice"]) {
    const element = $(id);
    element.textContent = element === target ? text : "";
    element.hidden = element !== target || !text;
  }
}
const compactRoom = matchMedia("(max-width: 680px)");
function showRoomInfo(expanded) {
  $("room-info").setAttribute("aria-expanded", String(expanded));
  $("room-sidebar").classList.toggle("expanded", expanded);
  if (expanded) $("itinerary-panel").hidden = true;
  resizeDraft();
}
$("room-info").addEventListener("click", () => {
  const expanded = $("room-info").getAttribute("aria-expanded") === "true";
  showRoomInfo(!expanded);
});
function resizeDraft() {
  const input = $("message");
  // 先清掉旧高度，删除文字或发送后才能缩回一行。
  input.style.height = "auto";
  input.style.height = input.scrollHeight + 2 + "px";
}
function draftChanged() {
  resizeDraft();
  controls();
}
function controls() {
  const online = socket && socket.readyState === WebSocket.OPEN;
  const allowed = authRequired === false || Boolean(account);
  $("account-submit").disabled = !online || authPending;
  $("create").disabled = $("join").disabled = !online || !allowed || pending;
  $("send").disabled = !online || !joined || !$("message").value.trim();
  $("rename").disabled = !online || !joined;
  $("leave").disabled = !online || !joined;
  $("close-room").disabled = !online || !joined;
}
function connection(text, online = false) {
  $("status").textContent = text;
  $("status").classList.toggle("connected", online);
  controls();
}
function send(data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(data));
  return true;
}
function resetRoom(message) {
  assistantToken = ""; itineraryOwner = false; itineraryData = null; pinnedVersion = null;
  $("itinerary-panel").hidden = true; $("pinned-itinerary").hidden = true;
  session = null;
  joined = false;
  pending = false;
  restoring = false;
  persist();
  $("room-view").hidden = true;
  showLobby();
  showRoomInfo(false);
  $("room-settings").open = false;
  showRenameForm(false);
  showExpressions(false);
  $("close-room").hidden = true;
  $("members").replaceChildren();
  $("member-count").textContent = "0";
  renderRecent();
  notice(message);
  controls();
}
const messageList = $("messages");
const latestButton = $("latest");
let followingLatest = true;

function scrollToLatest() {
  followingLatest = true;
  messageList.scrollTop = messageList.scrollHeight;
  latestButton.hidden = true;
}
messageList.addEventListener("scroll", () => {
  followingLatest =
    messageList.scrollHeight -
      messageList.scrollTop -
      messageList.clientHeight <=
    24;
  latestButton.hidden = followingLatest;
});
latestButton.addEventListener("click", () => {
  scrollToLatest();
  messageList.focus({ preventScroll: true });
});
new ResizeObserver(() => {
  if (followingLatest) scrollToLatest();
}).observe(messageList);

function syncConversationIntro() {
  $("conversation-intro").hidden = Boolean(
    messageList.querySelector(".chat-message"),
  );
}
function appendMessage(node) {
  // 阅读旧消息时保留位置，清理最早的 DOM 节点也不改变正在读的内容。
  messageList.append(node);
  syncConversationIntro();
  while (messageList.children.length > 500) {
    const previousHeight = messageList.scrollHeight;
    const previousTop = messageList.scrollTop;
    messageList.firstElementChild.remove();
    if (!followingLatest)
      messageList.scrollTop =
        previousTop - (previousHeight - messageList.scrollHeight);
  }
  if (followingLatest) scrollToLatest();
  else latestButton.hidden = false;
}
function systemMessage(text) {
  const p = document.createElement("p");
  p.className = "system-message";
  p.textContent = text;
  appendMessage(p);
}
function makeAvatar(name, className) {
  const avatar = document.createElement("span");
  avatar.className = className;
  avatar.textContent = Array.from(name || "?")
    .slice(0, 1)
    .join("")
    .toUpperCase();
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}
function onMessage(event) {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch (_) {
    notice("收到无法识别的消息。");
    return;
  }
  lastReceived = Date.now();
  switch (data.type) {
    case "auth_mode":
      authRequired = data.required;
      if (authRequired && loginToken) {
        resumingLogin = true;
        authPending = true;
        send({ type: "authenticate", token: loginToken });
      } else if (!authRequired) restoreRoom();
      if (!joined) showLobby();
      if (authRequired) loadRegistrationPolicy();
      else applyRegistrationMode();
      controls();
      break;
    case "authenticated":
      const shouldRestore = resumingLogin && session?.nickname === data.name;
      $("invite-code").value = "";
      $("register-email").value = "";
      account = data.name;
      authPending = resumingLogin = false;
      saveLogin(data.token);
      if (shouldRestore) restoreRoom();
      else if (session) {
        session = null;
        persist();
      }
      showLobby();
      notice();
      controls();
      break;
    case "joined": {
      const wasRestoring = restoring;
      assistantToken = data.assistant_token || ""; itineraryOwner = Boolean(data.owner);
      itineraryKey = ""; itineraryData = null;
      setTimeout(() => refreshItinerary(true), 0);
      session = { room: data.room, nickname: data.nickname, token: data.token };
      joined = true;
      pending = false;
      restoring = false;
      attempts = 0;
      persist();
      $("lobby").hidden = true;
      $("room-view").hidden = false;
      $("room-id").textContent = data.room;
      $("identity").textContent =
        `${data.nickname}${data.owner ? " · 房主" : ""}`;
      $("close-room").hidden = !data.owner;
      $("expiry").textContent =
        `房间到期：${new Date(data.expires * 1000).toLocaleString("zh-CN")}`;
      $("rename").hidden = !data.owner;
      setRoomName(data.name || "同行房间");
      followingLatest = true;
      latestButton.hidden = true;
      messageList.replaceChildren();
      syncConversationIntro();
      systemMessage(
        wasRestoring
          ? "已恢复连接，以下是房间保留的最近消息。"
          : "已加入房间。",
      );
      notice();
      draftChanged();
      if (!compactRoom.matches) $("message").focus();
      break;
    }
    case "members":
      $("members").replaceChildren();
      if (Array.isArray(data.members)) {
        for (const name of data.members) {
          const li = document.createElement("li");
          const avatar = makeAvatar(name, "member-avatar");
          const label = document.createElement("span");
          label.textContent = name;
          li.append(avatar, label);
          if (name === session?.nickname) {
            const self = document.createElement("small");
            self.className = "member-self";
            self.textContent = "你";
            li.append(self);
          }
          $("members").append(li);
        }
        $("member-count").textContent = String(data.members.length);
      }
      break;
    case "renamed":
      if (session) setRoomName(data.name);
      break;
    case "sticker":
    case "chat": {
      const article = document.createElement("article");
      article.className = `chat-message${session && data.nickname === session.nickname ? " own" : ""}`;
      const name = document.createElement("p");
      name.className = "message-name";
      name.textContent = data.nickname;
      const text = document.createElement("p");
      text.className = "message-text";
      text.textContent =
        data.type === "sticker" ? stickers[data.id] : data.text;
      if (data.type === "sticker") {
        text.classList.add("sticker-message");
        text.setAttribute("aria-label", stickerNames[data.id] || "贴图");
      }
      const body = document.createElement("div");
      body.className = "message-body";
      body.append(name, text);
      if (data.nickname === "行程助手" && data.type === "chat") {
        const version = itineraryVersionOf(data.text);
        if (version != null) {
          const label = document.createElement("p");
          label.className = "itinerary-version-label";
          body.insertBefore(label, text);
          article.classList.add("itinerary-announcement");
          article.dataset.itineraryVersion = String(version);
        }
      }
      article.append(makeAvatar(data.nickname, "message-avatar"), body);
      appendMessage(article);
      syncItineraryLabels();
      if (invokeRequested && data.nickname === session?.nickname && data.text?.includes("@行程助手")) {
        invokeRequested = false; generateItinerary();
      }
      if (data.nickname === "行程助手") refreshItinerary();
      break;
    }
    case "closed":
      resetRoom(
        data.reason === "left"
          ? "已离开房间。"
          : data.reason === "expired"
            ? "房间已到期。"
            : "房间已关闭。",
      );
      break;
    case "error":
      // 恢复失败不循环提交无效令牌；让用户明确选择新的房间。
      if (data.code === "login_expired" || data.code === "login_required") {
        account = null;
        authPending = resumingLogin = false;
        saveLogin(null);
        resetRoom(data.message);
      } else if (authPending) {
        authPending = resumingLogin = false;
        notice(data.message);
        controls();
      } else if (data.code === "session_replaced")
        resetRoom("此会话已在另一连接恢复，请重新加入。");
      else if (restoring)
        resetRoom(`无法恢复房间：${data.message}。请重新加入。`);
      else {
        pending = false;
        notice(data.message || "操作失败，请重试。");
        controls();
      }
      break;
    case "pong":
      break;
  }
}
function connect() {
  clearTimeout(retryTimer);
  connection("正在连接…");
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
  );
  socket.onopen = () => {
    lastReceived = Date.now();
    connection("已连接", true);
    send({ type: "auth_mode" });
    if (!session) attempts = 0;
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastReceived > 45000) {
        socket.close();
        return;
      }
      send({ type: "ping" });
    }, 15000);
  };
  socket.onmessage = onMessage;
  socket.onerror = () => {
    /* close 事件统一安排重连，避免重复计时器。 */
  };
  socket.onclose = () => {
    clearInterval(heartbeatTimer);
    joined = false;
    pending = false;
    account = null;
    authPending = resumingLogin = false;
    // 1、2、4…秒指数退避，加入随机抖动，最终等待不超过 15 秒。
    const base = Math.min(15000, 1000 * 2 ** Math.min(attempts++, 5));
    const delay = Math.min(15000, base * (0.8 + Math.random() * 0.4));
    connection(`连接中断，${Math.ceil(delay / 1000)} 秒后重试`);
    retryTimer = setTimeout(connect, delay);
  };
}
function enter(type) {
  const nickname = $("nickname").value.trim();
  const room = $("room-code").value.trim().toUpperCase();
  if (!authRequired && (!nickname || bytes(nickname) > 48)) {
    notice("请输入昵称，长度不超过 48 个 UTF-8 字节（约 16 个汉字）。");
    $("nickname").focus();
    return;
  }
  if (type === "join" && !/^[A-Z0-9]{6}$/.test(room)) {
    notice("请填写完整的 6 位房间加入码。");
    $("room-code").focus();
    return;
  }
  notice();
  pending = true;
  if (
    !send({
      type,
      ...(authRequired ? {} : { nickname }),
      ...(type === "join" ? { room } : {}),
    })
  ) {
    pending = false;
    notice("连接尚未恢复，请稍后重试。");
  }
  controls();
}
let emailRegistration = false;
function applyRegistrationMode() {
  const show = registering && emailRegistration;
  $("email-register").hidden = !show;
  $("register-email").required = show;
  $("invite-code-hint").textContent = emailRegistration
    ? "注册码只发到邮箱，页面不会显示。未开启邮箱注册时，仍向组织者领取。"
    : "向活动组织者领取注册码。";
}
async function loadRegistrationPolicy() {
  emailRegistration = false;
  try {
    const response = await fetch("/api/register/policy");
    if (response.ok) {
      const data = await response.json();
      emailRegistration = data.email_registration === true;
    }
  } catch (_) {
    emailRegistration = false;
  }
  applyRegistrationMode();
}
$("send-register-code").addEventListener("click", async () => {
  const email = $("register-email").value.trim();
  const button = $("send-register-code");
  if (!emailRegistration) return;
  if (!email) {
    notice("请填写接收注册码的邮箱。");
    $("register-email").focus();
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch("/api/register/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      notice(data.error || "注册码未能发出");
      return;
    }
    notice("如果该邮箱可以注册，验证码会发到邮箱。邮件里的注册码不会出现在本页。");
  } catch (_) {
    notice("注册码未能发出");
  } finally {
    button.disabled = false;
  }
});
$("account-toggle").addEventListener("click", () => {
  registering = !registering;
  $("account-title").textContent = registering ? "注册账号" : "登录聊天室";
  $("account-description").textContent = registering
    ? "用一次性注册码创建同行账号。"
    : "使用你的同行账号继续。";
  $("account-submit").textContent = registering ? "注册并登录" : "登录";
  $("account-toggle").textContent = registering
    ? "已有账号，去登录"
    : "注册账号";
  $("invite-field").hidden = !registering;
  $("invite-code").required = registering;
  applyRegistrationMode();
  $("account-password").autocomplete = registering
    ? "new-password"
    : "current-password";
  notice();
});
$("account-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (location.protocol !== "https:") {
    notice("请通过 HTTPS 登录。");
    return;
  }
  const password = $("account-password").value;
  const request = {
    type: registering ? "register" : "login",
    name: $("account-name").value.trim(),
    password,
  };
  if (registering) {
    request.invite = $("invite-code").value.trim();
    if (emailRegistration) {
      const email = $("register-email").value.trim();
      if (!email) {
        notice("请填写接收注册码的邮箱。");
        return;
      }
      request.email = email;
    }
  }
  authPending = send(request);
  if (authPending) $("account-password").value = "";
  controls();
});
$("logout").addEventListener("click", () => {
  if (send({ type: "logout" })) {
    account = null;
    saveLogin(null);
    resetRoom("已退出登录。");
  }
});
$("entry-form").addEventListener("submit", (e) => {
  e.preventDefault();
  enter("join");
});
$("create").addEventListener("click", () => enter("create"));
$("message-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("message").value.trim();
  if (!text) return;
  if (bytes(text) > 2048) {
    notice("消息太长，请控制在 2048 个 UTF-8 字节以内（约 682 个汉字）。");
    return;
  }
  if (joined && send({ type: "chat", text })) {
    if (text.includes("@行程助手")) {
      if (itineraryOwner) invokeRequested = true;
      else notice("只有房主可以触发行程草稿。");
    }
    scrollToLatest();
    $("message").value = "";
    draftChanged();
    showExpressions(false);
    notice();
    $("message").focus({ preventScroll: true });
  }
});
$("message").addEventListener("input", draftChanged);
window.addEventListener("resize", resizeDraft);
$("message").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$("send").disabled) $("message-form").requestSubmit();
  }
});
$("leave").addEventListener("click", () => {
  if (
    !$("close-room").hidden &&
    !confirm("你是房主。离开会关闭房间，所有人都将退出。确认离开？")
  )
    return;
  if (send({ type: "leave" })) resetRoom("已离开房间。");
});
$("close-room").addEventListener("click", () => {
  if (confirm("关闭后所有成员都会退出，加入码立即失效。确认关闭？"))
    send({ type: "close" });
});
$("copy-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("room-id").textContent);
    notice("加入码已复制。");
  } catch (_) {
    notice(`请手动复制加入码：${$("room-id").textContent}`);
  }
});
$("transport").textContent =
  location.protocol === "https:"
    ? "当前连接：HTTPS / WSS"
    : "当前连接：HTTP / WS（未加密）";
renderRecent();
$("recent").addEventListener("change", (event) => {
  if (event.target.value) $("room-code").value = event.target.value;
});
function showRenameForm(open) {
  $("rename-form").hidden = !open;
  if (open) {
    $("rename-input").value = $("room-name").textContent;
    $("rename-input").focus();
    $("rename-input").select();
  }
}
$("rename").addEventListener("click", () => {
  showRenameForm($("rename-form").hidden);
});
$("rename-cancel").addEventListener("click", () => {
  showRenameForm(false);
  $("rename").focus();
});
$("rename-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("rename-input").value.trim();
  if (!name || bytes(name) > 64) {
    notice("群名需要 1–64 个 UTF-8 字节。");
    return;
  }
  send({ type: "rename", name });
  showRenameForm(false);
});
function showExpressions(open) {
  $("expression-options").hidden = !open;
  $("expression-toggle").setAttribute("aria-expanded", String(open));
  if (open) $("expression-options").scrollTop = 0;
}
$("expression-toggle").addEventListener("click", () => {
  showExpressions($("expression-options").hidden);
});
$("message-form").addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("expression-options").hidden) {
    showExpressions(false);
    $("expression-toggle").focus({ preventScroll: true });
  }
});
function expressionButton(group, label, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", onClick);
  $(group).append(button);
}
const emojiChoices = [
  "😀",
  "😊",
  "😂",
  "🤣",
  "😍",
  "🥳",
  "😎",
  "🤔",
  "😅",
  "😭",
  "😮",
  "😴",
  "👍",
  "👌",
  "🙌",
  "👏",
  "🙏",
  "👋",
  "❤️",
  "💚",
  "💙",
  "🔥",
  "✨",
  "🎉",
  "✅",
  "☕",
  "🍕",
  "🐱",
  "🐶",
  "🌈",
];
for (const emoji of emojiChoices)
  expressionButton("emoji-options", emoji, "插入 " + emoji, () => {
    const input = $("message");
    // 表情加在光标处，保留发送前的草稿与输入位置。
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (
      bytes(input.value.slice(0, start) + emoji + input.value.slice(end)) > 2048
    ) {
      notice("消息已达到 2048 个 UTF-8 字节。");
      return;
    }
    input.setRangeText(emoji, start, end, "end");
    draftChanged();
    if (!compactRoom.matches) input.focus({ preventScroll: true });
  });
for (const [id, emoji] of Object.entries(stickers))
  expressionButton(
    "sticker-options",
    emoji,
    "发送贴图 " + stickerNames[id],
    () => {
      if (joined && send({ type: "sticker", id })) {
        scrollToLatest();
        showExpressions(false);
        $("expression-toggle").focus({ preventScroll: true });
      }
    },
  );
// The itinerary service always authenticates against live C membership; UI flags are not permissions.
let assistantToken = "", itineraryOwner = false, itineraryData = null, itineraryKey = "", invokeRequested = false, itineraryBusy = false, pinnedVersion = null;
function itineraryVersionOf(text) {
  const match = String(text || "").match(/【(?:置顶行程\s*·\s*v|已确认行程\s*v)(\d+)/);
  return match ? Number(match[1]) : null;
}
function syncItineraryLabels() {
  for (const article of messageList.querySelectorAll(".itinerary-announcement")) {
    const version = Number(article.dataset.itineraryVersion);
    const label = article.querySelector(".itinerary-version-label");
    if (!label) continue;
    const current = version === pinnedVersion;
    article.classList.toggle("is-current-pin", current);
    article.classList.toggle("is-historical", !current);
    // Client-side status only; the stored chat body is left unchanged.
    label.textContent = current
      ? "已确认行程 v" + version + " · 当前置顶"
      : "已确认行程 v" + version + " · 历史版本";
  }
}
const itineraryFields = {date:"日期",meeting_time:"集合时间",meeting_place:"集合地点",destination:"目的地",transport:"交通",duration:"停留时长",regroup_time:"游览结束集合时间",regroup_place:"再次集合地点",seats:"车辆座位数",notes:"注意事项",route:"行程安排"};
const pendingTripValue = "待确认";
for (const [key,label] of Object.entries(itineraryFields)) {
  const el = document.createElement("label"); el.textContent = label;
  const input = document.createElement(["notes","route"].includes(key) ? "textarea" : "input");
  input.id = "trip-" + key;
  if (key === "date") {
    input.type = "date";
  } else if (key === "meeting_time" || key === "regroup_time") {
    input.type = "time";
  } else {
    input.maxLength = 400;
    input.placeholder = pendingTripValue;
  }
  if (["meeting_place","regroup_place","notes","route"].includes(key)) el.className = "wide";
  el.append(input); $("itinerary-fields").append(el);
}
function itineraryNotice(text="") { $("itinerary-notice").textContent=text; $("itinerary-notice").hidden=!text; }
function openItinerary() {
  $("itinerary-panel").hidden=false; $("itinerary-toggle").setAttribute("aria-expanded","true");
  showRoomInfo(false); refreshItinerary();
}
$("itinerary-toggle").addEventListener("click", () => {
  if ($("itinerary-panel").hidden) openItinerary();
  else { $("itinerary-panel").hidden=true; $("itinerary-toggle").setAttribute("aria-expanded","false"); }
});
$("itinerary-close").addEventListener("click", () => { $("itinerary-panel").hidden=true; $("itinerary-toggle").setAttribute("aria-expanded","false"); $("itinerary-toggle").focus(); });
$("pinned-itinerary").addEventListener("click",openItinerary);
document.addEventListener("keydown",e=>{ if(e.key==="Escape") { $("itinerary-panel").hidden=true; $("itinerary-toggle").setAttribute("aria-expanded","false"); } });
async function itineraryAPI(action, body) {
  if (!assistantToken || !joined) throw new Error("请先加入房间");
  const r = await fetch("/api/itinerary/"+action,{method:body ? "POST":"GET", headers:{"Authorization":"Bearer "+assistantToken,...(body ? {"Content-Type":"application/json"}:{})},...(body ? {body:JSON.stringify(body)}:{})});
  let data; try { data=await r.json(); } catch (_) { throw new Error("请通过带行程后台的本地预览入口打开（8090），不是单独的 C 静态页面。"); }
  if(!r.ok) throw new Error(data.error || "请求失败"); return data;
}
const jobLabels={pending:"待发送",sending:"发送中",sent:"已发送",cancelled:"已取消",uncertain:"结果待核查（不自动重发）"};
function shanghaiTime(ts) {return new Date(ts*1000).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})+" 上海时间";}
async function refreshItinerary(force=false) {
  if (!joined || !assistantToken || itineraryBusy) return;
  try {
    const state=await itineraryAPI("state");
    $("extraction-mode").textContent=state.mode+ (state.local_only ? " · 仅本地 SMTP 捕获":" · 外部 SMTP 模式");
    $("owner-tools").hidden=!state.owner;
    const current=state.draft || state.confirmed;
    const key=current ? current.version+":"+current.status : "none";
    if (force || key!==itineraryKey) {
      itineraryKey=key; itineraryData=current;
      $("itinerary-form").hidden=!current;
      $("itinerary-version").textContent=current ? "v"+current.version+ (current.status==="draft" ? " · 草稿，尚未发布" : " · 已确认行程") : "暂无行程";
      $("confirm-tools").hidden=!state.owner;
      for (const name of Object.keys(itineraryFields)) {
        const input = $("trip-" + name);
        const value = current?.data[name];
        input.value = value === pendingTripValue ? "" : (value ?? "");
        input.readOnly = !state.owner;
      }
      const conflicts=current?.data.conflicts || [];
      $("itinerary-conflicts").textContent=conflicts.join("；"); $("resolve-row").hidden=!state.owner || !conflicts.length; $("resolve-conflicts").checked=false;
      $("demo-reminder").checked=false; $("demo-reminder").closest("label").hidden=!state.local_only;
      $("confirm-itinerary").textContent=current?.status==="confirmed" ? "先保存为新版草稿" : "确认并发布";
      $("confirm-itinerary").disabled=current?.status==="confirmed";
    }
    pinnedVersion=state.confirmed ? state.confirmed.version : null;
    syncItineraryLabels();
    $("pinned-itinerary").hidden=!state.confirmed;
    if(state.confirmed) {const d=state.confirmed.data; $("pinned-itinerary").textContent="当前置顶 · v"+state.confirmed.version+"　"+d.date+" "+d.meeting_time+" "+d.meeting_place+"集合　→ 查看行程";}
    const sub=state.subscription;
    $("subscription-state").textContent=sub?.active ? "已订阅："+sub.email : "未订阅。仅你本人可修改订阅。";
    if(document.activeElement!==$("subscriber-email") && sub?.email) $("subscriber-email").value=sub.email;
    $("itinerary-jobs").replaceChildren();
    for(const j of state.jobs) {const li=document.createElement("li"); li.textContent="v"+j.version+" · "+j.kind+" · "+jobLabels[j.status]+"\n"+shanghaiTime(j.due)+(j.error ? "\n"+j.error:""); $("itinerary-jobs").append(li);}
    if(!state.jobs.length) {const li=document.createElement("li");li.textContent="暂无排期。确认行程且有成员订阅后建立提醒。";$("itinerary-jobs").append(li);}
    $("itinerary-logs").replaceChildren();
    for(const l of state.logs) {const li=document.createElement("li");li.textContent=shanghaiTime(l.created)+"\nv"+l.version+" · "+l.detail;$("itinerary-logs").append(li);}
  } catch(e) { if(!$("itinerary-panel").hidden) itineraryNotice(e.message); }
}
async function itineraryAction(action) {
  if(itineraryBusy) return;
  itineraryBusy=true; let success=false; $("extract-itinerary").disabled=true;
  try { await action(); success=true; itineraryNotice(); }
  catch(e) { itineraryNotice(e.message); }
  finally { itineraryBusy=false; $("extract-itinerary").disabled=false; await refreshItinerary(success); }
}
async function generateItinerary() {
  openItinerary();
  await itineraryAction(async()=>{ await itineraryAPI("extract",{}); });
}
$("extract-itinerary").addEventListener("click",generateItinerary);
function editedTrip() {
  const data={...itineraryData.data};
  for (const key of Object.keys(itineraryFields)) {
    // 接口用「待确认」保存未填写的项目，表单里只把它当作提示。
    data[key] = $("trip-" + key).value.trim() || pendingTripValue;
  }
  if($("resolve-conflicts").checked) data.conflicts=[];
  return data;
}
$("save-itinerary").addEventListener("click",()=>itineraryAction(async()=>{
  if(!itineraryData) return;
  await itineraryAPI("save",{version:itineraryData.version,data:editedTrip()});
}));
$("itinerary-form").addEventListener("submit",e=>{ e.preventDefault(); if(!itineraryData || itineraryData.status!=="draft") return;
  itineraryAction(async()=>{await itineraryAPI("confirm",{version:itineraryData.version,data:editedTrip(),demo:$("demo-reminder").checked});});
});
$("subscription-form").addEventListener("submit",e=>{e.preventDefault();itineraryAction(async()=>{await itineraryAPI("subscribe",{active:true,email:$("subscriber-email").value.trim()});});});
$("unsubscribe").addEventListener("click",()=>itineraryAction(async()=>{await itineraryAPI("subscribe",{active:false});}));
setInterval(()=>refreshItinerary(),3000);
connect();
