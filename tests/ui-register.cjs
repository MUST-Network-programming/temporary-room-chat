// DOM check for the opt-in email registration form. No browser and no real SMTP.
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const assert = require("node:assert/strict");
const root = require("node:path").resolve(__dirname, "..");
const html = fs.readFileSync(root + "/web/index.html", "utf8");
const js = fs.readFileSync(root + "/web/app.js", "utf8");

function page(policy) {
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
      } else if (message.type === "register") {
        setTimeout(() => this.onmessage({
          data: JSON.stringify({ type: "authenticated", name: message.name, token: "ab".repeat(32) }),
        }), 0);
      }
    }
    close() { this.readyState = Socket.CLOSED; }
  }
  window.WebSocket = Socket;
  window.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("/api/register/policy")) {
      return { ok: true, status: 200, json: async () => policy };
    }
    if (String(url).includes("/api/register/code")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, code: "SHOULD_NOT_RENDER" }),
      };
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
const invite = "ab".repeat(16);

function submitAccount(client, name) {
  get(client.dom, "account-name").value = name;
  get(client.dom, "account-password").value = "email-pass-2026";
  get(client.dom, "invite-code").value = invite;
  get(client.dom, "account-form").dispatchEvent(new client.dom.window.Event("submit", {
    bubbles: true, cancelable: true,
  }));
}

(async () => {
  const enabled = page({ email_registration: true, local_only: true });
  const disabled = page({ email_registration: false, local_only: true });
  const manual = page({ email_registration: true, local_only: true });
  try {
    await until(() => get(enabled.dom, "account-panel").hidden === false, "account panel");
    get(enabled.dom, "account-toggle").click();
    await until(() => get(enabled.dom, "email-register").hidden === false, "email form");
    assert.equal(get(disabled.dom, "email-register").hidden, true);
    get(disabled.dom, "account-toggle").click();
    await pause(50);
    assert.equal(get(disabled.dom, "email-register").hidden, true);
    get(enabled.dom, "register-email").value = "person@example.test";
    get(enabled.dom, "send-register-code").click();
    await until(() => get(enabled.dom, "account-notice").textContent.includes("验证码会发到邮箱"), "sent notice");
    assert.equal(enabled.dom.window.document.body.textContent.includes("SHOULD_NOT_RENDER"), false);
    const posted = enabled.requests.find((item) => item.url.includes("/api/register/code"));
    assert.deepEqual(JSON.parse(posted.options.body), { email: "person@example.test" });
    submitAccount(enabled, "mailuser");
    await until(() => get(enabled.dom, "account-panel").hidden === true, "registered");
    const registration = enabled.sockets[0].sent.find((message) => message.type === "register");
    assert.equal(registration.email, "person@example.test");
    assert.equal(registration.invite, invite);
    assert.equal(get(enabled.dom, "account-notice").textContent.includes(invite), false);
    assert.equal(enabled.requests.some(item => item.url.includes("/api/notices/")), false);
    await until(() => get(manual.dom, "account-panel").hidden === false, "manual signup panel");
    get(manual.dom, "account-toggle").click();
    await until(() => get(manual.dom, "email-register").hidden === false, "optional email field");
    for (const [client, name] of [[manual, "manual"], [disabled, "disabled"]]) {
      submitAccount(client, name);
      await until(() => get(client.dom, "account-panel").hidden === true, "registered by organizer code");
      const message = client.sockets[0].sent.find(item => item.type === "register");
      assert.equal(message.invite, invite);
      assert.equal(message.email, undefined);
    }
    assert.equal(enabled.errors.length, 0);
    assert.equal(disabled.errors.length, 0);
    assert.equal(manual.errors.length, 0);
    console.log("PASS registration UI: email signup, organizer invites in both modes, no code exposure or implicit binding");
  } finally {
    enabled.dom.window.close();
    disabled.dom.window.close();
    manual.dom.window.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
