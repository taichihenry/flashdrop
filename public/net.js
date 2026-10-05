/**
 * FlashDrop 传输引擎
 * ---------------------------------------------------------------------------
 * 分层：
 *   信令层 Signaling   —— 一条 WebSocket，跟服务器换"谁在线"和 SDP/ICE
 *   传输层 Transport   —— RtcTransport（WebRTC 直连）/ WsRelayTransport（服务器兜底）
 *   Peer 层            —— 跑在传输层之上，负责文件分片、流控、进度、文字消息
 *
 * 关键设计取舍（都是踩过坑才这么写的）：
 *   1. 分片 64 KB：各浏览器 DataChannel 单条消息上限不一，64 KB 是安全区。
 *   2. 双流控：bufferedAmount 水位 + 8 MB 分区 ACK。
 *      只做 bufferedAmount，进度反馈会滞后；只做 ACK，吞吐会被 RTT 拖死。
 *   3. 大文件流式落盘：接收端支持 File System Access API 时直接写磁盘，
 *      避免把 1 GB 文件全塞进浏览器内存（那会直接崩标签页）。
 *   4. P2P 打不通自动降级：6 秒没连上就切服务器中继，并在界面上明示。
 *   5. 未知设备的信令先缓存：服务端广播和 SDP 转发之间存在竞态，
 *      直接用会偶发"连不上"。
 */
