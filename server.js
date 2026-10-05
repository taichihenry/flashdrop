'use strict';
/**
 * FlashDrop 信令服务器
 * ---------------------------------------------------------------------------
 * 职责只有两件（刻意如此）：
 *   1. 帮设备互相"看见"——按 IP 网段把浏览器分进同一个房间，广播上线/下线
 *   2. 帮设备交换 SDP / ICE——即 WebRTC 握手用的那几段文本
 *
 * 它【不接触】文件内容：文件走浏览器之间的 WebRTC DataChannel 直传。
 * 唯一的例外是 WS_RELAY 兜底：当两端 P2P 打不通时，才会退化成服务器转发，
 * 此时页面会明确提示"已切换为服务器中继"，不会偷偷摸摸地中转。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PUBLIC_DIR = path.join(__dirname, 'public');
const VENDOR_DIR = path.join(PUBLIC_DIR, 'vendor');

/* ============================== 静态资源 ============================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/**
 * 把依赖里的二维码库复制到 public/vendor，让 public/ 保持自包含
 * （局域网离线场景下不能用 CDN，否则手机打开时白屏）
 */
function ensureVendorAssets() {
  const tasks = [
    ['qrcode-generator/qrcode.js', 'qrcode.js'],
    ['qrcode-generator/js/qrcode.js', 'qrcode.js'],
  ];
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  if (fs.existsSync(path.join(VENDOR_DIR, 'qrcode.js'))) return;

  for (const [from, to] of tasks) {
    const src = path.join(__dirname, 'node_modules', from);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(VENDOR_DIR, to));
      return;
    }
  }
  console.warn('[warn] 没找到 qrcode-generator，二维码功能会降级为纯文本链接');
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  // 防路径穿越：解析后必须仍在 PUBLIC_DIR 之内
  const filePath = path.resolve(PUBLIC_DIR, '.' + urlPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    }).end(data);
  });
}

/* ============================== IP → 房间 ============================== */

function normalizeIp(raw) {
  let ip = String(raw || '').split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip || '0.0.0.0';
}

function isPrivateIpv4(ip) {
  return ip === '127.0.0.1' ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip);
}

/**
 * 从给手机用的局域网地址里，反推出"本机所在的局域网房间"。
 * 例：['https://192.168.1.5:8687'] → 'lan:192.168.1'
 */
function lanRoomFromUrls(urls) {
  for (const u of urls || []) {
    try {
      const h = new URL(u).hostname;
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h) && !h.startsWith('127.')) {
        return 'lan:' + h.split('.').slice(0, 3).join('.');
      }
    } catch { /* 忽略非法项 */ }
  }
  return null;
}

/**
 * 房间划分策略（这是整套"自动发现"的关键）：
 *   · 回环地址（127.x）→ **归入本机所在的那个局域网房间**。
 *     这一条是必须的：用户在电脑上开的是 http://127.0.0.1:8686，
 *     而手机开的是 http://192.168.1.5:8686，如果两者被当成两个网段，
 *     同一个 Wi-Fi 下反而互相看不见 —— 这是最容易踩且最难察觉的坑。
 *   · 私网 IPv4（192.168.x.x 等）→ 按 /24 聚合，例如 lan:192.168.1
 *     同一个 Wi-Fi 下的手机和电脑因此落进同一间房，互相可见。
 *   · 公网 IPv4 → 原样作房间，避免和同 ISP 的陌生用户串台。
 *   · IPv6 → 按 /64 聚合。
 *
 * 参考实现 PairDrop 的做法更粗暴：私网 IP 一律改写成 127.0.0.1，
 * 所有人都挤一间房。按 /24 细化后，同一个服务器下如果有多个不同内网，
 * 彼此不会互相看见。
 *
 * @param {string} ip
 * @param {string|null} [localRoomId] 本机局域网房间，由 lanRoomFromUrls 推出
 */
function roomIdForIp(ip, localRoomId) {
  if (ip.includes(':')) return 'v6:' + ip.split(':').slice(0, 4).join(':');
  if (/^127\./.test(ip)) return localRoomId || 'lan:127.0.0';
  if (isPrivateIpv4(ip)) return 'lan:' + ip.split('.').slice(0, 3).join('.');
  return 'wan:' + ip;
}

/* ============================== 设备名推断 ============================== */

