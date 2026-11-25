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
  "panel-left": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  "eye-off":
    '<path d="m3 3 18 18M10.6 6.1c.5-.1.9-.1 1.4-.1 6.5 0 10 6 10 6a16 16 0 0 1-3 3.4M6.3 7.8A16 16 0 0 0 2 12s3.5 6 10 6c1.5 0 2.8-.3 4-.8M10 10a2.8 2.8 0 0 0 4 4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  smile:
    '<circle cx="12" cy="12" r="9"/><path d="M8 14a4 4 0 0 0 8 0M8 8.5h.01M16 8.5h.01"/>',
  send: '<path d="m21 3-7 18-4-7-7-4 18-7ZM10 14 21 3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  reply: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
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

const navigationKey = "temporary-chat-navigation-collapsed";
const navigationCompact = matchMedia("(max-width: 680px)");
const navigation = $("room-navigation");
const navigationToggle = $("navigation-toggle");
let desktopNavigationCollapsed = false;
let mobileNavigationOpen = false;
try {
  desktopNavigationCollapsed = localStorage.getItem(navigationKey) === "true";
} catch (_) {}

function syncNavigation() {
  const accountScreen = $("app-shell").classList.contains("is-account");
  if (accountScreen) mobileNavigationOpen = false;
  const expanded = !accountScreen && (navigationCompact.matches
    ? mobileNavigationOpen
    : !desktopNavigationCollapsed);
  const drawer = navigationCompact.matches && expanded;
  const focusWasInNavigation = navigation.contains(document.activeElement);
  navigation.hidden = !expanded;
  navigationToggle.hidden = accountScreen;
  navigationToggle.setAttribute("aria-expanded", String(expanded));
  navigationToggle.setAttribute("aria-label", expanded ? "收起侧栏" : "展开侧栏");
  navigationToggle.title = expanded ? "收起侧栏" : "展开侧栏";
  $("app-shell").classList.toggle("is-navigation-collapsed", !expanded);
  $("navigation-backdrop").hidden = !drawer;
  $("workspace").inert = drawer;
  if (drawer) {
    navigation.setAttribute("role", "dialog");
    navigation.setAttribute("aria-modal", "true");
  } else {
    navigation.removeAttribute("role");
    navigation.removeAttribute("aria-modal");
  }
  if (!expanded && focusWasInNavigation && !accountScreen) navigationToggle.focus();
  resizeDraft();
}

function closeMobileNavigation(returnFocus = true) {
  if (!navigationCompact.matches || !mobileNavigationOpen) return;
  mobileNavigationOpen = false;
  syncNavigation();
  if (returnFocus) navigationToggle.focus();
}

navigationToggle.addEventListener("click", () => {
  if (navigationCompact.matches) {
    mobileNavigationOpen = !mobileNavigationOpen;
  } else {
    desktopNavigationCollapsed = !desktopNavigationCollapsed;
    try {
      localStorage.setItem(navigationKey, String(desktopNavigationCollapsed));
    } catch (_) {}
  }
  syncNavigation();
  if (navigationCompact.matches && mobileNavigationOpen) {
    closeThemeMenu();
    $("navigation-close").focus();
  }
});
$("navigation-close").addEventListener("click", () => closeMobileNavigation());
$("navigation-backdrop").addEventListener("click", () => closeMobileNavigation());
navigationCompact.addEventListener("change", () => {
  mobileNavigationOpen = false;
  syncNavigation();
  if (!navigationCompact.matches && document.activeElement === $("navigation-close")) {
    navigationToggle.focus();
  }
});
document.addEventListener("keydown", event => {
  if (!navigationCompact.matches || !mobileNavigationOpen) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeMobileNavigation();
  } else if (event.key === "Tab") {
    const focusable = [...navigation.querySelectorAll('a[href], button, input, select, [tabindex="0"]')]
      .filter(element => !element.disabled && !element.closest("[hidden]"));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});
syncNavigation();

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
        closeMobileNavigation(false);
        if (session) {
          notice(
            item.room === session.room
              ? "你已在这个房间。"
              : "请先离开当前房间，再加入其他房间。",
          );
          return;
        }
        $("room-code").value = item.room;
        const saved = detachedTokens[item.room];
        if (!authRequired && saved?.nickname && !$("nickname").value.trim()) {
          $("nickname").value = saved.nickname;
        }
        $("room-code").focus();
        notice(
          saved
            ? "已填入房间码与上次身份，点击加入即可恢复房主/成员会话。"
            : "已填入房间码，确认昵称后加入。",
        );
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
  closeMobileNavigation();
  if (session) {
    notice("你正在房间中，离开后即可返回大厅。");
    return;
  }
  showLobby();
});
function setRoomName(name) {
  $("room-name").textContent = name;
  syncWorkspace();
  updateDocumentTitle();
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
  authPending = false,
  assistantEnabled = false;
let resumingLogin = false,
  registering = false,
  emailRegistration = false;
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
  const accountScreen = authRequired === true && !allowed && $("room-view").hidden;
  $("account-panel").hidden = $("account-brand").hidden = !accountScreen;
  $("app-shell").classList.toggle("is-account", accountScreen);
  syncNavigation();
  $("lobby").hidden = !allowed || !$("room-view").hidden;
  $("nickname-field").hidden = authRequired !== false;
  $("join-description").textContent =
    authRequired === true
      ? "输入朋友分享的房间码，继续你们的对话。"
      : "输入昵称和6位房间码。";
  $("logout").hidden = $("signed-in").hidden = !account;
  $("notice-account-actions").hidden = !account || !assistantEnabled;
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
const detachedKey = "temporary-chat-detached";
let detachedTokens = {};
try {
  const saved = JSON.parse(sessionStorage.getItem(detachedKey));
  if (saved && typeof saved === "object") detachedTokens = saved;
} catch (_) {}
function saveDetachedTokens() {
  try {
    sessionStorage.setItem(detachedKey, JSON.stringify(detachedTokens));
  } catch (_) {}
}
function rememberDetachedSession() {
  if (!authRequired && session?.room && session?.token && session?.nickname) {
    detachedTokens[session.room] = { nickname: session.nickname, token: session.token };
    saveDetachedTokens();
  }
}
function forgetDetachedSession(roomCode) {
  if (roomCode && detachedTokens[roomCode]) {
    delete detachedTokens[roomCode];
    saveDetachedTokens();
  }
}
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
  if (expanded) closeItinerary();
  else resizeDraft();
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
  $("account-fields").disabled = $("account-toggle").disabled = authPending;
  $("account-form").setAttribute("aria-busy", String(authPending));
  $("account-spinner").hidden = !authPending;
  $("account-submit-text").textContent = authPending
    ? (resumingLogin ? "正在恢复登录" : registering ? "正在注册…" : "正在登录…")
    : (registering ? "注册并登录" : "登录");
  $("create").disabled = $("join").disabled = !online || !allowed || pending;
  $("send").disabled = !online || !joined || !$("message").value.trim();
  $("rename").disabled = !online || !joined;
  $("extend-room").disabled = !online || !joined;
  $("expiry-banner-extend").disabled = !online || !joined;
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
  try {
    socket.send(JSON.stringify(data));
    return true;
  } catch (_) {
    return false;
  }
}
function resetRoom(message) {
  noticeCards.clear();
  if (noticeView === "publish" && noticeDialog.open) noticeDialog.close();
  resetNoticeDraft();
  if (!account && noticeDialog.open) noticeDialog.close();
  hideBotMention();
  clearReply();
  const ld = $("leave-dialog");
  if (ld?.open) {
    if (typeof ld.close === "function") ld.close();
    else ld.open = false;
  }
  roomMembers = [];
  roomOwnerName = "";
  roomExpiresAt = 0;
  stopExpiryCountdown();
  $("expiry-banner").hidden = true;
  $("extend-room").hidden = true;
  $("export-itinerary-ics").hidden = true;
  hiddenUnread = 0;
  scrolledUnread = 0;
  updateLatestButton();
  assistantToken = ""; itineraryOwner = false; itineraryData = null; pinnedVersion = null;
  closeItinerary();
  $("pinned-itinerary").hidden = true;
  messageList.replaceChildren(olderButton);
  renderedMessages.clear();
  showHistoryButton("");
  session = null;
  joined = false;
  pending = false;
  restoring = false;
  persist();
  $("room-view").hidden = true;
  showLobby();
  updateDocumentTitle();
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
const olderButton = $("older-messages");
let followingLatest = true;
let leavingRoom = false;
let historyBefore = "";
let hiddenUnread = 0;
let scrolledUnread = 0;
let roomMembers = [];
let roomOwnerName = "";
let roomExpiresAt = 0;
let expiryTimer = null;
let activeReply = null;
const notifyKey = "temporary-chat-notify";
let notifyEnabled = false;
try {
  notifyEnabled = localStorage.getItem(notifyKey) === "1";
} catch (_) {}

function syncNotifyButton() {
  const button = $("notify-toggle");
  const label = $("notify-toggle-label");
  if (!button || !label) return;
  const supported = typeof Notification !== "undefined";
  const granted = supported && Notification.permission === "granted";
  const active = notifyEnabled && granted;
  button.hidden = !supported;
  button.setAttribute("aria-pressed", String(active));
  label.textContent = active ? "桌面通知：开" : "桌面通知：关";
}
$("notify-toggle")?.addEventListener("click", async () => {
  if (typeof Notification === "undefined") return;
  if (notifyEnabled && Notification.permission === "granted") {
    notifyEnabled = false;
    try { localStorage.setItem(notifyKey, "0"); } catch (_) {}
    syncNotifyButton();
    notice("已关闭桌面新消息通知。");
    return;
  }
  let perm = Notification.permission;
  if (perm === "default") {
    try { perm = await Notification.requestPermission(); } catch (_) { perm = "denied"; }
  }
  if (perm === "granted") {
    notifyEnabled = true;
    try { localStorage.setItem(notifyKey, "1"); } catch (_) {}
    syncNotifyButton();
    notice("已开启后台桌面通知。");
  } else {
    notifyEnabled = false;
    syncNotifyButton();
    notice("浏览器未授予通知权限，请在地址栏设置中允许通知。");
  }
});
syncNotifyButton();

function updateDocumentTitle() {
  const base = joined ? `${$("room-name").textContent} · 同行` : "同行 · 临时聊天室";
  document.title = joined && hiddenUnread > 0 ? `(${hiddenUnread}) ${base}` : base;
}
function clearHiddenUnread() {
  if (!hiddenUnread) return;
  hiddenUnread = 0;
  updateDocumentTitle();
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) clearHiddenUnread();
});
window.addEventListener("focus", clearHiddenUnread);

