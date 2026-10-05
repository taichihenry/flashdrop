/**
 * FlashDrop 界面逻辑
 * ---------------------------------------------------------------------------
 * 只做三件事：把 net.js 的事件翻译成界面、处理用户操作、管好文件落地。
 * 所有网络细节都在 net.js 里，这里不碰 WebRTC。
 */
(function () {
  'use strict';

  const FD = window.FlashDrop;
  const $ = (id) => document.getElementById(id);

  const state = {
    targets: new Set(),    // 选中的 Peer，可多选（多播发送）
    serverInfo: null,      // /api/info
    receiveQueue: [],      // 待确认的接收请求
    receiveOpen: false,
    lanUrl: '',
    httpsUrl: '',
  };

  const LS_NAME = 'flashdrop.name';
  const LS_PAIRS = 'flashdrop.pairedRooms';

  /* ============================== 小工具 ============================== */

  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
    } catch {
      // http 下 clipboard API 不可用，退回老办法
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('已复制'); }
      catch { toast('复制失败，请手动选择'); }
      document.body.removeChild(ta);
    }
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function timeLabel(d) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /* ============================== 传输记录 ============================== */

  const activities = new Map();
  let activitySeq = 0;

  function newActivity(opts) {
    const id = 'act' + (++activitySeq);
    const row = el('div', 'act');
    const head = el('div', 'act-head');
    const title = el('div', 'act-title', opts.title);
    const time = el('div', 'act-time', timeLabel(new Date()));
    head.append(title, time);

    const sub = el('div', 'act-sub', opts.sub || '');
    const barWrap = el('div', 'bar');
    const bar = el('i');
    barWrap.appendChild(bar);
    const actions = el('div', 'act-actions');

    row.append(head, sub, barWrap, actions);
    $('activity-list').prepend(row);
    $('activity-panel').hidden = false;

    const entry = { id, row, title, sub, bar, actions, done: false };
    activities.set(id, entry);
    return entry;
  }

  function setProgress(entry, progress) {
    if (!entry || entry.done) return;
    entry.bar.style.width = Math.max(0, Math.min(1, progress)) * 100 + '%';
  }

  // 第二个参数必须给默认值：调用点可能只想"收尾"而不改副标题（如 text-sent），
  // 少传一个参数会让解构直接抛 TypeError，把整个发送流程打断。
  function finishActivity(entry, { sub, done, level } = {}) {
    if (!entry) return;
    entry.done = true;
    if (sub) entry.sub.textContent = sub;
    setProgress(entry, 1);
    if (done) entry.row.classList.add('act-done');
    if (level === 'warn') entry.row.classList.add('act-warn');
    if (level === 'error') entry.row.classList.add('act-error');
  }

  /* ============================== 保存文件 ============================== */

  const blobUrls = [];

  function saveBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    blobUrls.push(url);
    // 攒太多就释放旧的，避免内存泄漏
    while (blobUrls.length > 12) URL.revokeObjectURL(blobUrls.shift());

    const a = document.createElement('a');
    a.href = url;
    a.download = FD.sanitizeName(name, 'file');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /* ============================== 二维码 ============================== */

  function renderQr(container, text) {
    container.textContent = '';
    if (!text) return;
    if (typeof window.qrcode !== 'function') {
      container.appendChild(el('div', 'muted small', '二维码库未加载'));
      return;
    }
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      const svg = container.querySelector('svg');
      if (svg) {
        svg.removeAttribute('width');
        svg.removeAttribute('height');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      }
    } catch (e) {
      container.appendChild(el('div', 'muted small', '二维码生成失败：' + e.message));
    }
  }

  /* ============================== 顶栏状态 ============================== */

  function setConn(stateName, text) {
    const box = $('conn-status');
    box.className = 'status status-' + stateName;
    $('conn-text').textContent = text;
  }

  function refreshConnStatus() {
    if (!signaling) return;
    if (signaling.ws && signaling.ws.readyState === WebSocket.OPEN) {
      const n = signaling.peers.size;
      setConn(n ? 'connected' : 'connected', n ? `${n} 台设备在线` : '已就绪');
    } else {
      setConn('connecting', '正在连接服务器…');
    }
  }

  /* ============================== 设备列表 ============================== */

  function peerStateText(p) {
    if (p.state === 'connected') return { text: '可以直传', ready: true };
    if (p.state === 'relay') return { text: '服务器中继', ready: true };
    if (p.state === 'switching') return { text: '正在建立连接…', ready: false };
    if (p.state === 'closed') return { text: '已断开', ready: false };
    return { text: '连接中…', ready: false };
  }

  function renderPeers() {
    const list = $('peer-list');
    list.textContent = '';
    const peers = signaling ? signaling.peerList() : [];

    // 已经断开的设备自动移出选择，避免发到一个死连接上
    for (const p of [...state.targets]) if (!peers.includes(p)) state.targets.delete(p);

    $('peers-empty').hidden = peers.length > 0;
    // 扫码面板「常驻」，不再因为发现设备就整块隐藏。
    //
    // 之前这里是 `connect-panel.hidden = peers.length > 0`，副作用是：第二台设备
    // 一进房间，二维码就整块被顶掉、底下换成发送面板。几百毫秒内完成，看起来像
    // 「页面闪跳」，实际地址栏都没变 —— 用户会误以为被重定向了。
    // 现在设备列表和二维码并存，也方便随时再拉第三台设备进来。
    $('connect-panel').hidden = false;

    let anyRelay = false;
    for (const p of peers) {
      const st = peerStateText(p);
      if (p.state === 'relay') anyRelay = true;

      const btn = el('button', 'peer' + (state.targets.has(p) ? ' selected' : ''));
      btn.type = 'button';
      btn.setAttribute('aria-pressed', state.targets.has(p) ? 'true' : 'false');

      const avatar = el('div', 'peer-avatar');
      avatar.innerHTML = /iPhone|iPad|Android/.test(p.name)
        ? '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="7" y="2" width="10" height="20" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="18.4" r="1" fill="currentColor"/></svg>'
        : '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="2.5" y="4" width="19" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 20h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

      const meta = el('div', 'peer-meta');
      meta.appendChild(el('div', 'peer-name', p.name));
      const sub = el('div', 'peer-sub' + (st.ready ? ' ready' : ''));
      sub.appendChild(el('i', 'mini-dot'));
      sub.appendChild(el('span', null, st.text));
      meta.appendChild(sub);

      btn.append(avatar, meta);
      btn.addEventListener('click', () => selectTarget(p));
      list.appendChild(btn);
    }

    $('relay-note').hidden = !anyRelay;
    const badge = $('room-badge');
    if (signaling && signaling.roomCode) {
      badge.hidden = false;
      badge.textContent = '房间 ' + signaling.roomCode;
      $('btn-room-leave').hidden = false;
    } else {
      badge.hidden = true;
      $('btn-room-leave').hidden = true;
    }
    refreshConnStatus();
    syncTargetLabel();
  }

  /**
   * 选中 / 取消选中一台设备（可多选）。
   *
   * 多选是为了支持「一台发给多台」。但要说清楚：这不是真广播 —— 底层是逐个
   * 点对点各发一遍，选 N 台就是 N 倍上行带宽。所以大文件多播前会先确认一次。
   */
  function selectTarget(peer) {
    if (!peer) return;
    if (state.targets.has(peer)) state.targets.delete(peer);
    else state.targets.add(peer);
    renderPeers();
    if (state.targets.size) {
      $('send-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  /** 全选 / 全不选 */
  function selectAllTargets() {
    const peers = signaling ? signaling.peerList().filter((p) => p.state !== 'closed') : [];
    if (!peers.length) { toast('还没有其他设备'); return; }
    const allIn = peers.every((p) => state.targets.has(p));
    state.targets.clear();
    if (!allIn) for (const p of peers) state.targets.add(p);
    renderPeers();
  }

  function clearTarget() {
    state.targets.clear();
    renderPeers();
  }

  /** 可用的目标设备（已经断开的过滤掉） */
  function selectedPeers() {
    return [...state.targets].filter((p) => p.state !== 'closed');
  }

  /** 只刷新发送面板的文案，不碰设备列表 —— 免得和 renderPeers 互相递归 */
  function syncTargetLabel() {
    const list = [...state.targets];
    $('send-panel').hidden = list.length === 0;
    $('target-name').textContent = list.length === 0
      ? '—'
      : (list.length === 1 ? list[0].name : `${list.length} 台设备`);

    const sub = $('target-sub');
    if (sub) {
      sub.hidden = list.length < 2;
      if (list.length > 1) sub.textContent = '多播：' + list.map((p) => p.name).join('、');
    }

    const all = $('btn-select-all');
    if (all) all.hidden = !(signaling && signaling.peers.size > 1);
  }

  /* ============================== 发送 ============================== */

  function currentTargets() {
    const list = selectedPeers();
    if (!list.length) { toast('请先选择设备'); return null; }
    return list;
  }

  async function sendFiles(files) {
    const peers = currentTargets();
    if (!peers) return;
    if (!files || !files.length) return;

    // 多播前先算总大小：上行带宽是 ×N，大文件必须先把代价说清楚
    if (peers.length > 1) {
      const total = Array.prototype.reduce.call(files, (a, f) => a + (f.size || 0), 0);
      if (total > 64 * 1024 * 1024) {
        const ok = window.confirm(
          `要把 ${files.length} 个文件（合计 ${FD.formatBytes(total)}）同时发给 ${peers.length} 台设备。\n\n` +
          `这是逐个直发，你的上行带宽会翻 ${peers.length} 倍，可能明显变慢。继续吗？`
        );
        if (!ok) return;
      }
    }

    // 各目标并行发：每个 Peer 自己管发送队列和流控，互不阻塞
    for (const p of peers) {
      Promise.resolve(p.sendFiles(files)).catch((e) => {
        toast(`发给 ${p.name} 失败：${e.message}`);
      });
    }
  }

  function sendText() {
    const peers = currentTargets();
    if (!peers) return;
    const input = $('text-input');
    const text = input.value.trim();
    if (!text) return;
    for (const p of peers) p.sendText(text);
    input.value = '';
  }

  /* ============================== 接收确认 ============================== */

  function enqueueRequest(peer, req) {
    state.receiveQueue.push({ peer, req });
    if (!state.receiveOpen) showNextRequest();
  }

  function showNextRequest() {
    const item = state.receiveQueue.shift();
    if (!item) {
      state.receiveOpen = false;
      $('overlay').hidden = true;
      $('modal-receive').hidden = true;
      return;
    }
    state.receiveOpen = true;

    const { peer, req } = item;
    $('receive-from').textContent = `来自 ${peer.name}`;
    const ul = $('receive-files');
    ul.textContent = '';
    for (const f of req.header) {
      const li = el('li');
      li.appendChild(el('span', 'fname', f.name));
      li.appendChild(el('span', 'fsize', FD.formatBytes(f.size)));
      ul.appendChild(li);
    }
    $('receive-total').textContent =
      `共 ${req.header.length} 个文件，合计 ${FD.formatBytes(req.totalSize)}`;

    // 接收能力分两档：能边收边写盘（桌面 Chrome/Edge），和只能全攒内存
    // （iOS Safari、Firefox、多数手机浏览器）。后者的内存天花板会让大文件直接崩页，
    // 所以这里必须如实说清楚，而不是让用户传完才发现白忙一场。
    const fsOk = FD.hasFileSystemAccess();
    const big = req.totalSize >= 64 * 1024 * 1024;
    const risk = FD.memoryReceiveRisk ? FD.memoryReceiveRisk(req.totalSize) : { risky: false, limit: Infinity };
    const hint = $('receive-hint');

    hint.className = 'receive-hint';
    if (risk.risky) {
      hint.hidden = false;
      hint.classList.add('danger');
      hint.textContent =
        `⚠ 当前浏览器不支持流式写盘，${FD.formatBytes(req.totalSize)} 得先全部装进内存。`
        + `超过约 ${FD.formatBytes(risk.limit)} 时很可能导致页面崩溃，`
        + `建议让对方分批发送，或改用内存更大的设备（如电脑）接收。`;
    } else if (!fsOk && big) {
      hint.hidden = false;
      hint.textContent =
        '当前浏览器不支持流式写盘，文件会先暂存在内存中 —— 请保持页面在前台，不要切走或锁屏。';
    } else if (fsOk && big) {
      hint.hidden = false;
      hint.textContent = '点接受后可选择保存文件夹，边收边写盘。';
    } else {
      hint.hidden = true;
      hint.textContent = '';
    }

    $('btn-accept').textContent = risk.risky ? '仍然接受（有风险）' : '接受';

    $('overlay').hidden = false;
    $('modal-receive').hidden = false;

    $('btn-accept').onclick = async () => {
      $('btn-accept').disabled = true;
      try {
        await peer.acceptIncoming(req.header, req.totalSize);
      } finally {
        $('btn-accept').disabled = false;
        showNextRequest();
      }
    };
    $('btn-reject').onclick = () => {
      peer.rejectIncoming();
      showNextRequest();
    };
  }

  /* ============================== 弹窗：配对 / 房间 ============================== */

  function openModal(which) {
    $('overlay').hidden = false;
    $('modal-pair').hidden = which !== 'pair';
    $('modal-room').hidden = which !== 'room';
    $('modal-receive').hidden = true;
  }

  function closeModal() {
    if (state.receiveOpen) return;   // 接收确认框不让随便关
    $('overlay').hidden = true;
    $('modal-pair').hidden = true;
    $('modal-room').hidden = true;
    if (signaling) signaling.pairCancel();
  }

  function openPair() {
    $('pair-initiate-view').hidden = false;
    $('pair-join-view').hidden = false;
    $('pair-code').textContent = '------';
    $('pair-qr').textContent = '';
    $('pair-input').value = '';
    $('pair-error').hidden = true;
    openModal('pair');
    signaling.pairInitiate();
  }

  /* ============================== 事件接线 ============================== */

  let signaling = null;
  const transferCtx = new Map();   // peerId -> {send: entry, recv: entry}

  function ctxFor(peerId) {
    if (!transferCtx.has(peerId)) transferCtx.set(peerId, {});
    return transferCtx.get(peerId);
  }

  function handleEvent(ev, p) {
    switch (ev) {
      /* ---- 连接 ---- */
      case 'signaling-open':
        refreshConnStatus();
        break;
      case 'signaling-closed':
        setConn('offline', '与服务器断开，正在重连…');
        renderPeers();
        break;
      case 'self': {
        // 设备名以本地存档为准，并在每次连接建立后主动推回服务端。
        //
        // 服务端在**每次新建连接**时都会按 UA 现场生成一个默认名（「Windows 电脑 · Chrome」），
        // 而自定义名只存在浏览器 localStorage 里。所以刷新页面 / 断线重连之后，
        // 服务端并不知道用户改过名 —— 不在这里补报一次，其他终端看到的就永远是默认名。
        // （现象：我在自己这台改了名，别人的列表里我却还是「Windows 电脑 · Chrome」。）
        const saved = localStorage.getItem(LS_NAME);
        if (saved) {
          $('my-name').textContent = saved;
          if (saved !== p.displayName) signaling.rename(saved);
        } else {
          $('my-name').textContent = p.displayName;
        }
        break;
      }
      case 'peers':
      case 'peer-joined':
      case 'peer-removed':
      case 'peer-added':
        renderPeers();
        if (ev === 'peer-joined' || ev === 'peer-added') {
          const peer = signaling.peer(p.peerId || (p.peer && p.peer.id));
          // 只有一个设备时自动选中，少点一步
          if (peer && signaling.peers.size === 1 && !state.targets.size) selectTarget(peer);
        }
        break;
      case 'peer-renamed':
        renderPeers();
        break;

      case 'peer-state': {
        const peer = signaling.peer(p.peerId);
        if (peer) {
          if (p.state === 'relay' && !state._relayToastShown) {
            state._relayToastShown = true;
            toast('P2P 打不通，已自动切换为服务器中继');
          }
          if (!state.targets.size && signaling.peers.size === 1) selectTarget(peer);
          renderPeers();
        }
        break;
      }

      /* ---- 文字 ---- */
      case 'text': {
        const peer = signaling.peer(p.peerId);
        const entry = newActivity({
          title: `收到文字 · ${peer ? peer.name : '未知设备'}`,
          sub: '',
        });
        const bubble = el('div', 'text-bubble', p.text);
        entry.row.insertBefore(bubble, entry.actions);
        const btn = el('button', 'btn btn-sm', '复制');
        btn.addEventListener('click', () => copyText(p.text));
        entry.actions.appendChild(btn);
        finishActivity(entry, { sub: `${p.text.length} 字` });
        break;
      }
      case 'text-sent': {
        const peer = signaling.peer(p.peerId);
        const entry = newActivity({ title: `已发文字 → ${peer ? peer.name : ''}`, sub: p.text.slice(0, 60) });
        finishActivity(entry);
        break;
      }

      /* ---- 发送文件 ---- */
      case 'send-requesting': {
        const peer = signaling.peer(p.peerId);
        const c = ctxFor(p.peerId);
        c.filesCount = p.filesCount;
        c.totalSize = p.totalSize;
        c.send = newActivity({
          title: `等待 ${peer ? peer.name : '对方'} 确认…`,
          sub: `${p.filesCount} 个文件 · ${FD.formatBytes(p.totalSize)}`,
        });
        setProgress(c.send, 0.4);
        break;
      }
      case 'send-progress': {
        const c = ctxFor(p.peerId);
        if (!c.send) break;
        c.send.title.textContent = `发送中 · ${p.name}`;
        c.send.sub.textContent =
          `${FD.formatBytes(p.bytes)} / ${FD.formatBytes(p.total)}` +
          (p.speed ? `　${FD.formatSpeed(p.speed)}` : '');
        setProgress(c.send, p.progress);
        break;
      }
      case 'send-complete': {
        const c = ctxFor(p.peerId);
        if (c.send) {
          const label = c.filesCount > 1
            ? `${c.filesCount} 个文件`
            : (c.send.title.textContent.replace(/^发送中 · /, '') || '文件');
          c.send.title.textContent = `已发送 · ${label}`;
          finishActivity(c.send, {
            sub: `${FD.formatBytes(c.totalSize || 0)}　✓ 已送达`,
          });
        }
        c.send = null;
        break;
      }

      /* ---- 接收文件 ---- */
      case 'receive-start': {
        const peer = signaling.peer(p.peerId);
        const c = ctxFor(p.peerId);
        c.recv = newActivity({
          title: `接收中 · 来自 ${peer ? peer.name : '未知设备'}`,
          sub: p.streaming ? '正在写入所选文件夹…' : '接收完成后会自动下载',
        });
        setProgress(c.recv, 0);
        break;
      }
      case 'receive-progress': {
        const c = ctxFor(p.peerId);
        if (!c.recv) break;
        c.recv.sub.textContent =
          `${FD.formatBytes(p.bytes)} / ${FD.formatBytes(p.total)}` +
          (p.speed ? `　${FD.formatSpeed(p.speed)}` : '') +
          (p.currentName ? `　${p.currentName}` : '');
        setProgress(c.recv, p.progress);
        break;
      }
      case 'file-received': {
        const c = ctxFor(p.peerId);
        const f = p.file;
        // 调试/自动化测试钩子（正常使用时不设置，无副作用）
        if (typeof window.__flashdropOnFile === 'function') {
          try { window.__flashdropOnFile(f, p.peerId); } catch { /* 忽略 */ }
        }
        if (f.saved === 'disk') {
          toast(`已保存：${f.name}`);
        } else if (f.blob) {
          saveBlob(f.name, f.blob);
          const btn = el('button', 'btn btn-sm', '再次保存');
          btn.addEventListener('click', () => saveBlob(f.name, f.blob));
          if (c.recv) c.recv.actions.appendChild(btn);
        }
        break;
      }
      case 'receive-complete': {
        const c = ctxFor(p.peerId);
        if (c.recv) {
          finishActivity(c.recv, {
            sub: `完成 · 共 ${FD.formatBytes(p.totalReceived)}`,
          });
        }
        c.recv = null;
        break;
      }

      /* ---- 配对 / 房间 ---- */
      case 'pair-initiated':
        $('pair-code').textContent = p.pairKey;
        renderQr($('pair-qr'), location.origin + '/#pair=' + p.pairKey);
        rememberPair(p.roomSecret);
        break;
      case 'pair-joined':
        rememberPair(p.roomSecret);
        toast('配对成功，之后可跨网络互传');
        $('modal-pair').hidden = true;
        $('overlay').hidden = true;
        break;
      case 'pair-invalid':
        $('pair-error').textContent = p.reason || '配对码无效';
        $('pair-error').hidden = false;
        break;
      case 'room-created':
        toast('房间已创建：' + p.roomId);
        $('room-input').value = p.roomId;
        renderPeers();
        break;
      case 'room-joined':
        toast('已加入房间 ' + p.roomId);
        renderPeers();
        break;
      case 'room-error':
        $('room-error').textContent = p.reason || '加入失败';
        $('room-error').hidden = false;
        break;

      /* ---- 接收请求 ---- */
      case 'request': {
        const peer = signaling.peer(p.peerId);
        if (!peer) break;
        // 同一个设备只允许一个进行中的传输
        if (peer._busy || peer._incoming) {
          peer.rejectIncoming();
          break;
        }
        enqueueRequest(peer, p);
        break;
      }

      /* ---- 其它 ---- */
      case 'notice':
        toast(p.text);
        if (p.level === 'warn') {
          const c = ctxFor(p.peerId);
          const entry = c.send || c.recv;
          if (entry) finishActivity(entry, { sub: p.text, level: 'warn' });
        }
        break;
      case 'error': {
        const c = ctxFor(p.peerId);
        const entry = c.send || c.recv;
        if (entry) finishActivity(entry, { sub: p.text, level: 'error' });
        toast(p.text);
        break;
      }
      default:
        break;
    }
  }

  function rememberPair(roomSecret) {
    if (!roomSecret) return;
    try {
      const list = JSON.parse(localStorage.getItem(LS_PAIRS) || '[]');
      if (!list.includes(roomSecret)) {
        list.push(roomSecret);
        localStorage.setItem(LS_PAIRS, JSON.stringify(list.slice(-10)));
      }
    } catch { /* 忽略 */ }
  }

  /* ============================== 初始化 ============================== */

  function bindUi() {
    // 设备名
    const savedName = localStorage.getItem(LS_NAME);
    if (savedName) $('my-name').textContent = savedName;

    $('btn-name').addEventListener('click', () => {
      const next = prompt('给这台设备起个名字：', $('my-name').textContent);
      if (next == null) return;
      const name = next.trim().slice(0, 24);
      if (!name) return;
      localStorage.setItem(LS_NAME, name);
      $('my-name').textContent = name;
      signaling.rename(name);
    });

    // 拖拽 & 选择文件
    const dz = $('dropzone');
    const fi = $('file-input');
    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); }
    });
    fi.addEventListener('change', () => {
      sendFiles(fi.files);
      fi.value = '';
    });

    ['dragenter', 'dragover'].forEach((t) =>
      dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('dragover'); })
    );
    ['dragleave', 'drop'].forEach((t) =>
      dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('dragover'); })
    );
    dz.addEventListener('drop', (e) => {
      // 必须挡住冒泡：下面 document 上还有一个"页面别处也能拖放"的处理器，
      // 不挡的话拖到虚线框里会**触发两次 sendFiles**，对方会收到两份请求。
      e.stopPropagation();
      if (e.dataTransfer && e.dataTransfer.files.length) sendFiles(e.dataTransfer.files);
    });
    // 页面别处也允许拖放
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length && state.targets.size) {
        sendFiles(e.dataTransfer.files);
      }
    });

    // 发文字
    $('btn-send-text').addEventListener('click', sendText);
    $('text-input').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendText();
    });

    $('btn-clear-target').addEventListener('click', clearTarget);
    $('btn-select-all').addEventListener('click', selectAllTargets);
    $('btn-clear-activity').addEventListener('click', () => {
      $('activity-list').textContent = '';
      activities.clear();
      $('activity-panel').hidden = true;
    });

    $('btn-copy-url').addEventListener('click', () => copyText(state.httpsUrl || state.lanUrl));

    // 配对
    $('btn-pair').addEventListener('click', openPair);
    // 空状态里的「开始配对」——跨网络用户唯一能走通的路，必须一步点到
    const emptyPair = $('btn-empty-pair');
    if (emptyPair) emptyPair.addEventListener('click', openPair);
    $('btn-pair-close').addEventListener('click', closeModal);
    $('btn-pair-join').addEventListener('click', () => {
      const code = $('pair-input').value.trim();
      if (!/^\d{6}$/.test(code)) {
        $('pair-error').textContent = '请输入 6 位数字';
        $('pair-error').hidden = false;
        return;
      }
      signaling.pairJoin(code);
    });

    // 房间
    $('btn-room').addEventListener('click', () => {
      $('room-error').hidden = true;
      $('room-input').value = '';
      openModal('room');
    });
    $('btn-room-close').addEventListener('click', closeModal);
    $('btn-room-create').addEventListener('click', () => signaling.createRoom());
    $('btn-room-join').addEventListener('click', () => {
      const code = $('room-input').value.trim().toLowerCase();
      if (!code) return;
      signaling.joinRoom(code, false);
    });
    $('btn-room-leave').addEventListener('click', () => {
      if (signaling.roomCode) signaling.leaveRoom(signaling.roomCode);
      closeModal();
      renderPeers();
    });

    $('overlay').addEventListener('click', (e) => {
      if (e.target === $('overlay')) closeModal();
    });

    window.addEventListener('beforeunload', (e) => {
      for (const p of signaling.peerList()) {
        if (p._busy || p._incoming) {
          e.preventDefault();
          e.returnValue = '';
          return '';
        }
      }
    });
  }

  async function loadServerInfo() {
    try {
      const r = await fetch('/api/info', { cache: 'no-store' });
      state.serverInfo = await r.json();
    } catch {
      state.serverInfo = { lanUrls: [] };
    }

    const urls = state.serverInfo.lanUrls || [];
    state.httpsUrl = urls.find((u) => u.startsWith('https://')) || '';
    state.lanUrl = urls.find((u) => u.startsWith('http://')) || '';

    // 手机应该访问的地址：优先 HTTPS
    let phoneUrl = state.httpsUrl || state.lanUrl;

    // 如果当前就在局域网地址上打开（多半是电脑自己），把二维码指向 https 那个
    if (location.protocol === 'https:' && state.httpsUrl) phoneUrl = state.httpsUrl;
    else if (location.protocol === 'http:' && state.httpsUrl) phoneUrl = state.httpsUrl;

    if (!phoneUrl) phoneUrl = location.origin;
    $('lan-url').textContent = phoneUrl;
    renderQr($('qr-holder'), phoneUrl);

    // 安全上下文检查 —— 这决定了能不能直传
    const hint = $('secure-hint');
    if (!window.isSecureContext) {
      $('insecure-banner').hidden = false;
      $('insecure-detail').textContent = state.httpsUrl
        ? `浏览器已禁用 P2P 直传，会自动改用服务器中继（速度慢）。建议改用：${state.httpsUrl}`
        : '浏览器已禁用 P2P 直传。请通过 HTTPS 地址访问本服务。';
      hint.hidden = false;
      hint.textContent = '当前是非安全上下文（HTTP + IP 地址）。浏览器会拒绝建立点对点连接，文件将经由本机服务中转。改用上面的 HTTPS 地址即可恢复直传。';
    } else if (state.httpsUrl && location.protocol === 'http:' && location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') {
      hint.hidden = false;
      hint.textContent = '建议改用 HTTPS 地址访问，以启用点对点直传。';
    }

    // 首页引导文案：HTML 里那份默认文案本身就是"通用版"，对公网和局域网两种部署都成立
    // （不再出现"必须连同一个 Wi-Fi"这种把跨网络用户拦在门外的说法）。
    // 只有本地自建（Node）版需要额外补一条 —— 它用自签名证书，手机第一次必然撞警告。
    // 判据：Cloudflare 版返回 mode='public'，Node 版不返回该字段。
    if (state.serverInfo.mode !== 'public') {
      const steps = $('connect-steps');
      if (steps && !steps.dataset.certHint) {
        steps.dataset.certHint = '1';   // 幂等，避免重复调用时插出两条
        steps.insertAdjacentHTML(
          'afterbegin',
          '<li>首次打开会提示「证书不受信任」——这是自签名证书的正常现象，'
            + '点 <b>高级</b> → <b>继续访问</b> 即可（服务只跑在你自己的电脑上）</li>'
        );
      }
    }
  }

  async function main() {
    bindUi();
    await loadServerInfo();

    signaling = new FD.Signaling({ emit: handleEvent });
    window.__fd = { signaling, state };   // 方便调试

    signaling.joinLanRoom();

    // 回到之前配对过的设备（跨网络用）
    try {
      const pairs = JSON.parse(localStorage.getItem(LS_PAIRS) || '[]');
      for (const secret of pairs) signaling.rejoinRoom(secret);
    } catch { /* 忽略 */ }

    // 支持 #pair=123456 直接带码进配对
    const m = /#pair=(\d{6})/.exec(location.hash);
    if (m) {
      openModal('pair');
      $('pair-input').value = m[1];
      signaling.pairJoin(m[1]);
      history.replaceState(null, '', location.pathname);
    }

    renderPeers();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