(function () {
  'use strict';

  /* ============================== 常量 ============================== */

  const CHUNK_SIZE = 64 * 1024;              // 单条 DataChannel 消息 64 KB
  const PARTITION_SIZE = 8 * 1024 * 1024;    // 每 8 MB 向对端要一次 ACK
  const BUFFER_HIGH = 4 * 1024 * 1024;       // 发送缓冲超过它就暂停
  const BUFFER_LOW = 512 * 1024;             // 降到它就继续
  const P2P_TIMEOUT_MS = 6000;               // P2P 握手超时 → 降级
  const SIGNAL_BUFFER_TTL = 10000;           // 未知设备信令缓存 10 秒
  const MAX_TEXT_LEN = 256 * 1024;           // 单条文字上限
  const STREAM_TO_DISK_THRESHOLD = 64 * 1024 * 1024; // 超过 64 MB 才提示选目录

  /* ============================== 小工具 ============================== */

  function randomId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function formatBytes(n) {
    if (!n && n !== 0) return '—';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[i];
  }

  function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || !isFinite(bytesPerSec)) return '';
    return formatBytes(bytesPerSec) + '/s';
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToBase64(u8) {
    let s = '';
    const STEP = 0x8000;   // 一次 32 KB，避免 apply 参数过多爆栈
    for (let i = 0; i < u8.length; i += STEP) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + STEP));
    }
    return btoa(s);
  }

  /** 清洗文件名：路径穿越和 Windows 非法字符都要挡掉 */
  function sanitizeName(name, fallback) {
    let n = String(name || '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
    n = n.replace(/^\.+/, '');
    if (!n) n = fallback || 'file';
    return n.slice(0, 180);
  }

  function hasFileSystemAccess() {
    return typeof window.showDirectoryPicker === 'function';
  }

  /**
   * 「没有流式落盘」时单次接收的安全上限。
   *
   * 这条路上整个文件要先攒在 JS 堆里，最后再合成 Blob，内存峰值约是文件大小的 2 倍。
   * 而 iOS Safari 对单个标签页有硬红线（约 200–300 MB），越线会被系统直接杀掉标签页，
   * 用户看到的是「网页出现问题，已重新载入」—— 传输看起来像莫名其妙失败了。
   * 所以宁可提前示警，也不要让它在用户眼皮底下崩掉。
   */
  function memoryReceiveLimit() {
    const ua = navigator.userAgent || '';
    const iOS = /iPad|iPhone|iPod/.test(ua)
      // iPadOS 会把自己伪装成 macOS，靠触摸点数认出来
      || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
    if (iOS) return 200 * 1024 * 1024;
    if (/Android|HarmonyOS|Mobile/i.test(ua)) return 1024 * 1024 * 1024;
    return 2 * 1024 * 1024 * 1024;   // 桌面浏览器内存宽裕得多
  }

  /** 当前环境收这个大小安不安全（仅在无流式落盘时有意义） */
  function memoryReceiveRisk(totalSize) {
    if (hasFileSystemAccess()) return { risky: false, limit: Infinity };
    const limit = memoryReceiveLimit();
    return { risky: totalSize > limit, limit };
  }

  /**
   * 串行化的落盘写入。
   * 直接调 writable.write() 的话，多个 write 会并发投递，加上 await 穿插，
   * 分片顺序可能颠倒 —— 传一个大文件出来是坏的，而且不报错。
   * 这里用一条 promise 链把写入严格串起来，顺序就锁死了。
   */
  class DiskSink {
    constructor(writable) {
      this.writable = writable;
      this.chain = Promise.resolve();
      this.failed = null;
    }
    write(u8) {
      this.chain = this.chain.then(() => {
        if (this.failed) return;
        return this.writable.write(u8).catch((e) => { this.failed = e; });
      });
      return this.chain;
    }
    close() {
      return this.chain.then(() => {
        if (this.failed) throw this.failed;
        return this.writable.close();
      });
    }
    abort() {
      return this.chain.then(() => this.writable.abort()).catch(() => { /* noop */ });
    }
  }

  /* ============================== 传输层 ============================== */

  /** WebRTC 直连传输 */
  class RtcTransport {
    constructor(opts) {
      this.kind = 'p2p';
      this.opts = opts;
      this.channel = null;
      this.closed = false;
      this._opened = false;

      const pc = new RTCPeerConnection({ iceServers: opts.iceServers || [] });
      this.pc = pc;

      pc.onicecandidate = (e) => {
        if (e.candidate) opts.sendSignal({ ice: e.candidate });
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') this._fail('WebRTC 连接失败');
        if (pc.connectionState === 'closed') this._close();
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') this._fail('ICE 协商失败');
      };

      if (opts.isCaller) {
        const ch = pc.createDataChannel('flashdrop', { ordered: true });
        this._bindChannel(ch);
        pc.createOffer()
          .then((d) => pc.setLocalDescription(d))
          .then(() => opts.sendSignal({ sdp: pc.localDescription }))
          .catch((e) => this._fail(e.message));
      } else {
        pc.ondatachannel = (e) => this._bindChannel(e.channel);
      }
    }

    _bindChannel(ch) {
      this.channel = ch;
      ch.binaryType = 'arraybuffer';
      ch.onopen = () => { this._opened = true; this.opts.onOpen(); };
      ch.onmessage = (e) => this.opts.onMessage(e.data);
      ch.onclose = () => this._close();
      ch.onerror = () => { /* onclose 会跟上来 */ };
    }

    async handleSignal(msg) {
      try {
        if (msg.sdp) {
          await this.pc.setRemoteDescription(msg.sdp);
          if (msg.sdp.type === 'offer') {
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            this.opts.sendSignal({ sdp: this.pc.localDescription });
          }
        } else if (msg.ice) {
          await this.pc.addIceCandidate(msg.ice);
        }
      } catch (e) {
        this._fail('SDP/ICE 处理失败: ' + e.message);
      }
    }

    sendText(str) { if (this.channel && this.channel.readyState === 'open') this.channel.send(str); }
    sendBinary(buf) { if (this.channel && this.channel.readyState === 'open') this.channel.send(buf); }

    bufferedAmount() { return this.channel ? this.channel.bufferedAmount : 0; }

    drain() {
      return new Promise((resolve) => {
        const ch = this.channel;
        if (!ch) return resolve();
        ch.bufferedAmountLowThreshold = BUFFER_LOW;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          ch.removeEventListener('bufferedamountlow', finish);
          resolve();
        };
        ch.addEventListener('bufferedamountlow', finish);
        setTimeout(finish, 800);   // 兜底，防止事件不触发导致卡死
      });
    }

    isOpen() { return this._opened && this.channel && this.channel.readyState === 'open'; }

    /**
     * 补挂 ICE 服务器（TURN 凭证拿到之后用）。
     *
     * 不改用「销毁重建 PeerConnection」是有原因的：重建等于把已经交换过的
     * SDP 全部作废，answerer 那一侧还要能接受一个全新的 offer，容易出现
     * 两侧状态不一致 —— 实测偶发"重建后谁都不发 offer"的死锁。
     * setConfiguration + restartIce 是规范内的就地更新，代价小得多。
     *
     * 只有 caller 调 restartIce()：ICE restart 必须由 offer 方向发起，
     * answerer 这边把配置换上就够了，它会跟着新的 offer 重新收集候选。
     */
    addIceServers(extra) {
      if (this.closed || !this.pc || !extra || !extra.length) return false;
      try {
        this.opts.iceServers = (this.opts.iceServers || []).concat(extra);
        this.pc.setConfiguration({ iceServers: this.opts.iceServers });

        if (typeof this.pc.restartIce === 'function') {
          if (this.opts.isCaller) this.pc.restartIce();
        } else if (this.opts.isCaller) {
          // 老浏览器兜底：手动发一个带 iceRestart 的 offer
          this.pc.createOffer({ iceRestart: true })
            .then((d) => this.pc.setLocalDescription(d))
            .then(() => this.opts.sendSignal({ sdp: this.pc.localDescription }))
            .catch(() => { /* 交给上层超时降级 */ });
        }
        return true;
      } catch (e) {
        return false;
      }
    }

    _fail(reason) {
      if (this.closed) return;
      this.opts.onFail(reason);
    }

    _close() {
      if (this.closed) return;
      this.closed = true;
      this.opts.onClose();
    }

    destroy() {
      this.closed = true;
      if (this.channel) {
        try { this.channel.onclose = null; this.channel.close(); } catch { /* noop */ }
      }
      try { this.pc.close(); } catch { /* noop */ }
    }
  }

  /** WebSocket 中继传输：P2P 打不通时的兜底，速度慢但一定能通 */
  class WsRelayTransport {
    constructor(opts) {
      this.kind = 'relay';
      this.opts = opts;
      this.closed = false;
      this._queueTimer = null;
      // 中继是"假连接"：信令通道本来就在，直接算已打开
      setTimeout(() => { if (!this.closed) opts.onOpen(); }, 0);
    }

    async handleSignal(msg) { /* 中继不需要 SDP/ICE */ }

    sendText(str) {
      this.opts.sendRelay({ type: 'relay', payload: { kind: 'text', data: str } });
    }

    sendBinary(buf) {
      const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
      this.opts.sendRelay({
        type: 'relay',
        payload: { kind: 'binary', data: bytesToBase64(u8) },
      });
    }

    /** 中继一切都要 base64 编码后塞进 JSON，用它作为"缓冲量"来限速 */
    bufferedAmount() { return 0; }

    drain() { return new Promise((r) => setTimeout(r, 24)); }

    isOpen() { return !this.closed; }

    /** 由 Peer 把中继回来的数据喂进来 */
    deliver(payload) {
      if (payload.kind === 'text') this.opts.onMessage(payload.data);
      else this.opts.onMessage(base64ToBytes(payload.data).buffer);
    }

    destroy() {
      this.closed = true;
    }
  }

  /* ============================== Peer ============================== */

  class Peer {
    /**
     * @param {object} o
     * @param {Signaling} o.signaling
     * @param {string} o.id
     * @param {string} o.name
     * @param {boolean} o.isCaller
     * @param {string} o.roomType
     * @param {string} o.roomId
     * @param {Array} o.iceServers
     * @param {function} o.emit  (eventName, payload) => void
     */
    constructor(o) {
      this.signaling = o.signaling;
      this.id = o.id;
      this.name = o.name || '未知设备';
      this.roomType = o.roomType;
      this.roomId = o.roomId;
      this.iceServers = o.iceServers || [];
      this.emit = o.emit;

      this.transport = null;
      this.state = 'connecting';       // connecting | connected | relay | closed

      // 发送队列
      this._outQueue = [];
      this._busy = false;

      // 接收状态
      this._incoming = null;

      // 通道未就绪时先排队的消息
      this._pendingText = null;

      // 等待中的 ACK：key -> {resolve, timer}
      this._waiters = new Map();

      // 降级定时器
      this._fallbackTimer = null;

      this._setupTransport(o.isCaller);
    }

    /* ------------------------ 传输层装配 ------------------------ */

    _setupTransport(isCaller) {
      const common = {
        iceServers: this.iceServers,
        isCaller,
        sendSignal: (signal) => this._sendSignal(signal),
        sendRelay: (msg) => this._sendRelay(msg),
        onOpen: () => this._onTransportOpen(),
        onMessage: (data) => this._onTransportMessage(data),
        onClose: () => this._onTransportClose(),
        onFail: (reason) => this._degradeToRelay(reason),
      };

      // 注意：某些浏览器在非安全上下文里 RTCPeerConnection 存在但一 new 就抛错，
      // 所以这里必须 try 一下，抛了就当场退到中继，不能让整个 Peer 挂在构造阶段。
      try {
        this.transport = window.RTCPeerConnection
          ? new RtcTransport(common)
          : new WsRelayTransport(common);
      } catch (e) {
        this.transport = new WsRelayTransport(common);
        this.emit('notice', {
          level: 'warn',
          text: '浏览器拒绝建立点对点连接（' + e.message + '），已改用服务器中继',
        });
      }

      // 若 6 秒还没建立直连，先补 TURN 再试一轮，最后才退到中继。
      // （弱网 / 组播被拦 / 严格 NAT 的网络会走到这里）
      if (this.transport.kind === 'p2p') {
        this._turnTried = false;
        this._armP2pTimeout(P2P_TIMEOUT_MS);
      }
    }

    _armP2pTimeout(ms) {
      clearTimeout(this._fallbackTimer);
      this._fallbackTimer = setTimeout(() => this._onP2pTimeout(), ms);
    }

    /**
     * P2P 第一轮超时。
     *
     * 这里刻意做了「两段式」而不是直接降级：
     *   轮次 1（无 TURN，6s）→ 失败 → 取一次 TURN 凭证 + ICE restart
     *   轮次 2（带 TURN，再 6s）→ 还失败 → 才退到 WebSocket 中继
     *
     * 好处是绝大多数能直连的用户一次都不会去碰 TURN 额度，
     * 而真正过不去的那 10–20%（严格 NAT / 公司网）又能被救回来。
     */
    async _onP2pTimeout() {
      if (this.state !== 'connecting') return;
      if (this.transport && this.transport.isOpen && this.transport.isOpen()) return;

      if (!this._turnTried && this.signaling.ensureTurnServers) {
        this._turnTried = true;
        this.emit('peer-state', { peerId: this.id, state: 'connecting', reason: 'trying-turn' });

        let extra = [];
        try { extra = await this.signaling.ensureTurnServers(); } catch { extra = []; }

        if (extra && extra.length) {
          if (this.state !== 'connecting') return;                 // 期间已经连上或已降级
          const t = this.transport;
          if (t && t.kind === 'p2p' && t.addIceServers && t.addIceServers(extra)) {
            this._armP2pTimeout(P2P_TIMEOUT_MS);
            return;
          }
        }
        if (this.state !== 'connecting') return;
        this._degradeToRelay('P2P 握手超时');
        return;
      }

      this._degradeToRelay('P2P 握手超时');
    }

    /**
     * 降级到 WebSocket 中继。
     * @param {string} reason
     * @param {boolean} [force] 收到对端中继消息时用，必须切（否则那条消息就丢了）
     */
    _degradeToRelay(reason, force = false) {
      if (this.state === 'connected' || this.state === 'relay') return;
      clearTimeout(this._fallbackTimer);

      // 已经在直传途中就别切了，切换会丢数据。
      // 但 if force 说明对端已经不认这条 P2P 了，本端再等也没意义。
      if (!force && (this._busy || this._incoming)) return;

      const old = this.transport;
      if (old) old.destroy();

      this.transport = new WsRelayTransport({
        sendRelay: (msg) => this._sendRelay(msg),
        onOpen: () => this._onTransportOpen(),
        onMessage: (data) => this._onTransportMessage(data),
        onClose: () => this._onTransportClose(),
      });
      this.emit('peer-state', { peerId: this.id, state: 'switching', reason });
    }

    _onTransportOpen() {
      if (this.state === 'connected' || this.state === 'relay') return;
      clearTimeout(this._fallbackTimer);
      this.state = this.transport.kind === 'p2p' ? 'connected' : 'relay';
      this.emit('peer-state', { peerId: this.id, state: this.state });

      // 之前积压的握手消息（比如对端把 signal 发早了）现在补发
      if (this._pendingText) {
        for (const t of this._pendingText) this.transport.sendText(t);
        this._pendingText = null;
      }
    }

    _onTransportClose() {
      if (this.state === 'closed') return;
      this.state = 'closed';
      this._rejectAllWaiters('连接已断开');
      this.emit('peer-state', { peerId: this.id, state: 'closed' });
    }

    _sendSignal(signal) {
      signal.type = 'signal';
      signal.to = this.id;
      signal.roomType = this.roomType;
      signal.roomId = this.roomId;
      this.signaling.send(signal);
    }

    _sendRelay(msg) {
      msg.to = this.id;
      msg.roomType = this.roomType;
      msg.roomId = this.roomId;
      this.signaling.send(msg);
    }

    async handleSignal(msg) {
      if (!this.transport) return;
      await this.transport.handleSignal(msg);
    }

    /**
     * 服务器中继回来的数据。
     *
     * ⚠ 这里是"跨网络首次传文件偶发失败"的真凶所在：
     * 两端各自跑 6 秒 P2P 超时定时器，但**不会同时到期**。先到期的那个
     * 会切到中继并把消息发出来，而此刻另一端可能还在 P2P 握手阶段 ——
     * 若这里只做类型判断，那条消息就被静默丢弃了，且没有重发机制，
     * 表现为"点了发送对面毫无反应"，重试一次又好了。
     *
     * 正确做法：**收到对端的中继消息，就等于对端已经放弃 P2P**，
     * 本端必须立刻跟着降级，再把这条消息投进去。
     */
    deliverRelay(payload) {
      if (!(this.transport instanceof WsRelayTransport)) {
        this._degradeToRelay('对端已切换到中继', true);
      }
      if (this.transport instanceof WsRelayTransport) this.transport.deliver(payload);
    }

    setRoom(roomType, roomId) {
      this.roomType = roomType;
      this.roomId = roomId;
    }

    setName(name) { this.name = name; }

    /* ------------------------ 收发 ------------------------ */

    _sendJSON(obj) {
      const str = JSON.stringify(obj);
      if (this.transport.isOpen()) {
        this.transport.sendText(str);
      } else if (this.state === 'connecting') {
        // 通道还没好，先排队（常见于对端刚上线）
        (this._pendingText = this._pendingText || []).push(str);
      }
      return str;
    }

    _onTransportMessage(data) {
      if (typeof data === 'string') {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        this._handleProtocol(msg);
      } else {
        this._handleBinary(data);
      }
    }

    /* ------------------------ 协议 ------------------------ */

    _handleProtocol(msg) {
      switch (msg.type) {
        case 'request': this._onRequest(msg); break;
        case 'files-response': this._resolveWaiter('files-response', msg); break;

        case 'header': this._onHeader(msg); break;
        case 'partition':
          // 同一有序通道里，partition 一定在其前面所有二进制分片之后到达，
          // 所以此刻回 ACK 是安全的
          this._sendJSON({ type: 'partition-received', id: msg.id });
          break;
        case 'partition-received':
          this._resolveWaiter('partition:' + msg.id, true);
          break;

        case 'file-end': this._onFileEnd(msg); break;
        case 'file-done':
          this._resolveWaiter('done:' + msg.id, true);
          break;

        case 'cancel':
          this._onRemoteCancel(msg); break;

        case 'text': this.emit('text', { peerId: this.id, text: msg.text }); break;
        default: break;
      }
    }

    _handleBinary(data) {
      const inc = this._incoming;
      const cur = inc && inc.current;      // 按文件计数的状态在 current 上，
      if (!cur) return;                    // 会话对象只管总计，别写混了

      const buf = data instanceof ArrayBuffer ? data : null;
      if (!buf) return;

      cur.received += buf.byteLength;
      inc.received += buf.byteLength;

      if (cur.sink) {
        cur.sink.write(new Uint8Array(buf));   // DiskSink 内部串行，保证落盘顺序
      } else {
        cur.chunks.push(buf);
      }

      const now = Date.now();
      if (now - inc.lastEmit > 120 || cur.received >= cur.size) {
        inc.lastEmit = now;
        this._emitProgress(inc);
      }
    }

    /* ------------------------ 接收 ------------------------ */

    async _onRequest(msg) {
      const header = Array.isArray(msg.header) ? msg.header : [];
      const totalSize = Number(msg.totalSize) || 0;
      this.emit('request', {
        peerId: this.id,
        header,
        totalSize,
        filesCount: header.length,
      });
    }

    /** 由界面调用：用户点了"接受" */
    async acceptIncoming(header, totalSize) {
      let dirHandle = null;
      // 大文件且浏览器支持 → 提示选一个保存目录，边收边写盘
      if (hasFileSystemAccess() && totalSize >= STREAM_TO_DISK_THRESHOLD) {
        try {
          dirHandle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'flashdrop-save' });
        } catch {
          dirHandle = null;   // 用户取消，退回内存模式
        }
      }

      this._incoming = {
        header: header.slice(),
        queue: header.slice(),
        totalSize,
        totalReceived: 0,
        received: 0,
        lastEmit: 0,
        current: null,
        dirHandle,
        usedNames: new Set(),
      };
      this._sendJSON({ type: 'files-response', accepted: true });
      this.emit('receive-start', { peerId: this.id, totalSize, streaming: !!dirHandle });
    }

    rejectIncoming() {
      this._sendJSON({ type: 'files-response', accepted: false, reason: '对方拒绝接收' });
    }

    _onHeader(msg) {
      const inc = this._incoming;
      if (!inc) {
        // 出错了，告诉对方别发了
        this._sendJSON({ type: 'cancel', id: msg.id, reason: '未在接收状态' });
        return;
      }
      const name = sanitizeName(msg.name, 'file');
      const entry = {
        id: msg.id,
        name,
        size: Number(msg.size) || 0,
        mime: msg.mime || 'application/octet-stream',
        chunks: [],
        sink: null,            // 有它就走流式落盘，没有就攒内存
        received: 0,
        lastEmit: 0,
        startedAt: Date.now(),
      };
      inc.current = entry;

      if (inc.dirHandle) {
        // 异步建文件，二进制分片到达时可能还没建好 → 先用内存缓冲区顶上
        this._prepareDiskEntry(inc, entry);
      }
    }

    async _prepareDiskEntry(inc, entry) {
      try {
        let fileName = entry.name;
        let i = 1;
        while (inc.usedNames.has(fileName.toLowerCase())) {
          const dot = entry.name.lastIndexOf('.');
          fileName = dot > 0
            ? `${entry.name.slice(0, dot)} (${i})${entry.name.slice(dot)}`
            : `${entry.name} (${i})`;
          i++;
        }
        inc.usedNames.add(fileName.toLowerCase());

        const fh = await inc.dirHandle.getFileHandle(fileName, { create: true });
        const writable = await fh.createWritable();
        if (inc.current !== entry) { await writable.close(); return; }

        // 这一小段必须同步执行：先把积压的分片摘出来，再挂上 sink。
        // 中间一旦有 await，就有新的分片插进来，顺序会乱掉。
        const backlog = entry.chunks;
        entry.chunks = [];
        const sink = new DiskSink(writable);
        entry.sink = sink;

        for (const buf of backlog) sink.write(new Uint8Array(buf));
      } catch (e) {
        // 落盘失败就退回内存模式，不能让传输中断
        entry.sink = null;
        this.emit('notice', { level: 'warn', text: '写入磁盘失败，已退回内存接收：' + e.message });
      }
    }

    async _onFileEnd(msg) {
      const inc = this._incoming;
      if (!inc || !inc.current || inc.current.id !== msg.id) return;
      const entry = inc.current;

      try {
        if (entry.sink) {
          await entry.sink.close();
          entry.result = { name: entry.name, saved: 'disk' };
        } else {
          const blob = new Blob(entry.chunks, { type: entry.mime });
          entry.chunks = [];
          entry.result = { name: entry.name, blob, saved: 'memory' };
        }
      } catch (e) {
        this._abortIncoming(e.message);
        return;
      }

      inc.totalReceived += entry.result.blob ? entry.result.blob.size : entry.size;
      inc.current = null;

      // 通知发送端：这个文件确实落地了，可以发下一个
      this._sendJSON({ type: 'file-done', id: msg.id });

      const isLast = inc.totalReceived >= inc.totalSize || inc.queue.length <= 1;
      this.emit('file-received', {
        peerId: this.id,
        file: entry.result,
        received: inc.totalReceived,
        totalSize: inc.totalSize,
      });

      if (inc.queue.length) inc.queue.shift();

      if (isLast || inc.queue.length === 0) {
        this.emit('receive-complete', {
          peerId: this.id,
          totalSize: inc.totalSize,
          totalReceived: inc.totalReceived,
        });
        this._incoming = null;
      }
    }

    _abortIncoming(reason) {
      const cur = this._incoming && this._incoming.current;
      if (cur && cur.sink) { try { cur.sink.abort(); } catch { /* noop */ } }
      this._incoming = null;
      this.emit('error', { peerId: this.id, text: '接收失败：' + reason });
    }

    _emitProgress(inc) {
      const p = inc.totalSize > 0 ? inc.received / inc.totalSize : 0;
      const t = inc.current;
      const elapsed = t ? (Date.now() - t.startedAt) / 1000 : 0;
      this.emit('receive-progress', {
        peerId: this.id,
        progress: p,
        bytes: inc.received,
        total: inc.totalSize,
        speed: elapsed > 0.4 ? inc.received / elapsed : 0,
        currentName: t ? t.name : '',
      });
    }

    /* ------------------------ 发送 ------------------------ */

    async sendFiles(files) {
      const list = Array.from(files || []);
      if (!list.length) return;

      const header = list.map((f) => ({
        name: f.name,
        size: f.size,
        mime: f.type || 'application/octet-stream',
      }));
      const totalSize = header.reduce((a, b) => a + b.size, 0);

      this.emit('send-requesting', { peerId: this.id, totalSize, filesCount: list.length });
      this._sendJSON({ type: 'request', header, totalSize, filesCount: list.length });

      let verdict;
      try {
        verdict = await this._waitFor('files-response', 120000);
      } catch (e) {
        this.emit('error', { peerId: this.id, text: '对方没有响应（' + e.message + '）' });
        return;
      }
      if (!verdict.accepted) {
        this.emit('notice', { level: 'warn', text: verdict.reason || '对方拒绝接收' });
        return;
      }

      for (const f of list) this._outQueue.push(f);
      if (!this._busy) this._drainQueue();
    }

    async _drainQueue() {
      if (this._busy) return;
      this._busy = true;
      try {
        while (this._outQueue.length) {
          if (this.state === 'closed') break;
          await this._sendOne(this._outQueue.shift());
        }
        this.emit('send-complete', { peerId: this.id });
      } catch (e) {
        this.emit('error', { peerId: this.id, text: '发送失败：' + e.message });
      } finally {
        this._busy = false;
      }
    }

    async _sendOne(file) {
      const id = randomId();
      this._sendJSON({
        type: 'header',
        id,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
      });

      let offset = 0;
      let partitionStart = 0;
      const startedAt = Date.now();
      let lastEmit = 0;

      while (offset < file.size) {
        if (this.state === 'closed') throw new Error('连接已断开');

        if (this.transport.bufferedAmount() > BUFFER_HIGH) await this.transport.drain();

        const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        this.transport.sendBinary(buf);
        offset += buf.byteLength;

        if (offset - partitionStart >= PARTITION_SIZE) {
          this._sendJSON({ type: 'partition', id, offset });
          // 等接收端确认已消化这 8 MB，否则内存会被打爆
          await this._waitFor('partition:' + id, 120000);
          partitionStart = offset;
        }

        const now = Date.now();
        if (now - lastEmit > 120 || offset >= file.size) {
          lastEmit = now;
          const elapsed = (now - startedAt) / 1000;
          this.emit('send-progress', {
            peerId: this.id,
            progress: file.size ? offset / file.size : 1,
            bytes: offset,
            total: file.size,
            speed: elapsed > 0.4 ? offset / elapsed : 0,
            name: file.name,
          });
        }
      }

      this._sendJSON({ type: 'file-end', id, size: file.size });
      await this._waitFor('done:' + id, 120000);
    }

    /* ------------------------ 文字 ------------------------ */

    sendText(text) {
      const t = String(text || '').slice(0, MAX_TEXT_LEN);
      if (!t) return;
      this._sendJSON({ type: 'text', text: t });
      this.emit('text-sent', { peerId: this.id, text: t });
    }

    /* ------------------------ 等待器 ------------------------ */

    _waitFor(key, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._waiters.delete(key);
          reject(new Error('等待超时'));
        }, timeoutMs);
        this._waiters.set(key, { resolve, reject, timer });
      });
    }

    _resolveWaiter(key, value) {
      const w = this._waiters.get(key);
      if (!w) return;
      clearTimeout(w.timer);
      this._waiters.delete(key);
      w.resolve(value);
    }

    _rejectAllWaiters(reason) {
      for (const [, w] of this._waiters) {
        clearTimeout(w.timer);
        w.reject(new Error(reason));
      }
      this._waiters.clear();
    }

    _onRemoteCancel(msg) {
      this.emit('notice', { level: 'warn', text: msg.reason || '对方中止了传输' });
      this._rejectAllWaiters('对方中止');
    }

    destroy() {
      this.state = 'closed';
      clearTimeout(this._fallbackTimer);
      this._rejectAllWaiters('连接关闭');
      if (this.transport) this.transport.destroy();
    }
  }

  /* ============================== 信令 ============================== */

  class Signaling {
    /**
     * @param {object} o
     * @param {function} o.emit (eventName, payload) => void
     */
    constructor(o) {
      this.emit = o.emit;
      this.peers = new Map();          // peerId -> Peer
      this.selfId = null;
      this.config = { iceServers: [], wsRelay: true };
      this.roomType = null;
      this.roomId = null;
      this.displayName = null;

      this._signalBuffer = new Map();  // peerId -> {msgs:[], at}
      this._pendingRoom = null;
      this._reconnectDelay = 800;
      this._closedByUser = false;

      this._connect();
    }

    /**
     * 信令地址。
     *
     * 特意用一个非静态路径 `/ws`：在 Cloudflare Workers 上，静态资源由
     * Assets 直接命中（不计 Worker 调用），只有这个路径才会进到 Worker 里
     * 交给 Durable Object —— 既省额度，也避免 WS 升级请求被静态资源截胡。
     * 本地 Node 版不分路径，连到 `/ws` 一样能通。
     */
    _url() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const path = typeof window.FD_WS_PATH === 'string' ? window.FD_WS_PATH : '/ws';
      return `${proto}//${location.host}${path}`;
    }

    /**
     * 按需取一次 TURN 凭证（服务端可能因为本月额度用尽而只回 STUN）。
     * 只在 P2P 第一轮打不通时才调用，所以正常情况下根本不消耗 TURN 额度。
     * 结果缓存 8 分钟（凭证 TTL 是 10 分钟）。
     */
    ensureTurnServers() {
      if (this._turnServers && this._turnServersAt + 8 * 60 * 1000 > Date.now()) {
        return Promise.resolve(this._turnServers);
      }
      if (this._turnPromise) return this._turnPromise;

      this._turnPromise = fetch('/turn-credentials', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!j || j.budgetExhausted) {
            this.turnExhausted = true;
            return [];
          }
          const s = j.iceServers;
          if (!s) return [];
          const list = Array.isArray(s) ? s : [s];
          this._turnServers = list;
          this._turnServersAt = Date.now();
          this.emit('turn-ready', { count: list.length });
          return list;
        })
        .catch(() => [])
        .then((v) => { this._turnPromise = null; return v; });

      return this._turnPromise;
    }

    _connect() {
      const ws = new WebSocket(this._url());
      this.ws = ws;

      ws.onopen = () => {
        this._reconnectDelay = 800;
        this.emit('signaling-open', {});
        // 重连后把之前的房间和配对统统重放一遍
        if (this._joinedRoom) this.joinLanRoom();
        if (this.roomCode) this.joinRoom(this.roomCode, true);
        for (const secret of this.roomSecrets || []) this.rejoinRoom(secret);
      };

      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        this._handle(msg);
      };

      ws.onclose = () => {
        this.emit('signaling-closed', {});
        for (const [, p] of this.peers) p.destroy();
        this.peers.clear();
        if (this._closedByUser) return;
        setTimeout(() => this._connect(), this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 1.8, 8000);
      };

      ws.onerror = () => { /* onclose 会跟上来 */ };
    }

    send(obj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
      }
    }

    /* ---------- 对外操作 ---------- */

    joinLanRoom() {
      this._joinedRoom = true;
      this.send({ type: 'join-lan-room' });
    }

    createRoom() { this.send({ type: 'create-room' }); }

    joinRoom(code, createIfInvalid) {
      this.roomCode = code;
      this.send({ type: 'join-room', code, createIfInvalid: !!createIfInvalid });
    }

    leaveRoom(code) {
      if (this.roomCode === code) this.roomCode = null;
      this.send({ type: 'leave-room', roomId: code });
    }

    pairInitiate() { this.send({ type: 'pair-initiate' }); }
    pairJoin(pairKey) { this.send({ type: 'pair-join', pairKey }); }
    pairCancel() { this.send({ type: 'pair-cancel' }); }

    /** 凭保存的 roomSecret 回到长期配对（跨网络用） */
    rejoinRoom(roomSecret) {
      this.roomSecrets = this.roomSecrets || [];
      if (!this.roomSecrets.includes(roomSecret)) this.roomSecrets.push(roomSecret);
      this.send({ type: 'rejoin-room', roomSecret });
    }

    forgetRoom(roomSecret) {
      this.roomSecrets = (this.roomSecrets || []).filter((s) => s !== roomSecret);
    }

    rename(name) { this.send({ type: 'rename', displayName: name }); }

    peer(id) { return this.peers.get(id); }

    /* ---------- 消息处理 ---------- */

    _handle(msg) {
      switch (msg.type) {
        case 'ping':
          this.send({ type: 'pong' });
          break;

        case 'self':
          this.selfId = msg.peerId;
          this.displayName = msg.displayName;
          this.config = msg.config || this.config;
          this.emit('self', msg);
          break;

        case 'peers':
          this.roomType = msg.roomType;
          this.roomId = msg.roomId;
          if (msg.roomType === 'lan') this.lanRoomId = msg.roomId;
          for (const info of msg.peers || []) this._createPeer(info, false, msg.roomType, msg.roomId);
          this.emit('peers', { peers: msg.peers || [], roomType: msg.roomType, roomId: msg.roomId });
          break;

        case 'peer-joined':
          this.roomType = msg.roomType;
          this.roomId = msg.roomId;
          if (msg.roomType === 'lan') this.lanRoomId = msg.roomId;
          this._createPeer(msg.peer, true, msg.roomType, msg.roomId);
          this.emit('peer-joined', { peer: msg.peer, roomType: msg.roomType });
          break;

        case 'peer-left':
          this._removePeer(msg.peerId);
          break;

        case 'peer-renamed': {
          const p = this.peers.get(msg.peerId);
          if (p) { p.setName(msg.displayName); this.emit('peer-renamed', msg); }
          break;
        }

        case 'signal':
          this._routeSignal(msg);
          break;

        case 'relay':
          this._routeRelay(msg);
          break;

        case 'pair-initiated':
          this.emit('pair-initiated', msg);
          break;
        case 'pair-joined':
          // 注意：这条是发给「配对发起方」的。发起方在 pair-initiate 时就已经
          // 被服务端放进 secret 房间了，这里再 rejoin 一次会触发服务端的
          // 「先 leave 再 join」，向对端连发 peer-left + peer-joined —— 抖动会把
          // 正在进行的 SDP 协商打断，导致明明能直连也退化成中继。
          this.emit('pair-joined', msg);
          break;
        case 'pair-invalid':
          this.emit('pair-invalid', msg);
          break;
        case 'room-created':
          this.roomCode = msg.roomId;
          this.emit('room-created', msg);
          break;
        case 'room-joined':
          this.emit('room-joined', msg);
          break;
        case 'room-error':
          this.emit('room-error', msg);
          break;

        default: break;
      }
    }

    _createPeer(info, isCaller, roomType, roomId) {
      const existing = this.peers.get(info.id);
      if (existing) {
        existing.setRoom(roomType, roomId);
        if (info.displayName) existing.setName(info.displayName);
        return existing;
      }

      const peer = new Peer({
        signaling: this,
        id: info.id,
        name: info.displayName,
        isCaller,
        roomType,
        roomId,
        iceServers: this.config.iceServers,
        emit: (ev, payload) => this.emit(ev, payload),
      });
      this.peers.set(peer.id, peer);

      // 补发之前缓存下来的信令（服务端广播与转发之间的竞态）
      const buffered = this._signalBuffer.get(info.id);
      if (buffered) {
        this._signalBuffer.delete(info.id);
        for (const m of buffered.msgs) peer.handleSignal(m);
      }

      this.emit('peer-added', { peerId: peer.id, name: peer.name });
      return peer;
    }

    _routeSignal(msg) {
      const id = msg.senderId;
      const peer = this.peers.get(id);
      if (peer) { peer.handleSignal(msg); return; }

      // 设备对象还没建出来：先缓存
      const entry = this._signalBuffer.get(id) || { msgs: [], at: Date.now() };
      entry.msgs.push(msg);
      this._signalBuffer.set(id, entry);
      setTimeout(() => {
        const cur = this._signalBuffer.get(id);
        if (cur && Date.now() - cur.at >= SIGNAL_BUFFER_TTL - 10) this._signalBuffer.delete(id);
      }, SIGNAL_BUFFER_TTL);

      // 兜底：万一 peer-joined 那条消息丢了，这里补建
      if (msg.senderName !== undefined) {
        this._createPeer(
          { id, displayName: msg.senderName },
          false,
          msg.roomType || this.roomType,
          msg.roomId || this.roomId
        );
      }
    }

    _routeRelay(msg) {
      const peer = this.peers.get(msg.senderId);
      if (peer && msg.payload) peer.deliverRelay(msg.payload);
    }

    _removePeer(peerId) {
      const p = this.peers.get(peerId);
      if (!p) return;
      p.destroy();
      this.peers.delete(peerId);
      this.emit('peer-removed', { peerId });
    }

    close() {
      this._closedByUser = true;
      if (this.ws) this.ws.close();
    }

    peerList() { return [...this.peers.values()]; }
  }

  /* ============================== 导出 ============================== */

  window.FlashDrop = {
    Signaling,
    Peer,
    formatBytes,
    formatSpeed,
    sanitizeName,
    hasFileSystemAccess,
    memoryReceiveLimit,
    memoryReceiveRisk,
    constants: { CHUNK_SIZE, PARTITION_SIZE, BUFFER_HIGH, P2P_TIMEOUT_MS },
  };
})();