function guessDeviceName(ua = '') {
  let os = '未知设备';
  if (/iPhone/i.test(ua)) os = 'iPhone';
  else if (/iPad/i.test(ua)) os = 'iPad';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Windows/i.test(ua)) os = 'Windows 电脑';
  else if (/Macintosh|Mac OS X/i.test(ua)) os = 'Mac';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = '';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua)) browser = 'Safari';

  return browser ? `${os} · ${browser}` : os;
}

/* ============================== 工具 ============================== */

const ROOM_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 去掉易混字符
function randomRoomCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += ROOM_CODE_ALPHABET[crypto.randomInt(0, ROOM_CODE_ALPHABET.length)];
  }
  return s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ============================== 服务器主体 ============================== */

const DEFAULT_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

class SignalingServer {
  /**
   * @param {object} conf
   * @param {boolean} conf.trustProxy 是否信任 X-Forwarded-For（反代部署时才开）
   * @param {boolean} conf.wsRelay    是否允许 P2P 失败时退回服务器中继
   * @param {string[]} conf.lanUrls   给手机用的局域网地址，注入到 /api/info
   * @param {number} conf.httpPort
   * @param {number} conf.httpsPort
   * @param {boolean} conf.tls
   */
  constructor(conf = {}) {
    this.conf = Object.assign(
      { trustProxy: false, wsRelay: true, lanUrls: [], httpPort: null, httpsPort: null, tls: false },
      conf
    );

    // 本机所在的局域网房间。用户在电脑上开的是 127.0.0.1，手机开的是 192.168.x.x，
    // 必须让这两者落到同一间房 —— 否则同一个 Wi-Fi 下反而互相看不见。
    this.localRoomId = lanRoomFromUrls(this.conf.lanUrls);

    this.rooms = new Map();       // roomId -> Map(peerId -> Peer)
    this.peers = new Map();       // peerId -> Peer
    this.pairKeys = new Map();    // 6 位配对码 -> { roomSecret, creatorId, expiresAt }
    this.wsServers = [];
  }

