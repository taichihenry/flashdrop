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

/**
 * 安全响应头 —— 与线上（Cloudflare 侧）保持一致。
 *
 * 为什么本地也要加：线上一直带着这套头，本地没有，于是出现「本地测通过、
 * 一上线上就坏」的坑（真踩过：www 归一那段内联 <script> 被 CSP
 * `script-src 'self'` 静默拦掉，DOM 里在、控制台不报错、就是不执行）。
 * 两边环境不一致，本地测试的结论就不可信。
 *
 * 注意不要加 Strict-Transport-Security：本地是 http，加了会把自己顶到 https 打不开。
 */
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",              // 不允许内联脚本；同源外部 .js 才行
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

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
      ...SECURITY_HEADERS,
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
 * 校验前端上报的出口地址，合法才采纳。
 *
 * 为什么需要前端上报：双栈网络里「这次连接走 IPv4 还是 IPv6」由浏览器的
 * Happy Eyeballs 决定，结果不稳定 —— 实测同一台电脑上两个浏览器会一个走
 * IPv4、一个走 IPv6 连进来，被分进两个房间，互相看不见。前端用 STUN 探出
 * 自己的全部出口地址（优先公网 IPv6）上报，分房就与协议无关了。
 *
 * 只收公网地址：私网 / 回环 / 链路本地 / ULA 一律拒绝，否则任何人都能自报
 * 一个地址混进别人的房间。
 *
 * @param {unknown} reported
 * @returns {string|null}
 */
function acceptedReportedAddr(reported) {
  if (typeof reported !== 'string') return null;
  const a = reported.trim();
  if (!a || a.length > 64) return null;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) {
    if (a.split('.').some((n) => Number(n) > 255)) return null;
    return isPrivateIpv4(a) ? null : a;
  }

  if (a.indexOf(':') >= 0) {
    const low = a.toLowerCase();
    if (!/^[0-9a-f:]+$/.test(low)) return null;
    if (low.startsWith('fe80')) return null;
    if (low.startsWith('fc') || low.startsWith('fd')) return null;
    if (low === '::1' || low === '::') return null;
    if (!/^[23][0-9a-f]{3}:/.test(low)) return null;
    return low;
  }

  return null;
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

/**
 * 房间码校验 —— **两种房间码必须分开卡**。
 *
 * 房间码就是进门的唯一凭证（没有任何账号体系），所以它的长度直接等于
 * 「别人撞进你房间」的成本：
 *
 *   - 扫码会话房间：码由前端 crypto.getRandomValues 生成，形态固定 6 位。
 *     6 位空间 = 31^6 ≈ 8.9 亿。若放行 4 位（31^4 ≈ 92 万），穷举一遍
 *     只要几分钟 —— 等于门没锁。所以这里必须卡死 6 位。
 *   - 公共房间：码由用户手输（要能照着屏幕念、照着敲），保持宽松的 4~12 位。
 *
 * ⚠ 改动这里时记得同步 cloudflare/src/room.js 和 public/app.js 的 ROOM_HASH_RE，
 *   三处不一致会出现「前端生成了码、服务端却拒收」的诡异现象。
 */
const SESSION_CODE_RE = /^[a-z0-9]{6}$/;
const PUBLIC_CODE_RE = /^[a-z0-9]{4,12}$/;

/**
 * 单个连接最多能同时待几间房，超出即拒。
 *
 * 房间是「加入即创建」的（扫码房间必须先建后进，否则第一个进房的人会被
 * 判成「房间不存在」），若不封顶，一个连接可以用随机码连续 join 十万次 ——
 * 每次都在 rooms 表里留一个 Map、在 peer.rooms 里留一条记录，是典型的
 * 内存放大。
 *
 * 取值 24 是被 Cloudflare 那侧倒逼的：Durable Object 的
 * serializeAttachment 上限 **16,384 字节**，而一个 secret: 房间 ID 就有
 * 71 个字符，几百个就撑爆了。超出后 attachment 写入会**静默失败**
 * （见 room.js 的 _patch），房间记录凭空消失、状态错乱。
 * Node 版跟着取同一个值，两边行为保持一致。
 *
 * 正常用户远够不着：lan(1) + session(1) + 公共房间(几个) + 历史配对(每台设备 1 个)。
 */
