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
  // 信令保活间隔。必须小于 Cloudflare 的 WebSocket 空闲超时（100 秒），
  // 留足余量取 75 秒。只在页面前台可见时才发（见 _startHeartbeat）。
  const HEARTBEAT_MS = 75 * 1000;
  // 中继背压：WebSocket 没有 bufferedamountlow 事件，只能轮询。
  const RELAY_DRAIN_POLL_MS = 12;            // 轮询间隔
  const RELAY_DRAIN_TIMEOUT_MS = 20 * 1000;  // 兜底上限，网络真断了也别死等
  const RELAY_KX_TIMEOUT_MS = 4000;          // 中继端到端加密协商超时 → 退回明文
  const RELAY_PENDING_MAX = 32 * 1024 * 1024; // 密钥就绪前最多缓存多少字节
  const SIGNAL_BUFFER_TTL = 10000;           // 未知设备信令缓存 10 秒
  const MAX_TEXT_LEN = 256 * 1024;           // 单条文字上限
  const STREAM_TO_DISK_THRESHOLD = 64 * 1024 * 1024; // 超过 64 MB 才提示选目录

  /* ============================== 出口地址探测 ============================== */

  /**
   * 判断一个地址是不是「公网」的，并把它归一成房间 key。
   *
   * 为什么要做这件事，见 probePublicAddr 的注释 —— 简单说：双栈网络里，
   * 同一张网的两台设备可能一台用 IPv4、一台用 IPv6 连到服务器，服务器只能
   * 看到「这次连接用的是哪个」，于是把它俩分进两个房间，互相看不见。
   */

  // 私网 / 回环 / 链路本地 / CGNAT，一律不算公网
  const PRIVATE_V4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

  function isPublicV4(a) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(a) && !PRIVATE_V4.test(a) && a !== '0.0.0.0';
  }

  function isPublicV6(a) {
    if (!a || a.indexOf(':') < 0) return false;
    const low = a.toLowerCase();
    if (low.startsWith('fe80')) return false;            // 链路本地
    if (low.startsWith('fc') || low.startsWith('fd')) return false; // ULA（私网）
    if (low === '::1' || low === '::') return false;     // 回环 / 未指定
    return /^[23][0-9a-f]{3}:/.test(low);                // 2000::/3 才是全球单播
  }

  /** IPv6 取 /64 前缀当房间 key —— 一个家庭/公司通常共享同一个 /64 */
  function v6RoomPrefix(a) {
    const parts = a.split(':');
    while (parts.length < 4) parts.push('');
    return parts.slice(0, 4).map((p) => p || '0').join(':') + '::';
  }

  /** 优先公网 IPv6（最精准），其次公网 IPv4 */
  function pickRoomAddr(addrs) {
    for (const a of addrs) if (isPublicV6(a)) return v6RoomPrefix(a);
    for (const a of addrs) if (isPublicV4(a)) return a;
    return null;
  }

  /**
   * 用一次 STUN 探测，问出本机**所有**出口地址。
   *
   * 背景：服务器按出口 IP 分房（同一个网里的设备自动成房）。但双栈网络下，
   * 「这次连接用 IPv4 还是 IPv6」由浏览器的 Happy Eyeballs 决定，结果不稳定 ——
   * 实测同一台电脑上两个浏览器会一个走 IPv4、一个走 IPv6，被分进两个房间，
   * 互相看不见（设备列表里就是没有对方）。
   *
   * 解法：让前端自己把出口地址问出来报给服务器，优先报公网 IPv6。
   * 只要同一个网络里的设备都能报出同一个 IPv6 /64 前缀，它们就一定同房，
   * 跟这次连的是 IPv4 还是 IPv6 完全无关。
   *
   * 失败或超时（STUN 被防火墙拦）就返回 null，服务器退回按连接地址分房，
   * 不会比现在更差。
   *
   * @returns {Promise<string|null>} 形如 "2409:8a00:2612:2c90::" 或 "120.244.4.3"
   */
  function probePublicAddr(timeoutMs) {
    const limit = timeoutMs || 1500;
    return new Promise((resolve) => {
      if (typeof window.RTCPeerConnection !== 'function') return resolve(null);

      let pc = null;
      let settled = false;
      const addrs = new Set();

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (pc) pc.close(); } catch { /* noop */ }
        resolve(pickRoomAddr(addrs));
      };
      const timer = setTimeout(finish, limit);

      try {
        pc = new RTCPeerConnection({
          iceServers: [
            { urls: 'stun:stun.cloudflare.com:3478' },
            { urls: 'stun:stun.l.google.com:19302' },
          ],
        });
      } catch {
        clearTimeout(timer);
        return resolve(null);
      }

      pc.onicecandidate = (e) => {
        if (!e.candidate) return finish();          // null 候选 = 收集结束
        const a = e.candidate.address;
        if (!a) return;
        addrs.add(a);
        // 拿到公网 IPv6 就够了（最稳的判据），不必等满超时
        if (isPublicV6(a)) finish();
      };

      pc.createDataChannel('probe');
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .catch(() => finish());
    });
  }

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

  /* ============================== 中继端到端加密 ============================== */

  /**
   * 中继通道的端到端加密。
   *
   * 为什么必须做：P2P 直连时数据有 DTLS 端到端加密，就算接 TURN 也只是多一跳中转，
   * 中转节点同样只看得到密文。但 WS 中继不一样 —— 数据在 Worker 里是**明文**的，
   * 服务端事实上进了信任边界。对一个主打「不存储消息」的产品，这个口子必须堵上。
   *
   * 做法：两端各生成一对临时 ECDH(P-256) 密钥，公钥经中继互换（服务端看得见公钥，
   * 但推不出共享密钥），再经 HKDF 派生 AES-256-GCM 密钥。此后所有中继数据都是密文，
   * Worker 只是搬运工，读不懂内容。
   *
   * 原则：加密谈不拢也绝不能让文件传不动 —— 一律退回明文，只在界面上如实告知。
   */

  const KX_INFO = new TextEncoder().encode('flashdrop-relay-v1');
  const ECDH_ALGO = { name: 'ECDH', namedCurve: 'P-256' };
  const CRYPTO_OK = (() => {
    try {
      return !!(window.crypto && window.crypto.subtle && window.crypto.getRandomValues);
    } catch (e) { return false; }
  })();

  /** 生成一对临时 ECDH 密钥，公钥导出成 raw(65B) 的 base64 */
  async function kxGenerate() {
    const pair = await crypto.subtle.generateKey(ECDH_ALGO, true, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    return { privateKey: pair.privateKey, publicB64: bytesToBase64(raw) };
  }

  /** 自己的私钥 + 对端公钥 → AES-256-GCM 密钥 */
  async function kxDerive(privateKey, peerPublicB64) {
    const peerKey = await crypto.subtle.importKey(
      'raw', base64ToBytes(peerPublicB64), ECDH_ALGO, false, []
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerKey }, privateKey, 256
    );
    const hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: KX_INFO },
      hkdf,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /** AES-GCM 封装，输出 iv(12B) || 密文 的 base64 */
  async function aeadSeal(key, plain) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv, 0);
    out.set(ct, iv.length);
    return bytesToBase64(out);
  }

  async function aeadOpen(key, b64) {
    const all = base64ToBytes(b64);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: all.subarray(0, 12) }, key, all.subarray(12)
    );
    return new Uint8Array(pt);
  }

  /* ============================== WebSocket 中继 ============================== */

  /**
   * WebSocket 中继传输：P2P 打不通时的兜底，速度慢但一定能通。
   *
   * 中继协议（都放在 payload 里，用 kind 区分）：
   *   kx     密钥交换，明文，只带公钥
   *   enc    加密数据，内容为 iv || 密文
   *   text   明文文字（对端不支持加密时的兼容路径）
   *   binary 明文二进制（同上）
   *
   * 加密单元的格式：第 1 字节是类型标签（0=二进制，1=文字），其余是正文。
   * 这样一次加密就能同时承载两种数据类型，不用套两层编码。
   */
  class WsRelayTransport {
    constructor(opts) {
      this.kind = 'relay';
      this.opts = opts;
      this.closed = false;

      // --- 端到端加密状态 ---
      this.encrypted = false;       // 密钥是否已就绪（供界面与诊断读取）
      this._aes = null;             // 派生出的 AES 密钥
      this._priv = null;            // 自己的临时 ECDH 私钥
      this._peerPub = null;         // 对端公钥（base64）
      this._kxStarted = false;
      this._kxTimer = null;
      this._plain = false;          // 已确定退回明文

      // --- 缓冲 ---
      this._pending = [];           // 密钥就绪前的出站数据
      this._inbox = [];             // 密钥就绪前收到的密文
      this._pendingBytes = 0;
      this._inflightBytes = 0;      // 已交给加密链、还没写进 socket 的字节
      this._chain = Promise.resolve();      // 出站串行链，保证密封顺序
      this._recvChain = Promise.resolve();  // 入站串行链，保证解密顺序

      // 中继是"假连接"：信令通道本来就在，直接算已打开
      setTimeout(() => { if (!this.closed) opts.onOpen(); }, 0);
    }

    async handleSignal(msg) { /* 中继不需要 SDP/ICE */ }

    /* ------------------------ 出站 ------------------------ */

    sendText(str) { this._submit({ tag: 1, text: str }); }

    sendBinary(buf) {
      const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
      this._submit({ tag: 0, bytes: u8 });
    }

    _unitSize(unit) {
      return unit.tag === 0 ? unit.bytes.byteLength : unit.text.length;
    }

    _submit(unit) {
      if (this.closed) return;
      const size = this._unitSize(unit);
      this._inflightBytes += size;

      if (this._plain) {
        this._emitPlain(unit);
        this._inflightBytes -= size;
        return;
      }
      if (this._aes) {
        this._chain = this._chain.then(() => this._emitUnit(unit));
        return;
      }

      // 密钥还没谈好：先排队，同时把协商推起来
      this._pending.push(unit);
      this._pendingBytes += size;
      this._startKx();
      if (this._plain) return;   // 协商当场就失败了，上面已经发出去

      if (!this._kxTimer) {
        this._kxTimer = setTimeout(() => {
          if (this._aes || this._plain || this.closed) return;
          this._fallbackToPlain('协商超时');
        }, RELAY_KX_TIMEOUT_MS);
      }
      if (this._pendingBytes > RELAY_PENDING_MAX) {
        this._fallbackToPlain('积压过多');
      }
    }

    async _emitUnit(unit) {
      const size = this._unitSize(unit);
      try {
        if (!this.closed && this._aes) {
          const body = unit.tag === 0 ? unit.bytes : new TextEncoder().encode(unit.text);
          const framed = new Uint8Array(1 + body.length);
          framed[0] = unit.tag;
          framed.set(body, 1);
          this._rawSend({ kind: 'enc', data: await aeadSeal(this._aes, framed) });
        }
      } catch (e) {
        // 加密出问题也不能丢数据：这一单元退回明文发
        this._emitPlain(unit);
      } finally {
        this._inflightBytes = Math.max(0, this._inflightBytes - size);
      }
    }

    _emitPlain(unit) {
      if (unit.tag === 1) this._rawSend({ kind: 'text', data: unit.text });
      else this._rawSend({ kind: 'binary', data: bytesToBase64(unit.bytes) });
    }

    _rawSend(payload) {
      if (this.closed) return;
      try { this.opts.sendRelay({ type: 'relay', payload }); } catch (e) { /* 连接已断 */ }
    }

    /* ------------------------ 密钥协商 ------------------------ */

    _startKx() {
      if (this._kxStarted || this._plain) return;
      if (!CRYPTO_OK) { this._fallbackToPlain('浏览器不支持 WebCrypto'); return; }
      this._kxStarted = true;

      kxGenerate().then((kx) => {
        if (this.closed || this._plain) return;
        this._priv = kx.privateKey;
        this._rawSend({ kind: 'kx', pub: kx.publicB64 });
        this._tryDerive();
      }).catch(() => this._fallbackToPlain('密钥生成失败'));
    }

    _onKx(pubB64) {
      if (this._plain || typeof pubB64 !== 'string' || !pubB64) return;
      this._peerPub = pubB64;
      // 对端可能是先发起的那一方，我们也得把自己的公钥送过去
      this._startKx();
      this._tryDerive();
    }

    async _tryDerive() {
      if (this._aes || this._plain || !this._priv || !this._peerPub) return;

      let key;
      try {
        key = await kxDerive(this._priv, this._peerPub);
      } catch (e) {
        this._fallbackToPlain('密钥协商失败');
        return;
      }
      if (this.closed) return;

      this._aes = key;
      this._priv = null;              // 私钥用完即弃，不留在内存里
      this._pendingBytes = 0;
      this.encrypted = true;
      clearTimeout(this._kxTimer);
      this._kxTimer = null;

      // 对端可能比我们更早派生完 —— 先把已经收到的密文排进解密队列
      const inbox = this._inbox;
      this._inbox = [];
      for (const data of inbox) this._queueDecrypt(data);

      // 再把积压的出站数据按原顺序排进加密发送链
      const pending = this._pending;
      this._pending = [];
      for (const unit of pending) this._chain = this._chain.then(() => this._emitUnit(unit));

      this._notice('ok', '中继通道已启用端到端加密（服务端只见密文）');
    }

    _fallbackToPlain(reason) {
      if (this._plain || this._aes) return;
      this._plain = true;
      this.encrypted = false;
      clearTimeout(this._kxTimer);
      this._kxTimer = null;

      const pending = this._pending;
      this._pending = [];
      this._pendingBytes = 0;
      for (const unit of pending) {
        this._emitPlain(unit);
        this._inflightBytes = Math.max(0, this._inflightBytes - this._unitSize(unit));
      }

      const lost = this._inbox.length;
      this._inbox = [];
      this._notice('warn', lost
        ? `中继加密不可用（${reason}），已退回明文；有 ${lost} 段数据未能解密`
        : `中继加密不可用（${reason}），已退回明文传输`);
    }

    _notice(level, text) {
      if (this.opts.onNotice) this.opts.onNotice(level, text);
    }

    /* ------------------------ 入站 ------------------------ */

    /** 由 Peer 把中继回来的数据喂进来 */
    deliver(payload) {
      if (!payload || typeof payload !== 'object') return;

      if (payload.kind === 'kx') { this._onKx(payload.pub); return; }

      // 对端是旧版本（不认识 kx/enc）：立刻退回明文，别让数据卡在队列里
      if (payload.kind === 'text' || payload.kind === 'binary') {
        if (!this._plain && !this._aes) this._fallbackToPlain('对端未启用加密');
        if (payload.kind === 'text') this.opts.onMessage(payload.data);
        else this.opts.onMessage(base64ToBytes(payload.data).buffer);
        return;
      }

      if (payload.kind === 'enc') this._queueDecrypt(payload.data);
    }

    /**
     * 解密必须串行。
     *
     * crypto.subtle.decrypt 是异步的，并行发出去的话**回调顺序不保证**，
     * 一旦乱序，文件分片就会被拼错 —— 而且校验和照样能过，只是内容是坏的。
     * 所以这里用一条 Promise 链把入站严格排队。
     */
    _queueDecrypt(data) {
      if (typeof data !== 'string') return;
      if (!this._aes) {
        // 对端比我们早派生完，先收着（设上限防止被灌爆）
        this._inbox.push(data);
        if (this._inbox.length > 512) this._inbox.shift();
        return;
      }
      this._recvChain = this._recvChain.then(() => this._openEnc(data));
    }

    async _openEnc(data) {
      let framed;
      try {
        framed = await aeadOpen(this._aes, data);
      } catch (e) {
        this._notice('warn', '中继密文解密失败，已丢弃一段数据');
        return;
      }
      const tag = framed[0];
      const body = framed.subarray(1);
      if (tag === 1) this.opts.onMessage(new TextDecoder().decode(body));
      else this.opts.onMessage(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    }

    /* ------------------------ 流控 ------------------------ */

    /**
     * 真实的可写水位。
     *
     * 以前这里直接 `return 0`，于是 Peer 里的
     * `if (transport.bufferedAmount() > BUFFER_HIGH) await drain()` 永远不成立，
     * 中继模式下等于完全没有背压，8 MB 分区会一口气全灌进 socket。
     * 现在把信令 WebSocket 的真实 bufferedAmount 暴露出来，再加上还没密封完的字节。
     */
    bufferedAmount() {
      const ws = this.opts.getBufferedAmount ? this.opts.getBufferedAmount() : 0;
      return (Number(ws) || 0) + this._inflightBytes;
    }

    /** WebSocket 没有 bufferedamountlow 事件，只能轮询等水位降下来 */
    drain() {
      return new Promise((resolve) => {
        const startedAt = Date.now();
        const tick = () => {
          if (this.closed) return resolve();
          if (this.bufferedAmount() <= BUFFER_LOW) return resolve();
          if (Date.now() - startedAt > RELAY_DRAIN_TIMEOUT_MS) return resolve();
          setTimeout(tick, RELAY_DRAIN_POLL_MS);
        };
        setTimeout(tick, RELAY_DRAIN_POLL_MS);
      });
    }

    isOpen() { return !this.closed; }

    destroy() {
      this.closed = true;
      clearTimeout(this._kxTimer);
      this._kxTimer = null;
      this._pending = [];
      this._inbox = [];
      this._pendingBytes = 0;
      this._aes = null;
      this._priv = null;
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
        // 中继传输要用到这两个：真实写水位（背压）和面向用户的提示
        getBufferedAmount: () => this._sigBuffered(),
        onNotice: (level, text) => this.emit('notice', { level, text }),
      };

      // 调试开关：强制走中继，用来验证中继链路（端到端加密、背压、流控）。
      // 只有显式设置这个全局变量才会生效，普通用户碰不到。
      if (window.FD_FORCE_RELAY) {
        this.transport = new WsRelayTransport(common);
        return;
      }

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
        getBufferedAmount: () => this._sigBuffered(),
        onNotice: (level, text) => this.emit('notice', { level, text }),
      });
      this.emit('peer-state', { peerId: this.id, state: 'switching', reason });
    }

    /** 信令 socket 当前积压的字节数，中继模式拿它当背压依据 */
    _sigBuffered() {
      const ws = this.signaling && this.signaling.ws;
      return ws ? (Number(ws.bufferedAmount) || 0) : 0;
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
      this._hbTimer = null;            // 信令保活定时器

      // 出口地址探测。与信令连接并行跑（不阻塞），进房间时会等它的结果。
      this._addrProbe = probePublicAddr();
      this._probedAddr = null;

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
     * 信令保活。
     *
     * 为什么必须有：Cloudflare 对 WebSocket 有 **100 秒空闲超时**（期间没有
     * 任何数据帧就断开）。而 FlashDrop 的服务端刻意不做 setInterval 心跳
     * （怕不停唤醒 Durable Object 烧额度），客户端也只是被动回 pong ——
     * 也就是双方都不主动说话。结果用户只要挂着页面不动，信令就会在 100 秒后
     * 被平台掐断；而 ws.onclose 又会把 peers 全部销毁，**正在传的文件当场中断**。
     * 表现出来就是：「两台设备明明互相看得见，就是传不过去」。
     *
     * 这里做了两个克制：
     *   1. 只在页面**前台可见**时才发 —— 用户切走了就没必要占着连接，切回来会
     *      自动重连；这也把 Durable Object 的唤醒次数压到最低。
     *   2. 只在连接确实是 OPEN 时才发，避免往一个已死的 socket 里灌数据。
     */
    _startHeartbeat() {
      this._stopHeartbeat();
      this._hbTimer = setInterval(() => {
        if (this._closedByUser) return;
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ type: 'ping' });
      }, HEARTBEAT_MS);
    }

    _stopHeartbeat() {
      if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
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
      // 新连接 = 入房闸门重新打开（否则重连后就再也进不了房了）
      this._lanJoinPending = false;

      ws.onopen = () => {
        this._reconnectDelay = 800;
        this._startHeartbeat();
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
        this._stopHeartbeat();
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
        return true;
      }
      return false;   // 没发出去，调用方可以据此重试
    }

    /* ---------- 对外操作 ---------- */

    /**
     * 进「同一个网络的设备」房间。
     *
     * 不把地址写死，而是等一次出口地址探测（最多 1.5 秒）再入房：带上探测到的
     * 公网地址，服务器就能按**真实网络**而不是**这次连接用的协议**来分房。
     * 探测没结果就照常入房，服务器退回按连接地址分房，行为不比以前差。
     */
    joinLanRoom() {
      this._joinedRoom = true;

      // 同一条连接上只排一次入房。
      //
      // 为什么必须挡：main() 会在信号 socket 刚建好（还没 open）时调一次这里，
      // 而 socket 的 onopen 看到 _joinedRoom 已经为真又会重放一次 —— 于是
      // join-lan-room 被发了两遍。服务端 _joinRoom 对"已在房里"的处理是
      // 先 leave 再 join，而 leave 在房间变空时会把**整间房从索引里删掉**，
      // 紧接着那次 join 拿到的是个已经脱钩的对象 —— 结果就是
      // 「两端都显示在同一间房，却永远互相看不见」，而且看起来毫无报错。
      if (this._lanJoinPending) return;
      this._lanJoinPending = true;

      const send = () => {
        const sent = this.send(
          this._probedAddr
            ? { type: 'join-lan-room', addr: this._probedAddr }
            : { type: 'join-lan-room' }
        );
        // socket 还没 open 就等于白发：放开闸门，交给 onopen 重放
        if (!sent) this._lanJoinPending = false;
      };

      const probe = this._addrProbe || Promise.resolve(null);
      probe
        .then((addr) => { this._probedAddr = addr; send(); })
        .catch(() => { this._probedAddr = null; send(); });
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
    probePublicAddr,
    constants: { CHUNK_SIZE, PARTITION_SIZE, BUFFER_HIGH, P2P_TIMEOUT_MS },
  };
})();
