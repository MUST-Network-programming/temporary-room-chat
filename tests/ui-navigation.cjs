const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test: run } = require("node:test");
const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "web/app.js"), "utf8");

function page({ mobile = false, saved, brokenStorage = false } = {}) {
  const errors = [];
  const console = new VirtualConsole();
  console.on("jsdomError", error => errors.push(error));
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:18089/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: console,
  });
  const w = dom.window;
  const media = new Map();
  w.matchMedia = query => {
    if (!media.has(query)) {
      const listeners = [];
      media.set(query, {
        matches: query === "(max-width: 680px)" && mobile,
        addEventListener(type, listener) { listeners.push(listener); },
        change(matches) {
          this.matches = matches;
          for (const listener of listeners) listener({ matches });
        },
      });
    }
    return media.get(query);
  };
  w.ResizeObserver = class { observe() {} };
  w.TextEncoder = TextEncoder;
  let socket;
  w.WebSocket = class {
    static OPEN = 1;
    constructor() { this.readyState = 0; socket = this; }
    send() {}
  };
  w.fetch = async () => ({ ok: true, json: async () => ({ email_registration: false }) });
  if (saved !== undefined) w.localStorage.setItem("temporary-chat-navigation-collapsed", saved);
  w.localStorage.setItem("temporary-chat-recent", JSON.stringify([{ room: "ABC123", name: "周末出游" }]));
  if (brokenStorage) {
    Object.defineProperty(w, "localStorage", { get() { throw new Error("storage unavailable"); } });
  }
  w.eval(script);
  const get = id => w.document.getElementById(id);
  return { dom, w, errors, get, media,
    receive: data => socket.onmessage({ data: JSON.stringify(data) }),
    close: () => w.close() };
}

run("desktop navigation collapses completely and restores the saved preference", () => {
  const p = page();
  let saved;
  try {
    const toggle = p.get("navigation-toggle");
    assert.ok(toggle, "navigation toggle must be available");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    p.get("message").value = "未发送的草稿";
    toggle.click();
    assert.equal(p.get("room-navigation").hidden, true);
    assert.equal(toggle.getAttribute("aria-label"), "展开侧栏");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    saved = p.w.localStorage.getItem("temporary-chat-navigation-collapsed");
    assert.equal(saved, "true");
    assert.equal(p.get("message").value, "未发送的草稿");
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
  const reloaded = page({ saved });
  try {
    assert.equal(reloaded.get("room-navigation").hidden, true);
    reloaded.get("navigation-toggle").click();
    assert.equal(reloaded.get("room-navigation").hidden, false);
    assert.equal(reloaded.w.localStorage.getItem("temporary-chat-navigation-collapsed"), "false");
  } finally { reloaded.close(); }
});

run("mobile drawer starts closed and supports close, backdrop, Escape and keyboard focus", () => {
  const p = page({ mobile: true, saved: "false" });
  try {
    const toggle = p.get("navigation-toggle");
    const nav = p.get("room-navigation");
    const close = p.get("navigation-close");
    assert.equal(nav.hidden, true);
    toggle.click();
    assert.equal(nav.hidden, false);
    assert.equal(nav.getAttribute("aria-modal"), "true");
    assert.equal(p.get("workspace").inert, true);
    assert.equal(p.w.document.activeElement, close);
    close.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(p.w.document.activeElement, nav.querySelector(".recent-button"));
    p.w.document.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(nav.hidden, true);
    assert.equal(p.get("workspace").inert, false);
    assert.equal(p.w.document.activeElement, toggle);
    toggle.click();
    p.get("navigation-backdrop").click();
    assert.equal(nav.hidden, true);
    toggle.click();
    close.click();
    assert.equal(nav.hidden, true);
    assert.equal(p.w.localStorage.getItem("temporary-chat-navigation-collapsed"), "false");
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

run("mobile recent-room selection closes the drawer and fills the room code", () => {
  const p = page({ mobile: true });
  try {
    p.get("navigation-toggle").click();
    p.get("room-recent-list").querySelector("button").click();
    assert.equal(p.get("room-navigation").hidden, true);
    assert.equal(p.get("room-code").value, "ABC123");
    assert.equal(p.w.document.activeElement, p.get("room-code"));
    p.get("navigation-toggle").click();
    p.get("lobby-nav").click();
    assert.equal(p.get("room-navigation").hidden, true);
  } finally { p.close(); }
});

run("viewport changes preserve desktop preference and discard the open mobile drawer", () => {
  const p = page();
  try {
    const compact = p.media.get("(max-width: 680px)");
    p.get("navigation-toggle").click();
    compact.change(true);
    p.get("navigation-toggle").click();
    compact.change(false);
    assert.equal(p.get("room-navigation").hidden, true);
    assert.equal(p.get("workspace").inert, false);
    assert.equal(p.get("room-navigation").hasAttribute("aria-modal"), false);
    p.get("navigation-toggle").click();
    compact.change(true);
    assert.equal(p.get("room-navigation").hidden, true);
    compact.change(false);
    assert.equal(p.get("room-navigation").hidden, false);
  } finally { p.close(); }
});

run("unavailable storage does not prevent navigation from working", () => {
  const p = page({ brokenStorage: true });
  try {
    p.get("navigation-toggle").click();
    assert.equal(p.get("room-navigation").hidden, true);
    p.get("navigation-toggle").click();
    assert.equal(p.get("room-navigation").hidden, false);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

run("login hides the drawer and does not reopen it after authentication", async () => {
  const p = page({ mobile: true });
  try {
    p.get("navigation-toggle").click();
    p.receive({ type: "auth_mode", required: true });
    assert.equal(p.get("navigation-toggle").hidden, true);
    assert.equal(p.get("room-navigation").hidden, true);
    assert.equal(p.get("navigation-backdrop").hidden, true);
    assert.equal(p.get("workspace").inert, false);
    p.receive({ type: "authenticated", name: "traveler", token: "ab".repeat(32) });
    assert.equal(p.get("navigation-toggle").hidden, false);
    assert.equal(p.get("room-navigation").hidden, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