const MAX_ROOMS_PER_PEER = 24;

/**
 * 房间人数上限 —— **必须与 cloudflare/src/room.js 的 ROOM_PEER_LIMITS 逐字一致**。
 *
 * 两边不一致的后果是「本地测好好的、线上一扫码就进不去」：本地版跑的是这份，
 * 而真实部署跑的是 Cloudflare 那份，行为分叉了却很难发现。
 *
 * 取值理由（摘要，详细论证见 room.js 同一处注释）：
 *   · session/secret 2 —— 产品语义就是一对一，2 是上限不是近似值。
 *   · public 12 —— 临时拉几个人的余量。
 *   · lan 64 —— 同一网络自动发现。**不能设小**：CGNAT 下成千上万人共享一个
 *     出口 IP，设小会误伤；但也不能不限，否则一间房就能把广播扇出打到几百。
 */
const ROOM_PEER_LIMITS = {
  session: 2,
  secret: 2,
  public: 12,
  lan: 64,
};
const DEFAULT_ROOM_LIMIT = 64;

/** 全局房间数上限（防房间表无限膨胀）。上限较大，正常用法碰不到。 */
const MAX_ROOMS_TOTAL = 2000;

/** 全局连接数上限。本地版跑在自家电脑上，这条主要是防意外（比如脚本刷连接）。 */
const MAX_CONNECTIONS = 1000;

/**
 * 单连接消息限流（固定 1 秒窗口，条数 + 字节双阈值）。
 *
 * 云端版靠它守住免费额度（每条入站消息都会唤醒 Durable Object 并计一次请求），
 * 本地版靠它防止一条连接把 Node 进程的 CPU 打满。阈值选定的依据是**不能误伤
 * 兜底中继**：中继走的就是这条 WS，文件分片 64 KB、base64 膨胀后约 88 KB/条，
 * 300 条/秒 ≈ 26 MB/s，真实网络达不到但足够不误伤。
 */
const MSG_MAX_PER_SEC = 300;
const MSG_MAX_BYTES_PER_SEC = 24 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ============================== 服务器主体 ============================== */

const DEFAULT_ICE = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];
/*
 * ⚠ 这份列表必须与 public/net.js 的 DEFAULT_ICE_SERVERS、
 *   cloudflare/src/room.js 的 BASE_ICE **逐字一致**（test/ice-config.js 会校验）。
 *   三份漂移过一次，教训是：原来这里只有两个 google STUN，而
 *   stun.l.google.com / stun1.l.google.com 在国内是**不通的** ——
 *   等于国内用户的 P2P 完全没有 STUN，只能收集 host 候选，跨网络必然失败，
 *   静默掉进 WebSocket 中继（慢 + 白烧 DO 额度），界面上还看不出异常。
 *
 * 选型理由：cloudflare 第一（国内可达 + anycast 就近 + 官方免费无限），
 * miwifi 是国内兜底，google 放最后（国内被墙，放前面只会拖慢 ICE 收集）。
 * 顺序不是随意的：ICE 会按顺序试，把可达的放前面才能尽快收敛。
 */