  attach(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, maxPayload: 1 << 25 });
    this.wsServers.push(wss);
    wss.on('connection', (socket, req) => this._onConnection(socket, req));
  }

  /* ------------------------ 连接生命周期 ------------------------ */

  _onConnection(socket, req) {
    const rawIp = this._clientIp(req);
    const peer = {
      id: crypto.randomUUID(),
      socket,
      rawIp,
      ipRoom: roomIdForIp(rawIp, this.localRoomId),
      rooms: new Set(),          // 当前所在房间 id
      displayName: guessDeviceName(req.headers['user-agent']),
      joinedAt: Date.now(),
      lastPong: Date.now(),
      pairKey: null,
    };
    this.peers.set(peer.id, peer);

    socket.on('message', (buf) => this._onMessage(peer, buf));
    socket.on('close', () => this._disconnect(peer));
    socket.on('error', () => { /* 忽略，close 会跟着来 */ });

    this._send(peer, {
      type: 'self',
      peerId: peer.id,
      displayName: peer.displayName,
      deviceName: guessDeviceName(req.headers['user-agent']),
      config: {
        iceServers: this.conf.iceServers || DEFAULT_ICE,
        wsRelay: this.conf.wsRelay,
      },
    });

    this._startKeepAlive(peer);
  }

  _clientIp(req) {
    if (this.conf.trustProxy) {
      const fwd = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
      if (fwd) return normalizeIp(fwd);
    }
    return normalizeIp(req.socket.remoteAddress);
  }

  _startKeepAlive(peer) {
    peer.keepAlive = setInterval(() => {
      if (Date.now() - peer.lastPong > 20000) {
        this._disconnect(peer);
        return;
      }
      this._send(peer, { type: 'ping' });
    }, 5000);
  }

  _disconnect(peer) {
    if (!this.peers.has(peer.id)) return;   // 幂等
    clearInterval(peer.keepAlive);
    this.peers.delete(peer.id);

    for (const roomId of [...peer.rooms]) this._leaveRoom(peer, roomId);

    if (peer.pairKey && this.pairKeys.get(peer.pairKey)?.creatorId === peer.id) {
      this.pairKeys.delete(peer.pairKey);
    }
    try { peer.socket.terminate(); } catch { /* noop */ }
  }

  /* ------------------------ 消息分发 ------------------------ */

  _onMessage(peer, buf) {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'pong': peer.lastPong = Date.now(); break;

      case 'join-lan-room': this._joinRoom(peer, peer.ipRoom, 'lan'); break;

      case 'create-room': {
        const roomId = 'pub:' + randomRoomCode(5);
        this._joinRoom(peer, roomId, 'public');
        this._send(peer, { type: 'room-created', roomId: roomId.slice(4) });
        break;
      }
      case 'join-room': {
        const code = String(msg.code || '').trim().toLowerCase();
        if (!/^[a-z0-9]{4,12}$/.test(code)) {
          this._send(peer, { type: 'room-error', reason: '格式不对' });
          break;
        }
        const roomId = 'pub:' + code;
        if (!this.rooms.has(roomId) && !msg.createIfInvalid) {
          this._send(peer, { type: 'room-error', reason: '房间不存在' });
          break;
        }
        this._joinRoom(peer, roomId, 'public');
        this._send(peer, { type: 'room-joined', roomId: code });
        break;
      }
      case 'leave-room':
        if (msg.roomId) this._leaveRoom(peer, 'pub:' + String(msg.roomId).toLowerCase());
        break;

      case 'pair-initiate': this._pairInitiate(peer); break;
      case 'pair-join': this._pairJoin(peer, msg); break;
      case 'pair-cancel':
        if (peer.pairKey) { this.pairKeys.delete(peer.pairKey); peer.pairKey = null; }
        break;
      case 'rejoin-room':
        // 重连后凭已保存的 roomSecret 回到旧配对
        if (typeof msg.roomSecret === 'string' && /^[0-9a-f]{32,128}$/i.test(msg.roomSecret)) {
          this._joinRoom(peer, 'secret:' + msg.roomSecret, 'secret');
          this._send(peer, { type: 'rejoin-ok', roomSecret: msg.roomSecret });
        }
        break;
      case 'rename': {
        const name = String(msg.displayName || '').slice(0, 24).trim();
        if (!name) break;
        peer.displayName = name;
        for (const roomId of peer.rooms) {
          for (const other of this.rooms.get(roomId)?.values() || []) {
            if (other.id !== peer.id) {
              this._send(other, { type: 'peer-renamed', peerId: peer.id, displayName: name });
            }
          }
        }
        break;
      }

      case 'signal': this._relay(peer, msg); break;
      case 'relay': this._relay(peer, msg); break;   // WS 兜底：同样只在同房间内转发

      default: break;
    }
  }

  /* ------------------------ 房间管理 ------------------------ */

  _joinRoom(peer, roomId, roomType) {
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, new Map());
    const room = this.rooms.get(roomId);

    // 已在房里：先退出，保证其他端不会收到"先 left 后 joined"的乱序
    if (room.has(peer.id)) this._leaveRoom(peer, roomId);

    const existing = [];
    for (const other of room.values()) existing.push(this._info(other));

    for (const other of room.values()) {
      this._send(other, { type: 'peer-joined', peer: this._info(peer), roomType, roomId });
    }

    room.set(peer.id, peer);
    peer.rooms.add(roomId);

    this._send(peer, { type: 'peers', peers: existing, roomType, roomId });
  }

  _leaveRoom(peer, roomId) {
    const room = this.rooms.get(roomId);
    peer.rooms.delete(roomId);
    if (!room || !room.has(peer.id)) return;

    room.delete(peer.id);
    if (room.size === 0) { this.rooms.delete(roomId); return; }

    for (const other of room.values()) {
      this._send(other, { type: 'peer-left', peerId: peer.id, roomId });
    }
  }

  /* ------------------------ 设备配对（跨网络） ------------------------ */

  _pairInitiate(peer) {
    const roomSecret = crypto.randomBytes(32).toString('hex');
    let pairKey;
    do {
      pairKey = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    } while (this.pairKeys.has(pairKey));

    if (peer.pairKey) this.pairKeys.delete(peer.pairKey);
    peer.pairKey = pairKey;
    this.pairKeys.set(pairKey, { roomSecret, creatorId: peer.id, expiresAt: Date.now() + 10 * 60 * 1000 });

    this._joinRoom(peer, 'secret:' + roomSecret, 'secret');
    this._send(peer, { type: 'pair-initiated', pairKey, roomSecret });
  }

  _pairJoin(peer, msg) {
    const pairKey = String(msg.pairKey || '').trim();
    const entry = this.pairKeys.get(pairKey);

    if (!entry || entry.expiresAt < Date.now() || entry.creatorId === peer.id) {
      this._send(peer, { type: 'pair-invalid', reason: '配对码无效或已过期' });
      return;
    }

    const creator = this.peers.get(entry.creatorId);
    // 一次性使用，用完即焚
    this.pairKeys.delete(pairKey);
    if (creator) creator.pairKey = null;

    this._joinRoom(peer, 'secret:' + entry.roomSecret, 'secret');

    this._send(peer, { type: 'pair-joined', roomSecret: entry.roomSecret, peerId: entry.creatorId });
    if (creator) {
      this._send(creator, { type: 'pair-joined', roomSecret: entry.roomSecret, peerId: peer.id });
    }
  }

  /* ------------------------ 转发 ------------------------ */

  /**
   * 只在发送者所在的同一个房间里转发。
   *
   * ⚠ 必须校验 room.has(sender.id)：只判断「房间存在 + 目标在房间里」是不够的。
   * 房间是公开可猜的（pub: 房间码会外传，lan:/wan: 由 IP 推导），而 peerId 一旦
   * 在房间里广播过就被记住了 —— 如果不校验发送者身份，一个**已经退出房间**的人
   * 仍能继续往里面投递 SDP/ICE，甚至用 relay 类型塞任意数据。
   */
  _relay(sender, msg) {
    const roomId = msg.roomId;
    const room = roomId ? this.rooms.get(roomId) : null;
    if (!room) return;
    if (!room.has(sender.id)) return;

    const target = msg.to ? room.get(msg.to) : null;
    if (!target) return;

    const out = Object.assign({}, msg, {
      to: undefined,
      senderId: sender.id,
      senderName: sender.displayName,
      senderRtc: sender.rtcSupported !== false,
    });
    delete out.to;
    this._send(target, out);
  }

  _info(peer) {
    return { id: peer.id, displayName: peer.displayName, ip: peer.rawIp };
  }

  _send(peer, message) {
    if (!peer || !peer.socket) return;
    if (peer.socket.readyState !== 1 /* OPEN */) return;
    try {
      peer.socket.send(JSON.stringify(message));
    } catch { /* 连接正在关闭，忽略 */ }
  }

  close() {
    for (const wss of this.wsServers) {
      for (const client of wss.clients) { try { client.terminate(); } catch { /* noop */ } }
      wss.close();
    }
  }
}

