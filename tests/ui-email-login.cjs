// DOM checks for the email sign-in and account migration form.
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const assert = require("node:assert/strict");
const root = require("node:path").resolve(__dirname, "..");
const html = fs.readFileSync(root + "/web/index.html", "utf8");
const js = fs.readFileSync(root + "/web/app.js", "utf8");

function page() {
  const requests = [];
  const sent = [];
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(html, {
    url: "https://127.0.0.1:8090/",
    runScripts: "outside-only",
    virtualConsole,
    pretendToBeVisual: true,
  });
  const window = dom.window;
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  window.ResizeObserver = class { observe() {} };
  window.TextEncoder = TextEncoder;
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor() {
      this.readyState = Socket.OPEN;
      this.sent = [];
      sent.push(this);
      setTimeout(() => this.onopen && this.onopen(), 0);
    }
    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (message.type === "auth_mode") {
        setTimeout(() => this.onmessage({ data: JSON.stringify({ type: "auth_mode", required: true }) }), 0);
      } else if (message.type === "email_login") {
        setTimeout(() => this.onmessage({
          data: JSON.stringify({ type: "authenticated", name: message.legacy_name || "new_member", token: "ab".repeat(32) }),
        }), 0);
      }
    }
    close() { this.readyState = Socket.CLOSED; }
  }
  window.WebSocket = Socket;
  window.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url) === "/api/login/code") {
      return { ok: true, status: 200, json: async () => ({ challenge: "ab".repeat(32), retry_after: 60 }) };
    }
    throw new Error("unexpected " + url);
  };
  window.eval(js);
  return { dom, requests, errors, sockets: sent };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 50; i++) {
    if (fn()) return;
    await pause(20);
  }
  throw new Error("timeout " + label);
}
const get = (dom, id) => dom.window.document.getElementById(id);

function checkPasswordToggle(dom) {
  const field = get(dom, "account-password");
  const button = get(dom, "account-show-password");
  const activeIcon = () => button.querySelector("[data-icon]:not([hidden])");
  const sample = "password-preview";
  field.value = sample;

  assert.equal(field.type, "password");
  assert.equal(button.getAttribute("aria-label"), "显示密码");
  assert.equal(activeIcon()?.dataset.icon, "eye");
  assert.equal(activeIcon().querySelector("svg")?.getAttribute("aria-hidden"), "true");
  button.click();
  assert.equal(field.type, "text");
  assert.equal(field.value, sample);
  assert.equal(button.getAttribute("aria-label"), "隐藏密码");
  assert.equal(activeIcon()?.dataset.icon, "eye-off");
  button.click();
  assert.equal(field.type, "password");
  assert.equal(field.value, sample);
  assert.equal(button.getAttribute("aria-label"), "显示密码");
  assert.equal(activeIcon()?.dataset.icon, "eye");
  field.value = "";
}

async function submitAccount(client, migrate) {
  const { dom, requests } = client;
  const field = (id) => get(dom, id);
  const submit = () => field("account-form").dispatchEvent(new dom.window.Event("submit", {
    bubbles: true, cancelable: true,
  }));
  await until(() => !field("account-panel").hidden, "account panel");
  assert.equal(field("legacy-account-fields").hidden, true);
  assert.equal(field("invite-code"), null);
  if (migrate) {
    field("account-toggle").click();
    assert.equal(field("legacy-account-fields").hidden, false);
    checkPasswordToggle(dom);
    field("account-name").value = "old_member";
    field("account-password").value = "legacy-pass-2026";
  }
  field("account-email").value = "Person@example.test";
  submit();
  assert.match(field("account-notice").textContent, /请先发送验证码/);
  field("send-login-code").click();
  await until(() => field("account-notice").textContent.includes("验证码已发送"), "sent notice");
  assert.match(field("send-login-code").textContent, /秒后重发/);
  assert.deepEqual(JSON.parse(requests[0].options.body), { email: "person@example.test" });

  field("login-code").value = "123";
  submit();
  assert.match(field("account-notice").textContent, /六位数字/);
  field("login-code").value = "012345";
  submit();
  await until(() => field("account-panel").hidden, "signed in");
  const message = client.sockets[0].sent.find((item) => item.type === "email_login");
  assert.deepEqual(message, { type: "email_login", challenge: "ab".repeat(32), code: "012345",
    ...(migrate ? { legacy_name: "old_member", legacy_password: "legacy-pass-2026" } : {}) });
  assert.equal(client.errors.length, 0);
}

(async () => {
  const normal = page();
  const legacy = page();
  try {
    await submitAccount(normal, false);
    await submitAccount(legacy, true);
    console.log("PASS email sign-in UI, cooldown, validation and legacy account migration");
  } finally {
    normal.dom.window.close();
    legacy.dom.window.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
