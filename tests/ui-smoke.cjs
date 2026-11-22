// DOM-level integration test, NOT a visual/browser automation test.
const { JSDOM, VirtualConsole } = require("jsdom");
const WS = require("ws");
const fs = require("fs");
const assert = require("node:assert/strict");
const root = require("node:path").resolve(__dirname, "..");
const html = fs.readFileSync(root + "/web/index.html", "utf8");
const js = fs.readFileSync(root + "/web/app.js", "utf8");
const errors = [];
const sockets = [];
function client() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(e));
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:8080",
    runScripts: "outside-only",
    virtualConsole,
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.ResizeObserver = class {
    observe() {}
  };
  w.TextEncoder = TextEncoder;
  w.WebSocket = class extends WS {
    constructor(...args) {
      super(...args);
      sockets.push(this);
      this.addEventListener("message", (e) => {
        if (JSON.parse(e.data).type === "joined")
          w._joined = (w._joined || 0) + 1;
      });
    }
  };
  w.confirm = () => true;
  w.prompt = () => "周末灵感室";
  w.eval(js);
  return dom;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await pause(30);
  }
  throw Error("timeout: " + label);
}
const get = (d, id) => d.window.document.getElementById(id);
const click = (d, id) => get(d, id).click();
async function main() {
  const a = client(),
    b = client();
  try {
    await until(
      () => !get(a, "lobby").hidden && !get(b, "lobby").hidden,
      "lobbies",
    );
    assert.equal(get(a, "loading-panel").hidden, true);
    get(a, "nickname").value = "林间";
    click(a, "create");
    await until(() => !get(a, "room-view").hidden, "create");
    const room = get(a, "room-id").textContent;
    assert.match(room, /^[A-Z0-9]{6}$/);
    assert.equal(get(a, "room-recent-list").children.length, 1);
    click(a, "rename");
    await until(
      () => get(a, "room-name").textContent === "周末灵感室",
      "rename",
    );
    get(b, "nickname").value = "小雨";
    get(b, "room-code").value = room;
    get(b, "entry-form").dispatchEvent(
      new b.window.Event("submit", { cancelable: true, bubbles: true }),
    );
    await until(
      () =>
        get(a, "member-count").textContent === "2" &&
        !get(b, "room-view").hidden,
      "join",
    );
    assert.equal(get(a, "members").children.length, 2);
    assert.equal(
      get(a, "members").querySelector(".member-self").textContent,
      "你",
    );
    const payload = "<img src=x onerror=alert(1)> 你好，真实服务器！";
    get(a, "message").value = payload;
    get(a, "message").dispatchEvent(new a.window.Event("input"));
    click(a, "send");
    await until(
      () =>
        get(b, "messages").querySelector(".message-text")?.textContent ===
        payload,
      "real broadcast",
    );
    assert.equal(get(a, "messages").querySelectorAll("article.own").length, 1);
    assert.equal(get(b, "messages").querySelectorAll("article.own").length, 0);
    assert.equal(get(b, "messages").querySelectorAll("img").length, 0);
    assert.equal(get(a, "message").value, "");
    assert.equal(get(a, "send").disabled, true);
    sockets[1].close();
    await until(
      () =>
        b.window._joined === 2 &&
        get(b, "status").classList.contains("connected") &&
        get(b, "messages").querySelector(".message-text")?.textContent ===
          payload,
      "reconnect replay",
    );
    click(b, "expression-toggle");
    assert.equal(get(b, "expression-options").hidden, false);
    get(b, "sticker-options").firstElementChild.click();
    await until(
      () => get(a, "messages").querySelector(".sticker-message"),
      "sticker",
    );
    get(a, "theme").value = "dark";
    get(a, "theme").dispatchEvent(new a.window.Event("change"));
    assert.equal(a.window.document.documentElement.dataset.theme, "dark");
    get(a, "theme").value = "light";
    get(a, "theme").dispatchEvent(new a.window.Event("change"));
    assert.equal(a.window.document.documentElement.dataset.theme, "light");
    click(b, "room-info");
    assert.equal(get(b, "room-info").getAttribute("aria-expanded"), "true");
    click(b, "leave");
    await until(
      () =>
        !get(b, "lobby").hidden && get(a, "member-count").textContent === "1",
      "leave",
    );
    get(b, "room-recent-list").querySelector("button").click();
    assert.equal(get(b, "room-code").value, room);
    get(a, "room-search").value = "no-match";
    get(a, "room-search").dispatchEvent(new a.window.Event("input"));
    assert.equal(get(a, "room-recent-list").firstElementChild.hidden, true);
    click(a, "close-room");
    await until(() => !get(a, "lobby").hidden, "close");
    assert.equal(errors.length, 0, errors.map((e) => e.message).join("\n"));
    console.log(
      "PASS DOM + real WS: lobby/create/rename/join/members/send/XSS-text/sticker/reconnect-replay/themes/info/leave/recent-search/close, no runtime errors",
    );
  } finally {
    for (const socket of sockets) {
      socket.onclose = null;
      socket.close();
    }
    for (const d of [a, b]) {
      d.window.close();
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