class SignalingServer {
  /**
   * @param {object} conf
   * @param {boolean} conf.trustProxy 是否信任 X-Forwarded-For（反代部署时才开）
   * @param {boolean} conf.ignoreReportedAddr 忽略前端上报的出口地址，只按连接地址分房
   * @param {boolean} conf.wsRelay    是否允许 P2P 失败时退回服务器中继
   * @param {string[]} conf.lanUrls   给手机用的局域网地址，注入到 /api/info
   * @param {number} conf.httpPort
   * @param {number} conf.httpsPort
   * @param {boolean} conf.tls
   */
  constructor(conf = {}) {
    this.conf = Object.assign(
      {
        trustProxy: false, ignoreReportedAddr: false, wsRelay: true,
        lanUrls: [], publicUrl: '', httpPort: null, httpsPort: null, tls: false,
      },
      conf
    );

    // 本机所在的局域网房间。用户在电脑上开的是 127.0.0.1，手机开的是 192.168.x.x，
    // 必须让这两者落到同一间房 —— 否则同一个 Wi-Fi 下反而互相看不见。
    this.localRoomId = lanRoomFromUrls(this.conf.lanUrls);

    this.rooms = new Map();       // roomId -> Map(peerId -> Peer)
    this.peers = new Map();       // peerId -> Peer
    this.pairKeys = new Map();    // 6 位配对码 -> { roomSecret, creatorId, expiresAt }
    this.rate = new Map();        // Peer -> { t, n, bytes }，限流窗口
    this.wsServers = [];
  }

