(() => {
  'use strict';
  const get = id => document.getElementById(id);
  const dialog = get('invite-dialog');
  const roomInput = get('room-code');
  let returnFocus;

  function readInvitation() {
    // 只接受一个 room 字段，避免把账号令牌或其他参数误当成邀请的一部分。
    const fragment = location.hash.slice(1);
    if (!/^room=[a-z0-9]{6}$/i.test(fragment)) return;
    if (!get('room-view').hidden) return;
    const room = fragment.slice(5).toUpperCase();
    roomInput.value = room;
    roomInput.dispatchEvent(new Event('input', { bubbles: true }));
    for (const hint of document.querySelectorAll('[data-invite-context]')) {
      hint.textContent = `邀请房间：${room}。用邮箱验证码登录后确认加入。`;
      hint.hidden = false;
    }
    // 复用原有的移动侧栏关闭逻辑，不改变当前房间或发送加入请求。
    if (!get('navigation-backdrop').hidden) get('navigation-close').click();
  }

  function invitationLink() {
    const room = get('room-id').textContent.trim();
    if (!/^[A-Z0-9]{6}$/.test(room)) return '';
    // origin 排除当前路径、搜索参数及其他 fragment，不分享任何登录凭据。
    return `${location.origin}/#room=${room}`;
  }

  function renderQR(link) {
    const target = get('invite-qr');
    target.replaceChildren();
    try {
      if (typeof qrcode !== 'function') throw new Error('QR encoder unavailable');
      const code = qrcode(0, 'M');
      // 链接先按 UTF-8 转成字节，兼容含非 ASCII 字符的本地地址。
      const bytes = unescape(encodeURIComponent(link));
      code.addData(bytes, 'Byte');
      code.make();
      const count = code.getModuleCount();
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${count + 8} ${count + 8}`);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', '当前房间的邀请二维码；下方提供相同链接');
      const background = document.createElementNS(ns, 'rect');
      background.setAttribute('width', '100%');
      background.setAttribute('height', '100%');
      background.setAttribute('fill', '#ffffff');
      svg.append(background);
      const modules = document.createElementNS(ns, 'path');
      let points = '';
      // 四格静区让相机更容易识别；固定黑白配色，不随深色主题反转。
      for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) {
        if (code.isDark(row, col)) points += `M${col + 4},${row + 4}h1v1h-1z`;
      }
      modules.setAttribute('d', points);
      modules.setAttribute('fill', '#000000');
      modules.setAttribute('shape-rendering', 'crispEdges');
      svg.append(modules);
      target.append(svg);
    } catch (_) {
      target.textContent = '二维码暂不可用，请复制下方邀请链接。';
    }
  }

  function openInvitation(trigger) {
    const link = invitationLink();
    if (!link) return false;
    returnFocus = trigger;
    get('invite-link').value = link;
    get('invite-status').textContent = '';
    renderQR(link);
    if (!dialog.open) dialog.showModal();
    return true;
  }

  async function copyInvitation(trigger, insideDialog = false) {
    const link = insideDialog ? get('invite-link').value : invitationLink();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      get(insideDialog ? 'invite-status' : 'invite-copy-status').textContent = '邀请链接已复制。';
    } catch (_) {
      if (!insideDialog && !openInvitation(trigger)) return;
      get('invite-link').focus();
      get('invite-link').select();
      get('invite-status').textContent = '无法自动复制，请手动复制已选中的邀请链接。';
    }
  }

  get('copy-invite').addEventListener('click', event => copyInvitation(event.currentTarget));
  get('show-invite-qr').addEventListener('click', event => openInvitation(event.currentTarget));
  get('invite-copy-link').addEventListener('click', event => copyInvitation(event.currentTarget, true));
  get('invite-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => returnFocus?.focus());
  window.addEventListener('hashchange', readInvitation);
  readInvitation();
})();