function maybeDesktopNotify(sender, body, mentioned) {
  if (!joined || !document.hidden) return;
  if (sender && session && sender === session.nickname) return;
  hiddenUnread += 1;
  updateDocumentTitle();
  if (
    !notifyEnabled ||
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return;
  try {
    const title = mentioned
      ? `[有人@你] ${$("room-name").textContent}`
      : $("room-name").textContent;
    const n = new Notification(title, {
      body: sender ? `${sender}: ${body}` : body,
      tag: `room-${session?.room || "chat"}`,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch (_) {}
}

function updateLatestButton() {
  latestButton.textContent =
    scrolledUnread > 0 ? `↓ ${scrolledUnread} 条新消息` : "回到最新";
}
// 待确认消息属于房间和身份；断线重连只重建界面，不丢掉发送记录。
const pendingChats = new Map();
const renderedMessages = new Map();
const deliveryTimeout = 15000;
function deliveryScope() {
  return session ? JSON.stringify([session.room, session.nickname]) : "";
}
function roomPending() {
  return [...pendingChats.values()].filter(item => item.scope === deliveryScope());
}
function forgetPendingRoom() {
  for (const item of roomPending()) {
    clearTimeout(item.timer);
    pendingChats.delete(item.data.client_id);
  }
}
function messageKeys(data) {
  return [data.sequence != null ? "sequence:" + data.sequence : "",
    data.message_id != null ? "id:" + data.message_id : "",
    data.client_id ? "client:" + JSON.stringify([data.nickname, data.client_id]) : ""].filter(Boolean);
}
function rememberMessage(data, node) {
  for (const key of messageKeys(data)) renderedMessages.set(key, node);
}
function messageDate(data) {
  if (typeof data.sent_at !== "number" || !Number.isFinite(data.sent_at) || data.sent_at <= 0) return null;
  const date = new Date(data.sent_at * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}
function regroupDates() {
  for (const separator of messageList.querySelectorAll(".message-date")) separator.remove();
  let previousDay = "";
  for (const article of messageList.querySelectorAll(".chat-message")) {
    const day = article.dataset.day || "";
    if (day && day !== previousDay) {
      const separator = document.createElement("p");
      separator.className = "message-date";
      separator.textContent = day;
      article.before(separator);
    }
    previousDay = day;
  }
}
function refreshPending(item) {
  if (item.scope !== deliveryScope()) return;
  const node = chatArticle({...item.data, delivery: item.state, deliveryError: item.error});
  if (item.node?.isConnected) item.node.replaceWith(node);
  else appendMessage(node);
  item.node = node;
  rememberMessage(item.data, node);
}
function failChat(item, error = "未收到服务器确认，请重试。") {
  clearTimeout(item.timer);
  item.state = "failed";
  item.error = error;
  refreshPending(item);
}
function transmitChat(item) {
  if (item.scope !== deliveryScope()) return false;
  clearTimeout(item.timer);
  item.state = "sending";
  item.error = "";
  refreshPending(item);
  const frame = { type: "chat", text: item.data.text, client_id: item.data.client_id };
  if (item.data.reply_to && item.data.reply_text) {
    frame.reply_to = item.data.reply_to;
    frame.reply_text = item.data.reply_text;
  }
  if (!joined || !send(frame)) {
    failChat(item, "连接尚未恢复，请稍后重试。");
    return false;
  }
  item.timer = setTimeout(() => failChat(item), deliveryTimeout);
  return true;
}
function receiveChat(data, page = null) {
  if (!joined) return;
  const item = pendingChats.get(data.client_id);
  const matchingPending = item && item.scope === deliveryScope() && data.nickname === session.nickname;
  const existing = messageKeys(data).map(key => renderedMessages.get(key)).find(node => node?.isConnected || (page && node?.parentNode === page));
  if (matchingPending) {
    clearTimeout(item.timer);
    pendingChats.delete(data.client_id);
  }
  // 已确认消息不可变；保留原节点也能维持加载历史时的滚动锚点。
  if (existing && !matchingPending) {
    rememberMessage(data, existing);
    return;
  }
  // 同一条消息的广播、确认和历史回放，都更新同一个气泡。
  if (existing || (matchingPending && item.node?.isConnected)) {
    const oldNode = existing || item.node;
    const node = chatArticle(data);
    oldNode.replaceWith(node);
    rememberMessage(data, node);
  } else {
    const node = chatArticle(data);
    rememberMessage(data, node);
    if (page) page.append(node);
    else appendMessage(node, Boolean(session && data.nickname !== session.nickname));
  }
  if (!page) {
    // 恢复连接时历史逐条到达，尚未确认的消息始终放在历史之后。
    for (const unresolved of roomPending()) if (unresolved.node?.isConnected) messageList.append(unresolved.node);
    regroupDates();
  }
}

function showHistoryButton(before) {
  historyBefore = before || "";
  olderButton.hidden = !historyBefore;
  olderButton.disabled = false;
  olderButton.textContent = "加载更早的消息";
}

olderButton.addEventListener("click", () => {
  if (!historyBefore || !send({ type: "history", before: historyBefore })) return;
  olderButton.disabled = true;
  olderButton.textContent = "正在加载…";
});

function scrollToLatest() {
  followingLatest = true;
  scrolledUnread = 0;
  updateLatestButton();
  messageList.scrollTop = messageList.scrollHeight;
  latestButton.hidden = true;
}
messageList.addEventListener("scroll", () => {
  followingLatest =
    messageList.scrollHeight -
      messageList.scrollTop -
      messageList.clientHeight <=
    24;
  if (followingLatest) {
    scrolledUnread = 0;
    updateLatestButton();
  }
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
function appendMessage(node, countAsUnread = false) {
  messageList.append(node);
  syncConversationIntro();
  if (followingLatest) {
    scrollToLatest();
  } else {
    if (countAsUnread) {
      scrolledUnread += 1;
      updateLatestButton();
    }
    latestButton.hidden = false;
  }
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
function truncateUtf8(str, maxBytes) {
  const clean = String(str || "").replace(/\s+/g, " ").trim();
  let out = "";
  for (const ch of clean) {
    if (bytes(out + ch) > maxBytes - 3) return out + "…";
    out += ch;
  }
  return out;
}
function setReply(nickname, snippet) {
  const clean = truncateUtf8(snippet, 180);
  if (!nickname || !clean) return;
  activeReply = { nickname, text: clean };
  $("reply-preview-name").textContent = `回复 ${nickname}`;
  $("reply-preview-text").textContent = clean;
  $("reply-preview").hidden = false;
  $("message").focus({ preventScroll: true });
}
function clearReply() {
  activeReply = null;
  if ($("reply-preview")) $("reply-preview").hidden = true;
}
$("reply-cancel")?.addEventListener("click", () => {
  clearReply();
  $("message").focus({ preventScroll: true });
});
function mentionsSelf(text) {
  if (!session?.nickname || !text) return false;
  const escaped = session.nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`[@＠]${escaped}(?=$|[\\s，。！？、：；,.!?:;])`).test(text);
}

function chatArticle(data) {
  const article = document.createElement("article");
  const isOwn = Boolean(session && data.nickname === session.nickname);
  const mentioned = !isOwn && data.type === "chat" && mentionsSelf(data.text);
  article.className = `chat-message${isOwn ? " own" : ""}${mentioned ? " is-mentioned" : ""}`;
  article.dataset.sender = data.nickname || "";
  const name = document.createElement("p");
  name.className = "message-name";
  name.textContent = data.nickname;
  if (data.bot === true) {
    const badge = document.createElement("span");
    badge.className = "bot-badge";
    badge.textContent = "机器人";
    name.append(badge);
  }
  const text = document.createElement("p");
  text.className = "message-text";
  text.textContent = data.type === "sticker" ? stickers[data.id] : data.text;
  if (data.type === "sticker") {
    text.classList.add("sticker-message");
    text.setAttribute("aria-label", stickerNames[data.id] || "贴图");
  }
  const body = document.createElement("div");
  body.className = "message-body";
  body.append(name);
  if (data.reply_to && data.reply_text) {
    const quote = document.createElement("div");
    quote.className = "message-quote";
    const qWho = document.createElement("strong");
    qWho.textContent = data.reply_to;
    const qText = document.createElement("span");
    qText.textContent = data.reply_text;
    quote.append(qWho, qText);
    article.dataset.replyTo = data.reply_to;
    article.dataset.replyText = data.reply_text;
    body.append(quote);
  }
  const wrap = document.createElement("div");
  wrap.className = "message-bubble-wrap";
  wrap.append(text);
  const replyBtn = document.createElement("button");
  replyBtn.type = "button";
  replyBtn.className = "reply-trigger";
  replyBtn.setAttribute("aria-label", `引用回复 ${data.nickname}`);
  replyBtn.title = "引用回复";
  replyBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    iconPaths.reply +
    "</svg>";
  const snippet =
    data.type === "sticker"
      ? `[贴图：${stickerNames[data.id] || "表情"}]`
      : data.text;
  replyBtn.addEventListener("click", () => setReply(data.nickname, snippet));
  wrap.append(replyBtn);
  body.append(wrap);
  const date = messageDate(data);
  const metadata = document.createElement("div");
  metadata.className = "message-meta";
  if (date) {
    article.dataset.day = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    const time = document.createElement("time");
    time.dateTime = date.toISOString();
    time.textContent = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    time.title = date.toLocaleString("zh-CN", {hour12: false});
    metadata.append(time);
  }
  if (data.delivery) {
    article.dataset.delivery = data.delivery;
    const status = document.createElement("span");
    status.className = "message-delivery";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = data.delivery === "sending" ? "发送中…" : "发送失败 · " + (data.deliveryError || "请重试");
    metadata.append(status);
    if (data.delivery === "failed") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "message-retry";
      retry.textContent = "重试";
      retry.setAttribute("aria-label", "重新发送这条消息");
      retry.addEventListener("click", () => {
        const item = pendingChats.get(data.client_id);
        if (item) transmitChat(item);
      });
      metadata.append(retry);
    }
  }
  if (!data.delivery && data.type === "chat" && data.client_id && data.nickname === session?.nickname) {
    article.dataset.delivery = "confirmed";
    const confirmed = document.createElement("span");
    confirmed.className = "message-delivery";
    confirmed.textContent = "已确认";
    confirmed.title = "服务器已接收这条消息，不代表其他成员已读。";
    confirmed.setAttribute("aria-label", confirmed.title);
    metadata.append(confirmed);
  }
  if (metadata.childNodes.length) body.append(metadata);
  if (data.nickname === "行程助手" && data.type === "chat") {
    const version = itineraryVersionOf(data.text);
    if (version != null) {
      const label = document.createElement("p");
      label.className = "itinerary-version-label";
      body.insertBefore(label, wrap);
      article.classList.add("itinerary-announcement");
      article.dataset.itineraryVersion = String(version);
    }
  }
  article.append(makeAvatar(data.nickname, "message-avatar"), body);
  return article;
}

function prependHistory(messages, before) {
  const anchor = messageList.querySelector(".chat-message, .important-notice-card");
  const offset = anchor?.getBoundingClientRect().top;
  const page = document.createDocumentFragment();
  for (const message of messages) {
    if (message.type === "notice") displayNoticeCard(message, page);
    else receiveChat(message, page);
  }
  if (anchor) anchor.before(page);
  else messageList.append(page);
  showHistoryButton(before);
  regroupDates();
  if (anchor) messageList.scrollTop += anchor.getBoundingClientRect().top - offset;
  syncConversationIntro();
  syncItineraryLabels();
}

function syncOwnerControls() {
  if (!session) return;
  $("identity").textContent = `${session.nickname}${itineraryOwner ? " · 房主" : ""}`;
  $("close-room").hidden = !itineraryOwner;
  $("rename").hidden = !itineraryOwner;
  $("extend-room").hidden = !itineraryOwner;
  $("expiry-banner-extend").hidden = !itineraryOwner;
  $("notice-publish-open").hidden = !account || !itineraryOwner || !assistantEnabled;
  if (!itineraryOwner) showRenameForm(false);
}

function formatRemaining(seconds) {
  if (seconds <= 0) return "即将关闭";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function renderExpiry() {
  if (!joined || !roomExpiresAt) {
    $("expiry-banner").hidden = true;
    return;
  }
  const remaining = Math.max(0, Math.floor(roomExpiresAt - Date.now() / 1000));
  const at = new Date(roomExpiresAt * 1000).toLocaleString("zh-CN");
  $("expiry").textContent = `剩余 ${formatRemaining(remaining)} · 到期 ${at}`;
  const warn = remaining <= 900;
  $("expiry-banner").hidden = !warn;
  if (warn) {
    $("expiry-banner-text").textContent =
      remaining > 0
        ? `房间将在 ${formatRemaining(remaining)} 后到期自动关闭`
        : "房间即将到期关闭";
    $("expiry-banner-extend").hidden = !itineraryOwner;
  }
}

function stopExpiryCountdown() {
  clearInterval(expiryTimer);
  expiryTimer = null;
}

function startExpiryCountdown(expiresSec) {
  roomExpiresAt = Number(expiresSec) || 0;
  stopExpiryCountdown();
  renderExpiry();
  if (roomExpiresAt) expiryTimer = setInterval(renderExpiry, 1000);
}

function renderMembers() {
  $("members").replaceChildren();
  for (const name of roomMembers) {
    const li = document.createElement("li");
    const avatar = makeAvatar(name, "member-avatar");
    const label = document.createElement("span");
    label.textContent = name;
    li.append(avatar, label);
    const tags = document.createElement("span");
    tags.className = "member-tags";
    if (name === roomOwnerName) {
      const ownerTag = document.createElement("small");
      ownerTag.className = "member-owner-badge";
      ownerTag.textContent = "房主";
      tags.append(ownerTag);
    }
    if (name === session?.nickname) {
      const self = document.createElement("small");
      self.className = "member-self";
      self.textContent = "你";
      tags.append(self);
    } else if (itineraryOwner) {
      const transferBtn = document.createElement("button");
      transferBtn.type = "button";
      transferBtn.className = "member-transfer-btn secondary";
      transferBtn.textContent = "设为房主";
      transferBtn.setAttribute("aria-label", `将房主转让给 ${name}`);
      transferBtn.addEventListener("click", () => {
        if (!confirm(`确认将房主权限转让给「${name}」？转让后你将变为普通成员。`)) return;
        send({ type: "transfer", target: name });
      });
      tags.append(transferBtn);
    }
    if (tags.childElementCount) li.append(tags);
    $("members").append(li);
  }
  $("member-count").textContent = String(roomMembers.length);
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
      assistantEnabled = data.assistant_enabled === true;
      $("message").placeholder = assistantEnabled ? "输入消息，@群聊助手 提问…" : "输入消息…";
      if (authRequired && loginToken) {
        resumingLogin = true;
        authPending = true;
        send({ type: "authenticate", token: loginToken });
      } else if (!authRequired) restoreRoom();
      if (!joined) showLobby();
      loadRegistrationPolicy();
      controls();
      break;
    case "authenticated":
      const shouldRestore = resumingLogin && session?.nickname === data.name;
      account = data.name;
      authPending = resumingLogin = false;
      $("account-form").reset();
      setAccountMode(false);
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
      noticeCards.clear();
      clearReply();
      hiddenUnread = 0;
      scrolledUnread = 0;
      updateLatestButton();
      if (itineraryOwner) roomOwnerName = data.nickname;
      $("lobby").hidden = true;
      $("room-view").hidden = false;
      $("room-id").textContent = data.room;
      syncOwnerControls();
      startExpiryCountdown(data.expires);
      $("notice-room-contact").hidden = !account || !assistantEnabled;
      setRoomName(data.name || "同行房间");
      followingLatest = true;
      latestButton.hidden = true;
      messageList.replaceChildren(olderButton);
      renderedMessages.clear();
      showHistoryButton(data.history_before);
      syncConversationIntro();
      systemMessage(
        wasRestoring
          ? "已恢复连接，以下是房间保留的最近消息。"
          : "已加入房间。",
      );
      for (const item of roomPending()) {
        item.node = null;
        refreshPending(item);
      }
      notice();
      draftChanged();
      if (!compactRoom.matches) $("message").focus();
      break;
    }
    case "members":
      if (typeof data.owner === "string") roomOwnerName = data.owner;
      if (Array.isArray(data.members)) {
        roomMembers = data.members.slice();
        renderMembers();
      }
      break;
    case "owner_changed": {
      const nextOwner = data.owner || "";
      roomOwnerName = nextOwner;
      itineraryOwner = Boolean(session && nextOwner === session.nickname);
      syncOwnerControls();
      renderMembers();
      renderExpiry();
      if (itineraryOwner) refreshItinerary(true);
      systemMessage(
        itineraryOwner
          ? `${data.from ? data.from + " 已将房主转让给你。" : "你已成为新房主。"}`
          : `${data.from ? data.from + " 已将房主转让给 " : "房主已变更为 "}${nextOwner}。`,
      );
      break;
    }
    case "extended":
      if (typeof data.expires === "number") {
        startExpiryCountdown(data.expires);
        systemMessage(
          `${data.by ? data.by + " " : ""}已将房间有效期延长至 ${new Date(data.expires * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}。`,
        );
      }
      break;
    case "renamed":
      if (session) setRoomName(data.name);
      break;
    case "history":
      if (joined && olderButton.disabled) prependHistory(data.messages, data.before);
      break;
    case "chat_ack":
      if (data.message && data.message.client_id === data.client_id && data.message.nickname === session?.nickname) {
        receiveChat(data.message);
        syncItineraryLabels();
      }
      break;
    case "sticker":
    case "chat": {
      const isOwn = Boolean(session && data.nickname === session.nickname);
      receiveChat(data);
      const preview = data.type === "sticker" ? `[贴图：${stickerNames[data.id] || "表情"}]` : data.text;
      maybeDesktopNotify(data.nickname, preview, !isOwn && data.type === "chat" && mentionsSelf(data.text));
      syncItineraryLabels();
      if (invokeRequested && data.nickname === session?.nickname && data.text?.includes("@行程助手")) {
        invokeRequested = false; generateItinerary();
      }
      if (data.nickname === "行程助手") refreshItinerary();
      break;
    }
    case "notice":
      displayNoticeCard(data);
      maybeDesktopNotify("重要通知", data.title || data.text, false);
      break;
    case "closed":
      if (data.reason === "detached") rememberDetachedSession();
      else if (session?.room) forgetDetachedSession(session.room);
      if (leavingRoom) forgetPendingRoom();
      leavingRoom = false;
      resetRoom(
        data.reason === "detached"
          ? "已暂时离开房间，房主身份已保留，可随时从「最近房间」返回。"
          : data.reason === "left" || (data.reason === "owner_left" && itineraryOwner)
            ? "已离开房间。"
            : data.reason === "expired"
              ? "房间已到期。"
              : "房间已关闭。",
      );
      break;
    case "error":
      if (data.code === "invalid_token" || data.code === "room_not_found") {
        forgetDetachedSession($("room-code").value.trim().toUpperCase());
      }
      if (data.client_id) {
        const item = pendingChats.get(data.client_id);
        if (item && item.scope === deliveryScope()) failChat(item, data.message || "操作失败，请重试。");
        break;
      }
      if (olderButton.disabled &&
          ["history_read_failed", "history_unavailable", "invalid_history"].includes(data.code)) {
        showHistoryButton(historyBefore);
      }
      // 恢复失败不循环提交无效令牌；让用户明确选择新的房间。
      if (data.code === "login_expired" || data.code === "login_required") {
        account = null;
        authPending = resumingLogin = false;
        saveLogin(null);
        resetRoom(data.message);
      } else if (authPending) {
        authPending = resumingLogin = false;
        controls();
        if (data.code === "login_invalid") {
          accountError("用户名或密码有误，请检查后重试。");
          $("account-password").focus();
        } else if (data.code === "invite_invalid") {
          accountError("注册码无效或已使用，请核对或重新领取。", "invite-code");
        } else if (data.code === "name_taken") {
          accountError("该用户名已被使用，请换一个。", "account-name");
        } else {
          accountError(data.message);
        }
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
    const interruptedLogin = authPending && !resumingLogin;
    clearInterval(heartbeatTimer);
    for (const item of roomPending()) failChat(item, "连接中断；恢复后可重试。");
    joined = false;
    pending = false;
    account = null;
    authPending = resumingLogin = false;
    // 1、2、4…秒指数退避，加入随机抖动，最终等待不超过 15 秒。
    const base = Math.min(15000, 1000 * 2 ** Math.min(attempts++, 5));
    const delay = Math.min(15000, base * (0.8 + Math.random() * 0.4));
    connection(`连接中断，${Math.ceil(delay / 1000)} 秒后重试`);
    if (interruptedLogin) accountError("连接中断。恢复连接后，请重新提交。");
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
  const savedDetached =
    !authRequired && type === "join" ? detachedTokens[room] : null;
  const resumeToken =
    savedDetached && savedDetached.nickname === nickname
      ? savedDetached.token
      : undefined;
  if (
    !send({
      type,
      ...(authRequired ? {} : { nickname }),
      ...(type === "join" ? { room } : {}),
      ...(resumeToken ? { token: resumeToken } : {}),
    })
  ) {
    pending = false;
    notice("连接尚未恢复，请稍后重试。");
  }
  controls();
}
function clearAccountError() {
  const field = $("account-fields").querySelector('[aria-invalid="true"]');
  if (!field) return;
  field.removeAttribute("aria-invalid");
  field.removeAttribute("aria-describedby");
}
function accountError(message, fieldId) {
  clearAccountError();
  notice(message);
  if (!fieldId) return;
  const field = $(fieldId);
  field.setAttribute("aria-invalid", "true");
  field.setAttribute("aria-describedby", "account-notice");
  field.focus();
}
function revealPassword(revealed) {
  $("account-password").type = revealed ? "text" : "password";
  const button = $("account-show-password");
  button.querySelector('[data-icon="eye"]').hidden = revealed;
  button.querySelector('[data-icon="eye-off"]').hidden = !revealed;
  button.setAttribute("aria-label", revealed ? "隐藏密码" : "显示密码");
}
function applyRegistrationPolicy() {
  $("email-register").hidden = !registering || !emailRegistration;
  $("account-description").textContent = !registering
    ? "使用同行账号创建或加入临时房间。"
    : emailRegistration
      ? "使用邮箱领取注册码，或直接填写组织者提供的注册码。"
      : "使用组织者提供的一次性注册码。";
}
async function loadRegistrationPolicy() {
  const policySocket = socket;
  let enabled = false;
  if (authRequired) {
    try {
      const response = await fetch("/api/register/policy");
      if (response.ok) {
        const policy = await response.json();
        enabled = policy.email_registration === true;
      }
    } catch (_) {
      // 未启用邮箱注册服务时，仍可使用组织者发放的注册码。
    }
  }
  if (socket !== policySocket) return;
  emailRegistration = enabled;
  applyRegistrationPolicy();
}
$("send-register-code").addEventListener("click", async () => {
  const button = $("send-register-code");
  if (!registering || !emailRegistration || button.disabled) return;
  const field = $("register-email");
  const email = field.value.trim();
  if (!email || field.validity.typeMismatch) {
    accountError("请输入有效的邮箱地址。", "register-email");
    return;
  }

  clearAccountError();
  notice();
  button.disabled = true;
  let feedback;
  try {
    const response = await fetch("/api/register/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await response.json().catch(() => ({}));
    feedback = response.ok
      ? "如果该邮箱可以注册，验证码会发到邮箱。"
      : data.error || "注册码未能发出。";
  } catch (_) {
    feedback = "注册码未能发出。";
  } finally {
    button.disabled = false;
  }
  if (registering && emailRegistration && !authPending &&
      $("account-notice").hidden && field.value.trim() === email) {
    notice(feedback);
  }
});
function setAccountMode(signup) {
  registering = signup;
  $("account-title").textContent = signup ? "注册账号" : "登录";
  applyRegistrationPolicy();
  $("account-switch-label").textContent = signup ? "已有账号？" : "没有账号？";
  $("account-toggle").textContent = signup ? "返回登录" : "使用注册码注册";
  $("invite-field").hidden = !signup;
  $("invite-code").required = signup;
  $("account-password").autocomplete = signup ? "new-password" : "current-password";
  $("account-password").value = "";
  clearAccountError();
  revealPassword(false);
  controls();
}
$("account-toggle").addEventListener("click", () => {
  setAccountMode(!registering);
  notice();
  $("account-name").focus();
});
$("account-show-password").addEventListener("click", () => {
  revealPassword($("account-password").type === "password");
});
$("account-form").addEventListener("input", () => {
  clearAccountError();
  if (!$("account-notice").hidden) notice();
});
$("account-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if ($("account-submit").disabled) return;
  if (location.protocol !== "https:") {
    notice("请通过 HTTPS 登录。");
    return;
  }
  const name = $("account-name").value.trim();
  if (!/^[a-z0-9_]{3,24}$/.test(name)) {
    accountError("用户名需要 3–24 位小写字母、数字或下划线。", "account-name");
    return;
  }
  const password = $("account-password").value;
  const passwordBytes = bytes(password);
  if (passwordBytes < 8 || passwordBytes > 128) {
    accountError("密码需要 8–128 个字节。", "account-password");
    return;
  }
  const request = { type: registering ? "register" : "login", name, password };
  if (registering) {
    const code = $("invite-code").value.trim();
    if (!/^[a-f0-9]{32}$/i.test(code)) {
      accountError("请输入完整的 32 位注册码。", "invite-code");
      return;
    }
    request.invite = code.toLowerCase();
    const emailField = $("register-email");
    const email = emailField.value.trim();
    if (emailRegistration && email) {
      if (emailField.validity.typeMismatch) {
        accountError("请输入有效的邮箱地址。", "register-email");
        return;
      }
      request.email = email;
    }
  }
  clearAccountError();
  notice();
  authPending = send(request);
  if (authPending) {
    $("account-password").value = "";
    revealPassword(false);
  }
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
  if (!joined || !session) return;
  const draft = $("message").value;
  const clientId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  const msgData = { type: "chat", text, nickname: session.nickname, client_id: clientId };
  if (activeReply) {
    msgData.reply_to = activeReply.nickname;
    msgData.reply_text = activeReply.text;
  }
  const item = { scope: deliveryScope(), data: msgData, state: "sending" };
  pendingChats.set(clientId, item);
  if (transmitChat(item)) {
    if (text.includes("@行程助手")) {
      if (itineraryOwner) invokeRequested = true;
      else notice("只有房主可以触发行程草稿。");
    }
    scrollToLatest();
    if ($("message").value === draft) $("message").value = "";
    clearReply();
    hideBotMention();
    draftChanged();
    showExpressions(false);
    notice();
    $("message").focus({ preventScroll: true });
  }
});
$("message").addEventListener("input", () => {
  draftChanged();
  updateBotMention();
});
window.addEventListener("resize", resizeDraft);
$("message").addEventListener("keydown", (event) => {
  if (mentionRange && !event.isComposing && !event.shiftKey) {
    if (event.key === "Escape") {
      event.preventDefault();
      hideBotMention();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (mentionCandidates.length) {
        mentionIndex =
          (mentionIndex + (event.key === "ArrowDown" ? 1 : -1) + mentionCandidates.length) %
          mentionCandidates.length;
        renderMentionPicker();
      }
      return;
    }
    if (event.key === "Tab" || event.key === "Enter") {
      event.preventDefault();
      insertBotMention();
      return;
    }
  }
  if (event.key === "Escape" && activeReply) {
    event.preventDefault();
    clearReply();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$("send").disabled) $("message-form").requestSubmit();
  }
});
const leaveDialog = $("leave-dialog");
function closeLeaveDialog() {
  if (!leaveDialog) return;
  if (typeof leaveDialog.close === "function" && leaveDialog.open) leaveDialog.close();
  else leaveDialog.open = false;
}
function openLeaveDialog(others, scheduled) {
  const hasOthers = others.length > 0;
  const select = $("transfer-select");
  select.replaceChildren(...others.map((name) => new Option(name, name)));
  $("leave-transfer-group").hidden = !hasOthers;
  $("leave-transfer-confirm").hidden = !hasOthers;
  $("leave-dialog-scheduled").textContent = scheduled;
  $("leave-dialog-scheduled").hidden = !scheduled;
  if (typeof leaveDialog.showModal === "function") {
    if (!leaveDialog.open) leaveDialog.showModal();
  } else {
    leaveDialog.open = true;
  }
}
$("leave-dialog-close")?.addEventListener("click", closeLeaveDialog);
$("leave-cancel")?.addEventListener("click", closeLeaveDialog);
$("leave-detach-confirm")?.addEventListener("click", () => {
  closeLeaveDialog();
  if (send({ type: "detach" })) {
    leavingRoom = true;
    $("leave").disabled = true;
  }
});
$("leave-transfer-confirm")?.addEventListener("click", () => {
  const target = $("transfer-select").value;
  if (!target) return;
  closeLeaveDialog();
  if (send({ type: "leave", transfer: target })) {
    leavingRoom = true;
    $("leave").disabled = true;
  }
});
$("leave-close-confirm")?.addEventListener("click", () => {
  closeLeaveDialog();
  if (send({ type: "close" })) {
    leavingRoom = true;
    $("leave").disabled = true;
  }
});
$("leave").addEventListener("click", () => {
  const scheduled = $("notice-publish-open").hidden ? "" : "已排期的通知仍会发送。";
  if (itineraryOwner) {
    const others = roomMembers.filter((name) => name !== session?.nickname);
    if (leaveDialog) {
      openLeaveDialog(others, scheduled);
      return;
    }
    if (!confirm(`你是房主。确认暂时离开房间（保留房主，不关闭房间）？${scheduled}`))
      return;
    if (send({ type: "detach" })) {
      leavingRoom = true;
      $("leave").disabled = true;
    }
    return;
  }
  if (send({ type: "leave" })) {
    leavingRoom = true;
    $("leave").disabled = true;
  }
});
function requestExtendRoom() {
  if (!joined || !itineraryOwner) return;
  send({ type: "extend" });
}
$("extend-room")?.addEventListener("click", requestExtendRoom);
$("expiry-banner-extend")?.addEventListener("click", requestExtendRoom);
$("close-room").addEventListener("click", () => {
  const scheduled = $("notice-publish-open").hidden ? "" : "已排期的通知仍会发送。";
  if (confirm(`关闭后所有成员都会退出，加入码立即失效。${scheduled}确认关闭？`))
    leavingRoom = send({ type: "close" });
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
function closeItinerary() {
  $("itinerary-panel").hidden = true;
  $("itinerary-toggle").setAttribute("aria-expanded", "false");
  resizeDraft();
}
$("itinerary-toggle").addEventListener("click", () => {
  if ($("itinerary-panel").hidden) openItinerary();
  else closeItinerary();
});
$("itinerary-close").addEventListener("click", () => {
  closeItinerary();
  $("itinerary-toggle").focus();
});
$("pinned-itinerary").addEventListener("click",openItinerary);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.defaultPrevented && !$("itinerary-panel").hidden) closeItinerary();
});
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
      $("export-itinerary-ics").hidden = !current || !/^\d{4}-\d{2}-\d{2}$/.test(current?.data?.date || "");
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

const botMention = "@群聊助手";
let mentionRange = null;
let mentionCandidates = [];
let mentionIndex = 0;

function hideBotMention() {
  mentionRange = null;
  mentionCandidates = [];
  mentionIndex = 0;
  $("bot-mention-picker").hidden = true;
}

function buildMentionCandidates(query) {
  const q = query.toLowerCase();
  const list = [];
  if (assistantEnabled) {
    list.push({ label: "@群聊助手", role: "AI 助手" });
    if (itineraryOwner) list.push({ label: "@行程助手", role: "提取行程" });
  }
  for (const name of roomMembers) {
    if (session && name === session.nickname) continue;
    list.push({
      label: "@" + name,
      role: name === roomOwnerName ? "房主" : "成员",
    });
  }
  return list.filter((item) => item.label.slice(1).toLowerCase().includes(q));
}

function renderMentionPicker() {
  const picker = $("bot-mention-picker");
  picker.replaceChildren(
    ...mentionCandidates.map((item, idx) => {
      const btn = document.createElement("button");
      if (idx === 0) btn.id = "bot-mention-option";
      btn.type = "button";
      btn.className = `secondary mention-btn${idx === mentionIndex ? " active" : ""}`;
      const label = document.createElement("span");
      label.textContent = item.label;
      const role = document.createElement("small");
      role.className = "mention-role";
      role.textContent = item.role;
      btn.append(label, role);
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        mentionIndex = idx;
        insertBotMention();
      });
      return btn;
    }),
  );
  picker.hidden = !mentionCandidates.length;
}

function updateBotMention() {
  const input = $("message");
  const end = input.selectionStart;
  const match = /(?:^|[\s，：、])([@＠][^\s@＠]*)$/.exec(input.value.slice(0, end));
  if (!joined || !match) {
    hideBotMention();
    return;
  }
  const candidates = buildMentionCandidates(match[1].slice(1));
  if (!candidates.length) {
    hideBotMention();
    return;
  }
  mentionRange = [end - match[1].length, end];
  mentionCandidates = candidates;
  if (mentionIndex >= candidates.length) mentionIndex = 0;
  renderMentionPicker();
}

function insertBotMention() {
  if (!mentionRange || !mentionCandidates.length) return;
  const chosen = mentionCandidates[mentionIndex] || mentionCandidates[0];
  const input = $("message");
  input.setRangeText(chosen.label + " ", ...mentionRange, "end");
  hideBotMention();
  draftChanged();
  input.focus();
}
$("bot-mention-option")?.addEventListener("click", insertBotMention);

/* 到期前一键导出：.md 聊天记录 & .ics 系统日历 */
function downloadTextFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(name) {
  return String(name || "同行房间").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "同行房间";
}

function exportChatMarkdown() {
  if (!joined || !session) return;
  const roomTitle = $("room-name").textContent || "同行房间";
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const lines = [
    `# ${roomTitle}`,
    "",
    `- 房间码：\`${session.room}\``,
    `- 导出时间：${now.toLocaleString("zh-CN", { hour12: false })}`,
  ];
  if (roomExpiresAt) {
    lines.push(`- 房间到期：${new Date(roomExpiresAt * 1000).toLocaleString("zh-CN", { hour12: false })}`);
  }
  if (itineraryData?.data) {
    const d = itineraryData.data;
    lines.push("", `## 行程摘要（v${itineraryData.version}）`, "");
    for (const [k, label] of Object.entries(itineraryFields)) {
      const v = d[k];
      if (v && v !== pendingTripValue) lines.push(`- **${label}**：${v}`);
    }
  }
  lines.push("", "## 聊天记录", "");
  for (const node of messageList.children) {
    if (node.classList.contains("chat-message")) {
      const sender = node.dataset.sender || "未知成员";
      const t = node.querySelector(".message-meta time")?.textContent || "";
      const body = node.querySelector(".message-text")?.textContent || "";
      const qTo = node.dataset.replyTo;
      const qText = node.dataset.replyText;
      lines.push(`### ${sender}${t ? `（${t}）` : ""}`);
      if (qTo && qText) lines.push(`> 回复 ${qTo}：${qText}`, "");
      lines.push(body, "");
    } else if (node.classList.contains("important-notice-card")) {
      const h = node.querySelector("h3")?.textContent || "重要通知";
      const p = node.querySelector("p")?.textContent || "";
      lines.push(`> **[重要通知] ${h}**`, `> ${p.replace(/\n/g, "\n> ")}`, "");
    }
  }
  downloadTextFile(
    `${safeFilename(roomTitle)}-聊天记录-${ymd}.md`,
    lines.join("\n"),
    "text/markdown;charset=utf-8",
  );
  notice("已导出聊天记录 (.md)。");
}
$("export-chat")?.addEventListener("click", exportChatMarkdown);

function icsEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function icsStamp(dateStr, timeStr, fallbackHour = 9, addHours = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  if (!m) return null;
  let hh = fallbackHour;
  let mm = 0;
  const tm = /^(\d{2}):(\d{2})/.exec(timeStr || "");
  if (tm) {
    hh = Number(tm[1]);
    mm = Number(tm[2]);
  }
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh + addHours, mm, 0));
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}T${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}00`;
}

function exportItineraryICS() {
  if (!itineraryData?.data) return;
  const d = itineraryData.data;
  const start = icsStamp(d.date, d.meeting_time, 9, 0);
  if (!start) {
    itineraryNotice("行程缺少有效日期，无法导出日历。");
    return;
  }
  const end =
    (/^\d{2}:\d{2}/.test(d.regroup_time || "") && icsStamp(d.date, d.regroup_time, 11, 0)) ||
    icsStamp(d.date, d.meeting_time, 9, 2);
  const roomTitle = $("room-name").textContent || "同行行程";
  const dest = d.destination && d.destination !== pendingTripValue ? d.destination : roomTitle;
  const loc = d.meeting_place && d.meeting_place !== pendingTripValue ? d.meeting_place : "";
  const descParts = [];
  for (const [k, label] of Object.entries(itineraryFields)) {
    const v = d[k];
    if (v && v !== pendingTripValue) descParts.push(`${label}：${v}`);
  }
  const nowUtc = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const uid = `${session?.room || "trip"}-v${itineraryData.version}-${Date.now()}@tongxing.local`;
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TongXing//Temporary Room Chat//ZH",
    "CALSCALE:GREGORIAN",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Shanghai",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0800",
    "TZOFFSETTO:+0800",
    "TZNAME:CST",
    "DTSTART:19700101T000000",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${nowUtc}`,
    `DTSTART;TZID=Asia/Shanghai:${start}`,
    `DTEND;TZID=Asia/Shanghai:${end}`,
    `SUMMARY:${icsEscape(`${roomTitle} · ${dest}`)}`,
    ...(loc ? [`LOCATION:${icsEscape(loc)}`] : []),
    `DESCRIPTION:${icsEscape(descParts.join("\n"))}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(`集合提醒：${dest}`)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  downloadTextFile(
    `${safeFilename(roomTitle)}-行程v${itineraryData.version}.ics`,
    ics,
    "text/calendar;charset=utf-8",
  );
  itineraryNotice("已导出日历文件 (.ics)，打开即可添加到系统日历。");
}
$("export-itinerary-ics")?.addEventListener("click", exportItineraryICS);

const noticeDialog = $("notice-dialog");
const noticeCards = new Map();
const noticeSendCode = $("notice-send-code");
let noticeView = "", noticeBusy = false, noticeRequestId = "";
let noticeCodeReadyAt = 0;
let noticeCodeTimer;

function renderNoticeCodeButton() {
  clearTimeout(noticeCodeTimer);
  const seconds = Math.max(0, Math.ceil((noticeCodeReadyAt - Date.now()) / 1000));
  noticeSendCode.textContent = seconds ? `${seconds} 秒后重发` : "发送验证码";
  noticeSendCode.disabled = noticeBusy || seconds > 0;
  if (seconds && noticeDialog.open && noticeView === "contact") {
    noticeCodeTimer = setTimeout(renderNoticeCodeButton, 1000);
  }
}

function setNoticeCodeCooldown(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0) return;
  noticeCodeReadyAt = Date.now() + seconds * 1000;
  renderNoticeCodeButton();
}

function displayNoticeCard(data, page) {
  let card = noticeCards.get(data.id);
  if (card && Number(card.dataset.revision) >= data.revision) return;
  const isNew = !card;
  if (isNew) {
    card = document.createElement("article");
    card.className = "important-notice-card";
    noticeCards.set(data.id, card);
  }
  card.dataset.revision = data.revision;
  const tag = document.createElement("small");
  tag.textContent = data.status === "cancelled" ? "重要通知 · 已撤销" : "重要通知";
  const title = document.createElement("h3");
  title.textContent = data.title;
  const body = document.createElement("p");
  body.textContent = data.text;
  const timing = document.createElement("small");
  if (data.status !== "cancelled") timing.textContent = "邮件排期 " + shanghaiTime(Date.parse(data.due) / 1000);
  card.replaceChildren(tag, title, body, timing);
  if (isNew) {
    if (page) page.append(card);
    else appendMessage(card, true);
  }
}

async function noticeAPI(action, payload, room = false) {
  const token = loginToken;
  if (!token || !account) throw new Error("请先登录账号");
  const headers = { Authorization: "Bearer " + token };
  if (payload) headers["Content-Type"] = "application/json";
  if (room) headers["X-Room-Token"] = assistantToken;
  const response = await fetch("/api/notices/" + action, {
    method: payload ? "POST" : "GET",
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (token !== loginToken) throw new Error("账号已切换");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || "通知服务暂不可用"), {
      status: response.status,
      retryAfter: data.retry_after,
    });
  }
  return data;
}

function noticeStatus(text = "") {
  $("notice-dialog-status").textContent = text;
  $("notice-dialog-status").hidden = !text;
}

async function runNotice(action) {
  if (noticeBusy) return;
  noticeBusy = true;
  renderNoticeCodeButton();
  noticeStatus();
  noticeDialog.setAttribute("aria-busy", "true");
  try {
    await action();
  } catch (error) {
    if (noticeDialog.open) noticeStatus(error.message);
  } finally {
    noticeBusy = false;
    renderNoticeCodeButton();
    noticeDialog.removeAttribute("aria-busy");
  }
}

function shanghaiInput(timestamp) {
  const fixedOffset = 8 * 60 * 60 * 1000;
  return new Date(timestamp + fixedOffset).toISOString().slice(0, 16);
}

async function refreshCoverage() {
  $("notice-publish").disabled = true;
  $("notice-coverage").textContent = "正在统计覆盖人数…";
  try {
    const counts = await noticeAPI("preview", {}, true);
    $("notice-coverage").textContent = `房间 ${counts.members} 人 · 邮件 ${counts.recipients} 人 · 暂无可用邮箱 ${counts.members - counts.recipients} 人`;
    $("notice-publish").disabled = false;
  } catch (error) {
    $("notice-coverage").textContent = "";
    throw error;
  }
}

async function refreshContact() {
  const contact = await noticeAPI("contact");
  setNoticeCodeCooldown(contact.retry_after);
  $("notice-contact-current").textContent = contact.email ? "已绑定 " + contact.email : "尚未绑定通知邮箱";
  $("notice-contact-local").hidden = !contact.local_only;
  $("notice-unbind").hidden = !contact.email;
  $("notice-code-form").hidden = Boolean(contact.email) && !contact.verification_pending;
  const eligibleEmail = contact.email ? "" : (contact.registration_email || "");
  $("notice-registration-address").textContent = eligibleEmail;
  $("notice-registration-contact").hidden = !eligibleEmail;
}

const deliveryLabels = {
  pending: "待发送",
  sending: "发送中",
  sent: "邮件服务器已接受",
  failed: "发送失败",
  uncertain: "结果待确认",
  cancelled: "已撤销",
  skipped: "已跳过",
};

function manageNotice(item) {
  const form = document.createElement("form");
  form.className = "notice-form";
  const label = document.createElement("label");
  const time = document.createElement("input");
  time.type = "datetime-local";
  time.value = item.due.slice(0, 16);
  time.required = true;
  time.id = "due-" + item.id;
  label.htmlFor = time.id;
  label.textContent = "新发送时间（北京时间）";
  const actions = document.createElement("div");
  actions.className = "form-actions";
  const reschedule = document.createElement("button");
  reschedule.className = "secondary";
  reschedule.type = "submit";
  reschedule.textContent = "保存改期";
  const cancel = document.createElement("button");
  cancel.className = "secondary";
  cancel.type = "button";
  cancel.textContent = "撤销通知";
  actions.append(reschedule, cancel);
  form.append(label, time, actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    runNotice(async () => {
      await noticeAPI("reschedule", { id: item.id, due: time.value });
      await refreshMine();
      noticeStatus("已更新发送时间。");
    });
  });
  cancel.addEventListener("click", () => {
    if (!confirm("撤销这条通知？待发邮件将取消。")) return;
    runNotice(async () => {
      await noticeAPI("cancel", { id: item.id });
      await refreshMine();
      noticeStatus("已撤销通知。");
    });
  });
  return form;
}

async function refreshMine() {
  const data = await noticeAPI("mine");
  if (!data.notices.length) {
    $("notice-list").textContent = "你还没有发布过重要通知。";
    return;
  }
  $("notice-list").replaceChildren(...data.notices.map((item) => {
    const card = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = item.title;
    const body = document.createElement("p");
    body.className = "notice-list-body";
    body.textContent = item.body;
    const timing = document.createElement("p");
    timing.className = "field-hint";
    const due = Date.parse(item.due);
    timing.textContent = `${item.room_name} · ${shanghaiTime(due / 1000)}`;
    const delivery = document.createElement("p");
    delivery.className = "field-hint";
    const counts = Object.entries(item.deliveries).map(([status, total]) => `${deliveryLabels[status]} ${total}`);
    if (item.status === "cancelled" && !item.recipients) counts.push("已撤销");
    if (!item.recipients) counts.push("无邮件收件人");
    if (item.members > item.recipients) counts.push(`发布时未覆盖 ${item.members - item.recipients} 人`);
    delivery.textContent = counts.join(" · ");
    card.append(title, body, timing, delivery);
    if (item.status === "scheduled" && due > Date.now()) card.append(manageNotice(item));
    return card;
  }));
}

function openNotice(view) {
  if (noticeBusy) return;
  noticeView = view;
  const titles = { publish: "发布重要通知", contact: "通知邮箱", mine: "我发布的通知" };
  $("notice-dialog-title").textContent = titles[view];
  $("notice-compose").hidden = view !== "publish";
  $("notice-contact").hidden = view !== "contact";
  $("notice-mine").hidden = view !== "mine";
  if (!noticeDialog.open) noticeDialog.showModal();
  if (view === "publish") {
    if (!noticeRequestId) {
      noticeRequestId = crypto.randomUUID().replace(/-/g, "");
      $("notice-due").value = shanghaiInput(Date.now() + 5 * 60 * 1000);
    }
    runNotice(refreshCoverage);
  } else if (view === "contact") {
    $("notice-contact-current").textContent = "正在读取绑定状态…";
    $("notice-registration-address").textContent = "";
    $("notice-registration-contact").hidden = true;
    $("notice-code-form").hidden = true;
    $("notice-code").value = "";
    runNotice(refreshContact);
  } else {
    $("notice-list").textContent = "正在读取发送进度…";
    runNotice(refreshMine);
  }
}

function resetNoticeDraft() {
  noticeRequestId = "";
  $("notice-compose").reset();
}

$("notice-dialog-close").addEventListener("click", () => noticeDialog.close());
noticeDialog.addEventListener("close", renderNoticeCodeButton);
$("notice-publish-open").addEventListener("click", () => openNotice("publish"));
$("notice-room-contact").addEventListener("click", () => openNotice("contact"));
$("notice-contact-open").addEventListener("click", () => openNotice("contact"));
$("notice-mine-open").addEventListener("click", () => openNotice("mine"));
$("notice-preview").addEventListener("click", () => runNotice(refreshCoverage));
$("notice-refresh").addEventListener("click", () => runNotice(refreshMine));
$("notice-compose").addEventListener("submit", (event) => {
  event.preventDefault();
  const payload = {
    title: $("notice-title").value.trim(),
    body: $("notice-body").value.trim(),
    due: $("notice-due").value,
    request_id: noticeRequestId,
  };
  runNotice(async () => {
    await noticeAPI("publish", payload, true);
    resetNoticeDraft();
    if (noticeDialog.open) noticeDialog.close();
    if (joined) notice("重要通知已发布并排期。");
  });
});
$("notice-email-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (noticeSendCode.disabled) return;
  runNotice(async () => {
    try {
      const result = await noticeAPI("send-code", { email: $("notice-email").value.trim() });
      setNoticeCodeCooldown(result.retry_after);
    } catch (error) {
      setNoticeCodeCooldown(error.retryAfter);
      if (error.status === 429 && error.retryAfter > 0) {
        await refreshContact();
        return;
      }
      throw error;
    }
    noticeStatus("验证码已发送，请查看收件箱。");
    $("notice-code-form").hidden = false;
    $("notice-code").focus();
  });
});
$("notice-code-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if ($("notice-code-form").hidden) return;
  runNotice(async () => {
    await noticeAPI("verify", { code: $("notice-code").value.trim() });
    $("notice-code-form").reset();
    $("notice-code-form").hidden = true;
    await refreshContact();
    noticeStatus("邮箱已验证并绑定。");
  });
});
$("notice-use-registration-email").addEventListener("click", () => {
  if ($("notice-registration-contact").hidden) return;
  runNotice(async () => {
    await noticeAPI("use-registration-email", {});
    $("notice-code-form").hidden = true;
    await refreshContact();
    noticeStatus("已绑定注册邮箱。");
  });
});
$("notice-unbind").addEventListener("click", () => {
  if (!confirm("解绑邮箱后，此账号待发送的重要通知邮件会取消。确认解绑？")) return;
  runNotice(async () => {
    await noticeAPI("unbind", {});
    await refreshContact();
    noticeStatus("邮箱已解绑。");
  });
});
connect();
