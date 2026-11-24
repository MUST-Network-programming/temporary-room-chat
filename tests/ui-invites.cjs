// Run with NODE_PATH pointing to jsdom and jsqr installed outside the repository.
const { JSDOM } = require('jsdom');
const jsQR = require('jsqr');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
function page(hash = '#room=ABC123', { clipboard = true, encoder = true, app = false, email = false } = {}) {
  const dom = new JSDOM(html, { url: `https://chat.example.test/private?token=secret${hash}`, runScripts: 'outside-only' });
  const w = dom.window;
  const copies = [];
  const sent = [];
  let socket;
  if (app) {
    w.matchMedia = () => ({ matches: false, addEventListener() {} });
    w.ResizeObserver = class { observe() {} };
    w.TextEncoder = TextEncoder;
    w.WebSocket = class {
      static OPEN = 1;
      constructor() { this.readyState = 1; socket = this; }
      send(raw) { sent.push(JSON.parse(raw)); }
    };
    w.fetch = async () => ({ ok: true, json: async () => ({ email_registration: email }) });
    w.eval(fs.readFileSync(path.join(root, 'web/app.js'), 'utf8'));
  }
  if (clipboard) Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async text => copies.push(text) } });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  if (encoder && fs.existsSync(path.join(root, 'web/qrcode.js'))) w.eval(fs.readFileSync(path.join(root, 'web/qrcode.js'), 'utf8'));
  if (fs.existsSync(path.join(root, 'web/invite.js'))) w.eval(fs.readFileSync(path.join(root, 'web/invite.js'), 'utf8'));
  return { w, dom, copies, sent, receive: data => socket.onmessage({ data: JSON.stringify(data) }), get: id => w.document.getElementById(id), close: () => w.close() };
}

test('invite pre-fills uppercase room only and survives account-to-lobby without joining', () => {
  const p = page('#room=abc123');
  try {
    assert.equal(p.get('room-code').value, 'ABC123');
    p.get('account-panel').hidden = false;
    p.get('account-toggle').click();
    p.get('account-panel').hidden = true;
    p.get('lobby').hidden = false;
    assert.equal(p.get('room-code').value, 'ABC123');
    assert.equal(p.get('room-view').hidden, true);
    assert.match(p.get('registration-code-source').textContent, /组织者.*一次性注册码/);
    assert.match(p.get('registration-code-source').textContent, /房间码.*注册码.*不同/);
  } finally { p.close(); }
});

test('malformed, duplicate and credential-bearing fragments are rejected', () => {
  for (const hash of ['#room=ABC12', '#room=ABC1234', '#room=%3Cimg%3E', '#room=ABC123&room=DEF456', '#room=ABC123&token=secret']) {
    const p = page(hash);
    try { assert.equal(p.get('room-code').value, '', hash); } finally { p.close(); }
  }
});

test('hashchange accepts a new room but never replaces an already joined room', () => {
  const p = page();
  try {
    p.w.history.replaceState(null, '', '#room=DEF456');
    p.w.dispatchEvent(new p.w.HashChangeEvent('hashchange'));
    assert.equal(p.get('room-code').value, 'DEF456');
    p.get('room-view').hidden = false;
    p.w.history.replaceState(null, '', '#room=XYZ789');
    p.w.dispatchEvent(new p.w.HashChangeEvent('hashchange'));
    assert.equal(p.get('room-code').value, 'DEF456');
  } finally { p.close(); }
});

test('copy creates a clean same-origin link and locally generated QR decodes to exactly that link', async () => {
  const p = page();
  try {
    p.get('room-id').textContent = 'ABC123';
    p.get('copy-invite').click();
    await new Promise(setImmediate);
    assert.deepEqual(p.copies, ['https://chat.example.test/#room=ABC123']);
    p.get('show-invite-qr').click();
    assert.equal(p.get('invite-dialog').open, true);
    assert.equal(p.get('invite-link').value, p.copies[0]);
    const svg = p.get('invite-qr').querySelector('svg');
    assert.ok(svg, 'local QR rendered');
    const size = Number(svg.getAttribute('viewBox').split(' ')[2]);
    const scale = 8, width = size * scale;
    const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
    const cells = [...svg.querySelector('path').getAttribute('d').matchAll(/M(\d+),(\d+)h1v1h-1z/g)];
    for (const [, col, row] of cells) for (let y = +row * scale; y < (+row + 1) * scale; y++) for (let x = +col * scale; x < (+col + 1) * scale; x++) {
      const i = (y * width + x) * 4; pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
    }
    const decoded = jsQR(pixels, width, width);
    assert.equal(decoded?.data, p.copies[0]);
    p.get('invite-close').click();
    assert.equal(p.get('invite-dialog').open, false);
    assert.equal(p.w.document.activeElement, p.get('show-invite-qr'));
  } finally { p.close(); }
});

test('clipboard denial opens a selectable link fallback; missing QR still provides link', async () => {
  const p = page('', { clipboard: false, encoder: false });
  try {
    p.get('room-id').textContent = 'ABC123';
    p.get('copy-invite').click();
    await new Promise(setImmediate); await new Promise(setImmediate);
    assert.equal(p.get('invite-dialog').open, true);
    assert.equal(p.get('invite-link').value, 'https://chat.example.test/#room=ABC123');
    assert.equal(p.get('invite-link').selectionStart, 0);
    assert.equal(p.get('invite-link').selectionEnd, p.get('invite-link').value.length);
    assert.match(p.get('invite-status').textContent, /手动复制/);
    assert.match(p.get('invite-qr').textContent, /二维码暂不可用/);
  } finally { p.close(); }
});

test('invalid outgoing room never produces an invitation', async () => {
  const p = page();
  try {
    p.get('room-id').textContent = '<script>';
    p.get('copy-invite').click(); await new Promise(setImmediate);
    assert.equal(p.copies.length, 0);
    assert.equal(p.get('invite-dialog').open, false);
  } finally { p.close(); }
});

for (const register of [false, true]) test(`actual ${register ? 'registration' : 'login'} retains invitation and waits for explicit join`, async () => {
  const p = page('#room=abc123', { app: true, email: true });
  try {
    p.receive({ type: 'auth_mode', required: true });
    await new Promise(setImmediate);
    assert.equal(p.get('account-panel').hidden, false);
    assert.equal(p.get('room-code').value, 'ABC123');
    if (register) {
      p.get('account-toggle').click();
      assert.equal(p.get('email-register').hidden, false, 'existing optional email signup remains available');
      p.get('invite-code').value = 'ab'.repeat(16);
    }
    p.get('account-name').value = 'traveler';
    p.get('account-password').value = 'test-password';
    p.get('account-form').dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(p.sent.at(-1).type, register ? 'register' : 'login');
    p.receive({ type: 'authenticated', name: 'traveler', token: 'test-account-token' });
    assert.equal(p.get('lobby').hidden, false);
    assert.equal(p.get('room-code').value, 'ABC123');
    assert.equal(p.sent.some(item => item.type === 'join'), false, 'no automatic join before consent');
    p.get('entry-form').dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(p.sent.at(-1).type, 'join');
    assert.equal(p.sent.at(-1).room, 'ABC123');
  } finally { p.close(); }
});