/* ============================== 启动 ============================== */

/**
 * @param {object} conf
 * @param {number} conf.httpPort
 * @param {number} [conf.httpsPort]    给了才起 HTTPS
 * @param {{key:string, cert:string}} [conf.tls]
 * @param {string[]} [conf.lanUrls]
 * @param {boolean} [conf.trustProxy]
 * @param {boolean} [conf.wsRelay]
 * @param {Array} [conf.iceServers]
 * @returns {Promise<{signaling: SignalingServer, servers: object[], baseUrl: string}>}
 */
async function start(conf) {
  ensureVendorAssets();
  const http = require('http');
  const https = require('https');

  const signaling = new SignalingServer(conf);
  const servers = [];

  const infoJson = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }).end(JSON.stringify({
      lanUrls: signaling.conf.lanUrls || [],
      httpPort: signaling.conf.httpPort,
      httpsPort: signaling.conf.httpsPort,
      tls: !!conf.tls,
      wsRelay: signaling.conf.wsRelay !== false,
    }));
  };

  // HTTPS 优先：手机浏览器要求安全上下文才允许 WebRTC
  if (conf.tls && conf.httpsPort) {
    const secure = https.createServer(conf.tls, (req, res) => {
      if (req.url === '/api/info') return infoJson(req, res);
      serveStatic(req, res);
    });
    await new Promise((r) => secure.listen(conf.httpsPort, '0.0.0.0', r));
    signaling.attach(secure);
    servers.push(secure);
  }

  const plain = http.createServer((req, res) => {
    if (req.url === '/api/info') return infoJson(req, res);
    serveStatic(req, res);
  });
  await new Promise((r) => plain.listen(conf.httpPort, '0.0.0.0', r));
  signaling.attach(plain);
  servers.push(plain);

  return { signaling, servers };
}

module.exports = { start, SignalingServer, roomIdForIp, lanRoomFromUrls, guessDeviceName, ensureVendorAssets };