  attach(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, maxPayload: 1 << 25 });
    this.wsServers.push(wss);
    wss.on('connection', (socket, req) => this._onConnection(socket, req));
  }

  /* ------------------------ 连接生命周期 ------------------------ */

  _onConnection(socket, req) {
    // 连接闸门在最前面：拒绝比接收便宜，被拒的连接不进 peers / rooms。
    // 用 1013（稍后重试）而不是直接 terminate，客户端才能把话说清楚。
    if (this.peers.size >= MAX_CONNECTIONS) {
      try { socket.close(1013, '服务器繁忙'); } catch { /* 可能已断开 */ }
      return;
    }

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
        // Node 版没有 TURN 凭证签发端点（TURN 是由 ICE_SERVERS 环境变量直接
        // 注入的，见 README）。显式告诉前端「别去调 /turn-credentials」——
        // 否则每次 P2P 第一轮失败都会白跑一次 404。
        turnAvailable: false,
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
    this.rate.delete(peer);                 // 限流桶跟着连接回收，否则 Map 只增不减

    for (const roomId of [...peer.rooms]) this._leaveRoom(peer, roomId);

    if (peer.pairKey && this.pairKeys.get(peer.pairKey)?.creatorId === peer.id) {
      this.pairKeys.delete(peer.pairKey);
    }
    try { peer.socket.terminate(); } catch { /* noop */ }
  }

  /* ------------------------ 消息分发 ------------------------ */

  _onMessage(peer, buf) {
    // 限流放在解析之前 —— 解析本身就要花 CPU，垃圾消息不该走到那一步。
    if (!this._allowMessage(peer, buf)) {
      this._send(peer, { type: 'error', reason: 'rate-limited', message: '消息过于频繁，连接已断开' });
      try { peer.socket.close(1008, 'rate limited'); } catch { /* 可能已断开 */ }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      // 客户端主动保活（云端版没有服务端心跳，靠它撑住 Cloudflare 的 100 秒空闲超时）
      case 'ping': this._send(peer, { type: 'pong' }); break;
      case 'pong': peer.lastPong = Date.now(); break;

      case 'join-lan-room': {
        // 优先按前端探测到的公网地址分房（解决 IPv4/IPv6 双栈分裂），
        // 探测失败就退回按连接地址分房。
        //
        // ignoreReportedAddr 时一律只认连接地址 —— 上报值毕竟是客户端说了算的，
        // 放在严格信任反代头的部署里，等于把分房依据交给客户端。
        const reported = this.conf.ignoreReportedAddr ? null : acceptedReportedAddr(msg.addr);
        const roomId = reported ? roomIdForIp(reported, this.localRoomId) : peer.ipRoom;
        if (roomId) {
          const r = this._joinRoom(peer, roomId, 'lan');
          // 自动发现的房间满了：CGNAT 下上千人共用一个出口 IP 的典型症状，
          // 那些人本来就不该互相看见，所以不回「房间已满」那种像故障的错，
          // 只回一条提示，让前端把话说清楚（改用配对码 / 房间码即可）。
          if (!r.ok && r.reason === 'room-full') {
            this._send(peer, { type: 'lan-room-full', limit: r.limit });
          }
        }
        break;
      }

      case 'create-room': {
        const roomId = 'pub:' + randomRoomCode(5);
        const r = this._joinRoom(peer, roomId, 'public');
        if (!r.ok) {
          this._send(peer, {
            type: 'room-error', code: r.reason,
            reason: this._roomErrorText(r), count: r.count, limit: r.limit,
          });
          break;
        }
        this._send(peer, { type: 'room-created', roomId: roomId.slice(4) });
        break;
      }
      case 'join-room': {
        const code = String(msg.code || '').trim().toLowerCase();
        // scope='session' 指首页二维码那条「扫码会话房间」：生命周期跟页面一致、
        // 用户不会手动退出；其余（默认）是房间弹窗里临时建的公共房间。
        // 两者共用 pub: 房间空间，只是 roomType 不同 —— 前端按优先级挑一间发信令。
        const scope = msg.scope === 'session' ? 'session' : 'public';
        if (!(scope === 'session' ? SESSION_CODE_RE : PUBLIC_CODE_RE).test(code)) {
          this._send(peer, { type: 'room-error', reason: '格式不对' });
          break;
        }
        const roomId = 'pub:' + code;
        if (!this.rooms.has(roomId) && !msg.createIfInvalid) {
          this._send(peer, { type: 'room-error', reason: '房间不存在' });
          break;
        }
        const rj = this._joinRoom(peer, roomId, scope);
        if (!rj.ok) {
          this._send(peer, {
            type: 'room-error', code: rj.reason,
            reason: this._roomErrorText(rj), count: rj.count, limit: rj.limit,
          });
          break;
        }
        this._send(peer, { type: 'room-joined', roomId: code, scope });
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
          // 只有真进去了才回 ok：否则前端会把它记进「已配对设备」，
          // 下次刷新又来一遍，越攒越多。
          if (this._joinRoom(peer, 'secret:' + msg.roomSecret, 'secret').ok) {
            this._send(peer, { type: 'rejoin-ok', roomSecret: msg.roomSecret });
          }
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

  /**
   * 取房间，不存在就现建 —— 但受全局房间数闸门约束。
   *
   * 单独抽出来是因为「清僵尸」那步有可能把整间房回收掉（_leaveRoom 在房间空了
   * 时会删条目），清理后必须重新取一次；沿用旧引用会拿到已脱钩的孤儿 Map，
   * 往里放的成员在索引里查不到 —— 又变成「同房却互相看不见」。
   *
   * @returns {Map|null} null 表示房间总数已达上限
   */
  _ensureRoom(roomId) {
    let room = this.rooms.get(roomId);
    if (room) return room;
    if (this.rooms.size >= MAX_ROOMS_TOTAL) return null;
    room = new Map();
    this.rooms.set(roomId, room);
    return room;
  }

  /**
   * 把 _joinRoom 的失败原因翻成给用户看的话。
   * 三种失败的处理方式完全不同（换码 / 退出一些房间 / 稍后重试），
   * 笼统回一句「进不去」会被当成网络故障。
   */
  _roomErrorText(r) {
    if (r.reason === 'room-full') {
      return `房间人数已达上限（${r.count}/${r.limit}），请让对方重新生成二维码或改用配对码`;
    }
    if (r.reason === 'server-full') return '服务器繁忙，请稍后重试';
    return '你加入的房间太多了，请刷新页面后重试';
  }

  /**
   * 让 peer 加入房间（房间不存在则现建）。
   *
   * @returns {{ok: true}|{ok: false, reason: string, count?: number, limit?: number}}
   *   reason：'room-full'（人数满）/ 'server-full'（全局房间数或连接数满）
   *   / 'room-limit'（单连接加入房间数超限）。调用方必须把这个结果报给客户端 ——
   *   默默失败会让前端以为进房成功，界面上一直空着却不报错，极难排查。
   */
  _joinRoom(peer, roomId, roomType) {
    // 已在房里：先退出，保证其他端不会收到"先 left 后 joined"的乱序。
    //
    // ⚠ 这一步可能把**整间房**从索引里删掉（房里只剩它自己时就会），
    // 所以下面绝不能复用 leave 之前拿到的那个 Map 引用 —— 那样拿到的是个
    // 已经脱钩的"孤儿 Map"：peer 以为自己进了房、this.rooms 里却查不到，
    // 表现就是「两端都在同一间房，却永远互相看不见」，而且不报任何错。
    if (this.rooms.get(roomId) && this.rooms.get(roomId).has(peer.id)) {
      this._leaveRoom(peer, roomId);
    }

    // 封顶放在 leave 之后：否则「重复加入同一间房」会被自己误判成超限。
    if (peer.rooms.size >= MAX_ROOMS_PER_PEER) return { ok: false, reason: 'room-limit' };

    let room = this._ensureRoom(roomId);
    if (!room) return { ok: false, reason: 'server-full' };

    const limit = ROOM_PEER_LIMITS[roomType] || DEFAULT_ROOM_LIMIT;
    if (room.size >= limit) {
      // 先剔僵尸（socket 已关、但 close 事件还没处理完的连接）再下结论。
      // 少了这一步，「刷新页面」就会把自己挡在门外：旧连接尚未回收，新连接的
      // 加入请求已经到了，于是 2/2 的房间把真正的第二台设备拒掉。
      for (const other of [...room.values()]) {
        if (!other.socket || other.socket.readyState !== 1) this._leaveRoom(other, roomId);
      }
      // _leaveRoom 可能把空房间整条回收 —— 必须重新取，否则后面往里放的是孤儿 Map
      room = this._ensureRoom(roomId);
      if (!room) return { ok: false, reason: 'server-full' };
      if (room.size >= limit) {
        return { ok: false, reason: 'room-full', count: room.size, limit };
      }
    }

    const existing = [];
    for (const other of room.values()) existing.push(this._info(other));

    for (const other of room.values()) {
      this._send(other, { type: 'peer-joined', peer: this._info(peer), roomType, roomId });
    }

    room.set(peer.id, peer);
    peer.rooms.add(roomId);

    this._send(peer, { type: 'peers', peers: existing, roomType, roomId });
    return { ok: true };
  }

  /**
   * 每连接限流（固定 1 秒窗口，条数 + 字节双阈值）。
   * @returns {boolean} false 表示超阈值，调用方应断开这条连接
   */
  _allowMessage(peer, buf) {
    const bytes = buf && buf.length ? buf.length : 0;
    const now = Date.now();
    let b = this.rate.get(peer);
    if (!b || now - b.t >= 1000) {
      b = { t: now, n: 0, bytes: 0 };
      this.rate.set(peer, b);
    }
    b.n++;
    b.bytes += bytes;
    return b.n <= MSG_MAX_PER_SEC && b.bytes <= MSG_MAX_BYTES_PER_SEC;
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

    // 配对要额外占一间 secret: 房间，同样受上限保护；
    // 失败时把刚发出去的配对码一并收回，别留个进不去的死码。
    const rr = this._joinRoom(peer, 'secret:' + roomSecret, 'secret');
    if (!rr.ok) {
      this.pairKeys.delete(pairKey);
      peer.pairKey = null;
      this._send(peer, { type: 'pair-invalid', reason: this._roomErrorText(rr) });
      return;
    }
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

    // 超限时绝不能照常通知对端「配对成功」：对端会切到一个你其实没进去的房间，
    // 症状是「配对提示成功了，但设备列表一直空着」。
    const rj = this._joinRoom(peer, 'secret:' + entry.roomSecret, 'secret');
    if (!rj.ok) {
      this._send(peer, { type: 'pair-invalid', reason: this._roomErrorText(rj) });
      return;
    }

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
      // 对外可达的地址（配了反代 / 内网穿透 / 隧道时由 PUBLIC_URL 指定）。
      // 有它首页二维码才会指向公网地址，扫码房间才能真正跨网络用 ——
      // 否则二维码只能指向内网 IP，只有同一张网里的设备打得开。
      publicUrl: signaling.conf.publicUrl || '',
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
