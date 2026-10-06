'use strict';
/**
 * FlashDrop 信令 Durable Object
 * ===========================================================================
 * 这是 Node 版 server.js 里 SignalingServer 的 Cloudflare 移植版。
 *
 * 架构选择：一个 DO 实例（name = 'global'）承载整套信令。
 *   Cloudflare 的 DO 是「按 ID 分片的单线程对象」，很自然会想到「一间房一个 DO」，
 *   但 FlashDrop 里一个客户端会同时待在多个房间（ipRoom / 公共房间 / 配对房间），
 *   而一条 WebSocket 只能归属一个 DO —— 拆成多 DO 反而要把消息在 DO 之间来回转发。
 *   所以这里反过来：全局一个实例，房间表放在它内存里，协议与 Node 版完全一致，
 *   前端一行都不用改。单个 DO 官方可承载数千 WS 长连接，量级上够用。
 *
 * 关键：必须用 WebSocket Hibernation API（ctx.acceptWebSocket）。
 *   普通 accept() 会让 DO 在整条连接存活期间持续占用 duration —— 按免费额度
 *   （13,000 GB-s/天 ≈ 单个 128MB 实例常驻约 28 小时）算，一个用户挂一天就吃满了。
 *   用休眠 API 后，空闲连接不产生 duration 费用，只有实际收发消息时才唤醒。
 *
 * 代价是**内存状态会在休眠后丢失**，所以：
 *   · 房间表 → 用 ctx.getWebSockets() + attachment 懒重建（见 _rooms()）
 *   · 配对码 → 落到 DO storage（跨休眠存活，且需要 TTL）
 * 另外绝不能再用 setInterval 心跳（会不停唤醒 DO），连接存活性交给 Cloudflare 处理。
 */

/* ============================== 常量 ============================== */

/**
 * 打洞用的 STUN。
 *
 * ⚠ 必须与 public/net.js 的 DEFAULT_ICE_SERVERS、server.js 的 DEFAULT_ICE
 *   **逐字一致**（test/ice-config.js 会校验三份是否漂移）。
 *
 * cloudflare 放第一：它由 Cloudflare 自己提供，官方明确写「STUN 免费且不限量」，
 * 且不计入 Realtime 那 1000 GB/月 的计费额度（计费的只有 TURN 中继出口流量）。
 * miwifi 是国内兜底（google 的两个 STUN 在国内不通，不能只靠它们）。
 */
export const BASE_ICE = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

/**
 * 组装下发给客户端的自述配置（`self` 消息里的 config）。
 *
 * 为什么抽成独立函数：这段以前是内联在 fetch() 里的，于是「测试要断言它」
 * 只能跟着硬编码一份，服务端真改了配置前端却不知道 —— 这类漂移测不出来。
 * 现在服务端和测试共用同一份构造逻辑。
 *
 * `autoDiscover` 是给界面用的：WAN_ROOM_MODE=off 时服务端**不会**回任何
 * 房间消息（连 lan-room-full 都不会回，因为压根没尝试入房），前端只看到
 * 一个空的「附近设备」列表，会以为是 bug。把这个开关下发给前端，界面才能
 * 把原因说清楚、并引导用户改用二维码 / 房间码。
 */
export function buildSelfConfig(env = {}) {
  return {
    iceServers: BASE_ICE,
    wsRelay: env.WS_RELAY !== 'off',
    // 告诉前端「本服务带 TURN 闸门」，前端才会在 P2P 失败时去要凭证
    turnAvailable: !!(env.TURN_KEY_ID || env.TURN_KEY_SECRET),
    // false = 本站没有自动发现，必须靠二维码 / 房间码 / 配对码
    autoDiscover: (env.WAN_ROOM_MODE || 'ip') !== 'off',
  };
}

const ROOM_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 去掉易混字符
const PAIR_TTL_MS = 10 * 60 * 1000;   // 配对码 10 分钟有效
const MAX_NAME_LEN = 24;

/**
 * 房间码校验 —— 必须与 server.js、public/app.js 的 ROOM_HASH_RE 逐字一致。
 *
 * 房间码是进门的唯一凭证（这套东西没有账号体系），码长直接等于「别人撞进
 * 你房间」的成本：扫码房间固定 6 位（31^6 ≈ 8.9 亿），放行 4 位就只有
 * 92 万，穷举几分钟的事。公共房间要照顾用户手输，保持 4~12 位。
 */
const SESSION_CODE_RE = /^[a-z0-9]{6}$/;
const PUBLIC_CODE_RE = /^[a-z0-9]{4,12}$/;

/**
 * 单个连接最多同时待几间房。
 *
 * 上限是 DO 的 serializeAttachment 倒逼出来的：官方文档给的上限是
 * **16,384 字节**（超限直接抛错）。一个 secret: 房间 ID 有 71 个字符
 * （'secret:' + 64 位 hex），配上 peerId/displayName 等字段，几百个就撑爆。
 * 而 _patch 的写入是 try/catch 的（连接随时可能已关闭，不能让它抛），
 * 一旦超限就**静默失败** —— rooms 记录凭空少几条、房间状态错乱，
 * 比直接拒绝难查得多。正常用户远够不着这个数。
 */
const MAX_ROOMS_PER_CONN = 24;

/**
 * 房间人数上限 —— 按房间语义分别设，这是「防转发」和「防烧额度」共用的那道闸门。
 *
 * 两个不同的理由指向同一个手段：
 *
 *   ① 防转发（隐私）。房间号是进门唯一凭证，二维码一旦被截图转发，拿到的人
 *      就都进得来 —— 码长只防瞎猜，防不了转发。限死人数才真正关掉这个口子。
 *   ② 防烧额度（成本）。单实例 DO 串行处理消息，房间人数直接等于每次广播的
 *      扇出；不限的话，恶意用户可以用一间房把 CPU/duration 额度拉满，结果是
 *      **整个信令服务在免费额度触顶后直接报错停摆**（免费计划超额是失败，
 *      不是扣费，但服务一样是挂了）。
 *
 * 取值依据：
 *   · session 2 —— 扫码会话房间的产品语义就是「一台设备 + 一个扫码端」，
 *     2 是上限不是近似值。第 3 个人进不来，正是我们想要的行为。
 *   · secret  2 —— 配对天然一对一（pair-initiate / pair-join 只认两台）。
 *   · public  12 —— 给「临时拉几个人互传」留的余量，再多该改用配对了。
 *   · lan     64 —— 同一网络自动发现。**这个不能设小**：国内运营商大量
 *     CGNAT，成千上万人共享同一个出口 IP，上限太小会误伤；但也不能不限，
 *     否则一间房就能把广播扇出打到几百（顺带说明：这种人本来就不该互相
 *     看见，所以超限时是静默不入房，而不是报错）。
 */
const ROOM_PEER_LIMITS = {
  session: 2,
  secret: 2,
  public: 12,
  lan: 64,
};
const DEFAULT_ROOM_LIMIT = 64;

/** 全局房间数上限（防止房间表无限膨胀，把 DO 内存吃光）。 */
const MAX_ROOMS_TOTAL = 2000;

/**
 * 全局连接数上限。官方说单实例最多 32,768 条 WS，但 CPU/内存会先到瓶颈，
 * 而单 DO 的请求吞吐软上限约 1,000 次/秒 —— 所以取 1000 条连接作为闸门，
 * 把这个实例一天的额度消耗压在免费额度以内（算法见 README「成本」一节）。
 * 两个数都允许用 env 覆盖，方便压测和按需调参。
 */
const MAX_CONNECTIONS = 1000;

/**
 * 单连接消息限流（固定窗口，1 秒）。
 *
 * 为什么要限：每条入站消息都会**唤醒 DO 并计一次请求额度**（WS 消息按 20:1
 * 折算成请求），持续刷消息就是把 duration 和请求数一起烧穿。限流是最后一道
 * 闸门 —— 超限直接断线，而不是继续陪着刷。
 *
 * 阈值为什么敢设这么宽：P2P 打不通时的**兜底中继走的就是这条 WS**，文件分片
 * 是 64 KB 一片，base64 膨胀后约 88 KB/条。300 条/秒 ≈ 26 MB/s，真实网络
 * 达不到（局域网这种带宽早就 P2P 直连了），但足够不误伤正常中继传输。
 * 换来的硬保证是：任何一条连接每秒最多只能让 DO 做 300 次处理。
 */
const MSG_MAX_PER_SEC = 300;
const MSG_MAX_BYTES_PER_SEC = 24 * 1024 * 1024;

/**
 * 保活消息的自动响应 —— **这条是纯省钱，务必别改坏**。
 *
 * 客户端每 75 秒发一条 `{"type":"ping"}`（Cloudflare 的 WS 有 100 秒空闲
 * 超时）。如果让它走 webSocketMessage，每次都会唤醒 DO 一次：即使什么都没干，
 * DO 也被拉进活动状态、产生 duration 计费 —— 挂了 1000 个页面就是每秒都有
 * 唤醒，DO 永远睡不着。
 *
 * setWebSocketAutoResponse 让运行时**在休眠状态下直接回包，不唤醒实例、
 * 不产生 wall-clock 计费**（官方文档原文）。
 *
 * ⚠ 匹配是**逐字精确**的字符串比较。字符串必须与 public/net.js 里
 *   `this.send({ type: 'ping' })` 经 JSON.stringify 后的结果完全一致。
 *   前端哪天把对象写成 `{ type: 'ping' }` 带空格、或换个字段顺序，自动响应
 *   就**静默失效** —— 不报错、功能正常，只是开始悄悄按满额计费。
 *   所以两边都把这个字面量写死，并有测试守着（do-sim 断言精确匹配）。
 */
const PING_MSG = '{"type":"ping"}';
const PONG_MSG = '{"type":"pong"}';

/* ============================== 工具 ============================== */

function normalizeIp(raw) {
  let ip = String(raw || '').split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip || '0.0.0.0';
}

function isPrivateIpv4(ip) {
  return /^127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip);
}

/**
 * 校验前端上报的出口地址，合法才采纳。
 *
 * 为什么需要前端上报：双栈网络里，「这次连接走 IPv4 还是 IPv6」由浏览器的
 * Happy Eyeballs 决定，结果不稳定。实测同一台电脑上两个浏览器会一个走
 * IPv4、一个走 IPv6 连进来，而服务器只看得到「这次连接用的地址」，于是把它
 * 俩分进两个房间，互相看不见。前端用 STUN 探出自己的全部出口地址（优先公网
 * IPv6）上报，分房就能与「这次连接走哪个协议」解耦。
 *
 * 只收公网地址：私网 / 回环 / 链路本地 / ULA 一律拒绝 —— 否则任何人都能
 * 自报一个地址混进别人的房间（例如报 192.168.1.x 去看同一局域网里的设备名）。
 * 伪造公网地址仍是理论可行的，但目标前缀无从得知，且房间里只能看到设备名、
 * 发文件还要对方手动接受，风险可控。
 *
 * @param {unknown} reported
 * @returns {string|null} 归一化后的地址，不合法返回 null
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
    if (low.startsWith('fe80')) return null;                    // 链路本地
    if (low.startsWith('fc') || low.startsWith('fd')) return null; // ULA
    if (low === '::1' || low === '::') return null;
    if (!/^[23][0-9a-f]{3}:/.test(low)) return null;            // 只认 2000::/3
    return low;
  }

  return null;
}

/**
 * 房间划分策略（保持与 Node 版一致，只多了 wanRoomMode 开关）：
 *   · 私网 IPv4 → 按 /24 聚合（同一个 Wi-Fi 下的设备自动成房）
 *   · IPv6     → 按 /64 聚合（一个家庭/公司通常共享同一个 /64）
 *   · 公网 IPv4 → 默认按整段 IP 成一房
 *
 * ⚠ 公网 IPv4 分房有个真实风险，上线前必须知道：
 *   国内运营商（尤其中国移动 4G/5G）大量使用 CGNAT，成千上万个用户会共享
 *   同一个出口 IP。按 IP 分房意味着这些人会被放进同一间房、互相可见。
 *   所以留了 wanRoomMode = 'off' 的后路 —— 关掉自动发现，只保留配对码/房间码。
 *
 * @param {string} ip
 * @param {'ip'|'off'} wanRoomMode
 * @returns {string|null} null 表示不进任何自动房间
 */
export function roomIdForIp(ip, wanRoomMode = 'ip') {
  if (ip.includes(':')) return 'v6:' + ip.split(':').slice(0, 4).join(':');
  if (isPrivateIpv4(ip)) return 'lan:' + ip.split('.').slice(0, 3).join('.');
  if (wanRoomMode === 'off') return null;
  return 'wan:' + ip;
}

export function guessDeviceName(ua = '') {
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

function randomRoomCode(len = 5) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  return s;
}

function randomHex(byteLen) {
  const b = new Uint8Array(byteLen);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/* ============================== Durable Object ============================== */

export class SignalRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this._rooms = null;   // Map<roomId, Set<WebSocket>>，休眠后重建
    this._rate = new Map();   // WebSocket → { t, n, bytes }，限流窗口，休眠后自然重置

    // 没有 setInterval 心跳：那会不断唤醒 DO、把 duration 额度烧光。
    // 死连接由 Cloudflare 自己回收，客户端侧靠 onclose 自动重连。
    this._setupAutoResponse();
  }

  /**
   * 把保活请求交给运行时自动回复（见 PING_MSG 的注释）。
   *
   * 放在构造函数里：DO 每次从休眠被唤醒都会重跑构造函数，配置跟着重新生效，
   * 不需要额外的持久化。本地 shim 没有这个 API，所以整个包在 try 里。
   */
  _setupAutoResponse() {
    try {
      if (typeof WebSocketRequestResponsePair !== 'function') return;
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_MSG, PONG_MSG));
    } catch { /* 本地模拟环境没有这个 API，忽略即可 */ }
  }

  get wanRoomMode() {
    return (this.env && this.env.WAN_ROOM_MODE) === 'off' ? 'off' : 'ip';
  }

  get maxConnections() {
    const n = Number(this.env && this.env.MAX_CONNECTIONS);
    return Number.isFinite(n) && n > 0 ? n : MAX_CONNECTIONS;
  }

  get maxRoomsTotal() {
    const n = Number(this.env && this.env.MAX_ROOMS_TOTAL);
    return Number.isFinite(n) && n > 0 ? n : MAX_ROOMS_TOTAL;
  }

  /**
   * 连接数是否已达上限。
   * 抽成方法只为一个理由：能被测试直接验证 —— fetch() 里那几行依赖
   * WebSocketPair，离线 shim 造不出来，而这些上限本身必须被守住。
   */
  _connectionsFull() {
    return this.ctx.getWebSockets().length >= this.maxConnections;
  }

  /* --------------------------- 连接建立 --------------------------- */

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('FlashDrop signaling endpoint (WebSocket only)', {
        status: 426,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    // 连接闸门放在最前面：拒绝比接收便宜得多，被拒的连接不占内存、不进房间表。
    // 用 503 而不是静默断开，前端才能显示「服务器繁忙」而不是「连不上」。
    if (this._connectionsFull()) {
      return new Response('服务器繁忙，请稍后重试', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // 旧式 accept + 休眠式 accept 的区别全部在这里
    this.ctx.acceptWebSocket(server);

    // Cloudflare 保证这个头就是真实客户端 IP（不需要 TRUST_PROXY 那一套）
    const rawIp = normalizeIp(request.headers.get('CF-Connecting-IP'));
    const ua = request.headers.get('user-agent') || '';

    const att = {
      peerId: crypto.randomUUID(),
      displayName: guessDeviceName(ua),
      rawIp,
      ipRoom: roomIdForIp(rawIp, this.wanRoomMode),
      rooms: [],
      pairKey: null,
      joinedAt: Date.now(),
    };
    server.serializeAttachment(att);

    this._send(server, {
      type: 'self',
      peerId: att.peerId,
      displayName: att.displayName,
      deviceName: att.displayName,
      config: buildSelfConfig(this.env),
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /* --------------------------- 消息分发 --------------------------- */

  async webSocketMessage(ws, raw) {
    // 限流必须在 JSON.parse 之前 —— 解析本身也要花 CPU，垃圾消息不该走到那一步。
    // 被 auto-response 接走的保活消息根本不会进到这里，所以不占额度。
    if (!this._allowMessage(ws, raw)) {
      this._send(ws, { type: 'error', reason: 'rate-limited', message: '消息过于频繁，连接已断开' });
      try { ws.close(1008, 'rate limited'); } catch { /* 可能已经关闭 */ }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    const att = ws.deserializeAttachment() || {};

    switch (msg.type) {
      case 'ping':
        // 客户端保活。Cloudflare 的 WebSocket 有 100 秒空闲超时，客户端每隔
        // 75 秒发一个 ping 让连接上有数据流动。回个 pong 就行，不做别的
        // （服务端仍然不主动心跳，避免白白唤醒 Durable Object）。
        this._send(ws, { type: 'pong' });
        break;

      case 'pong':
        break;   // 兼容旧客户端，服务端不主动心跳

      case 'join-lan-room': {
        // 优先按前端探测到的公网地址分房（解决 IPv4/IPv6 双栈分裂），
        // 探测失败就退回按这次连接用的地址分房 —— 行为与修复前一致。
        const reported = acceptedReportedAddr(msg.addr);
        const roomId = reported ? roomIdForIp(reported, this.wanRoomMode) : att.ipRoom;
        if (roomId) {
          const r = this._join(ws, roomId, 'lan');
          // 自动发现的房间满了：这多半是 CGNAT —— 上千人共用一个出口 IP。
          // 这些人本来就不该互相看见，所以不能回「房间已满」那种像故障的错，
          // 只回一条提示，让前端把话说清楚（改用配对码 / 房间码即可）。
          if (!r.ok && r.reason === 'room-full') {
            this._send(ws, { type: 'lan-room-full', limit: r.limit });
          }
        }
        break;
      }

      case 'create-room': {
        const code = randomRoomCode(5);
        const r = this._join(ws, 'pub:' + code, 'public');
        if (!r.ok) {
          this._send(ws, {
            type: 'room-error', code: r.reason,
            reason: this._roomErrorText(r), count: r.count, limit: r.limit,
          });
          break;
        }
        this._send(ws, { type: 'room-created', roomId: code });
        break;
      }

      case 'join-room': {
        const code = String(msg.code || '').trim().toLowerCase();
        // scope='session' 指首页二维码那条「扫码会话房间」：生命周期跟页面一致、
        // 用户不会手动退出；其余（默认）是房间弹窗里临时建的公共房间。
        // 两者共用 pub: 房间空间，只是 roomType 不同 —— 前端按优先级挑一间发信令。
        const scope = msg.scope === 'session' ? 'session' : 'public';
        if (!(scope === 'session' ? SESSION_CODE_RE : PUBLIC_CODE_RE).test(code)) {
          this._send(ws, { type: 'room-error', reason: '格式不对' });
          break;
        }
        const roomId = 'pub:' + code;
        if (!this._roomsIndex().has(roomId) && !msg.createIfInvalid) {
          this._send(ws, { type: 'room-error', reason: '房间不存在' });
          break;
        }
        const r = this._join(ws, roomId, scope);
        if (!r.ok) {
          this._send(ws, {
            type: 'room-error', code: r.reason,
            reason: this._roomErrorText(r), count: r.count, limit: r.limit,
          });
          break;
        }
        this._send(ws, { type: 'room-joined', roomId: code, scope });
        break;
      }

      case 'leave-room':
        if (msg.roomId) this._leave(ws, 'pub:' + String(msg.roomId).toLowerCase());
        break;

      case 'pair-initiate':
        await this._pairInitiate(ws, att);
        break;

      case 'pair-join':
        await this._pairJoin(ws, att, msg);
        break;

      case 'pair-cancel':
        if (att.pairKey) {
          await this.ctx.storage.delete('pair:' + att.pairKey);
          this._patch(ws, { pairKey: null });
        }
        break;

      case 'rejoin-room':
        // 重连后凭已保存的 roomSecret 回到旧配对
        if (typeof msg.roomSecret === 'string' && /^[0-9a-f]{32,128}$/i.test(msg.roomSecret)) {
          // 只有真进去了才回 ok：否则前端会把它记进「已配对设备」，
          // 下次刷新又来一遍，越攒越多。
          if (this._join(ws, 'secret:' + msg.roomSecret, 'secret').ok) {
            this._send(ws, { type: 'rejoin-ok', roomSecret: msg.roomSecret });
          }
        }
        break;

      case 'rename': {
        const name = String(msg.displayName || '').slice(0, MAX_NAME_LEN).trim();
        if (!name) break;
        this._patch(ws, { displayName: name });
        for (const roomId of att.rooms || []) {
          for (const other of this._roomsIndex().get(roomId) || []) {
            if (other !== ws) {
              this._send(other, { type: 'peer-renamed', peerId: att.peerId, displayName: name });
            }
          }
        }
        break;
      }

      case 'signal':
      case 'relay':      // WS 兜底：同样只在同房间内转发
        this._relay(ws, msg);
        break;

      default:
        break;
    }
  }

  async webSocketClose(ws) {
    // 限流桶要跟着连接一起回收，否则 Map 会随连接数一直长
    // （key 是 ws 对象，连接没了就再没人能取到它，纯泄漏）
    this._rate.delete(ws);

    const att = ws.deserializeAttachment() || {};
    for (const roomId of [...(att.rooms || [])]) this._leave(ws, roomId);
    if (att.pairKey) {
      try { await this.ctx.storage.delete('pair:' + att.pairKey); } catch { /* noop */ }
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  /* --------------------------- 房间表 --------------------------- */

  /**
   * 懒重建房间表。
   *
   * 休眠会让内存清空，但每一条活着的 WebSocket 上还挂着 attachment，
   * 里面记着它加入过哪些房间 —— 拿这个当作唯一真相重建即可，
   * 不需要额外持久化房间表（省 storage 写入，也就省唤醒）。
   */
  _roomsIndex() {
    if (this._rooms) return this._rooms;
    const m = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a) continue;
      for (const roomId of a.rooms || []) {
        if (!m.has(roomId)) m.set(roomId, new Set());
        m.get(roomId).add(ws);
      }
    }
    this._rooms = m;
    return m;
  }

  _patch(ws, patch) {
    const a = ws.deserializeAttachment() || {};
    const next = Object.assign({}, a, patch);
    try { ws.serializeAttachment(next); } catch { /* 连接可能已关闭 */ }
    return next;
  }

  /**
   * 取房间，不存在就现建 —— 但受全局房间数闸门约束。
   *
   * 单独抽出来是因为「清僵尸」那一步有可能把整间房回收掉（_leave 在房间空了
   * 时会删条目），清理后必须重新取一次；沿用旧引用会拿到一个已脱钩的孤儿 Set，
   * 往里 add 的成员在索引里根本查不到 —— 又变成「同房却互相看不见」。
   *
   * @returns {Set<WebSocket>|null} null 表示房间总数已达上限
   */
  _ensureRoom(rooms, roomId) {
    let room = rooms.get(roomId);
    if (room) return room;
    if (rooms.size >= this.maxRoomsTotal) return null;
    room = new Set();
    rooms.set(roomId, room);
    return room;
  }

  /**
   * 把 _join 的失败原因翻成给用户看的话。
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
   * 让连接加入房间（房间不存在则现建）。
   *
   * @returns {{ok: true}|{ok: false, reason: string, count?: number, limit?: number}}
   *   reason 取值：'room-full'（人数满）/ 'server-full'（房间数或连接数满）
   *   / 'room-limit'（单连接加入房间数超限）。调用方必须把这个结果报给客户端。
   */
  _join(ws, roomId, roomType) {
    const rooms = this._roomsIndex();
    const before = ws.deserializeAttachment() || {};
    // 已在房里：先退出，保证对端不会收到「先 joined 后 left」的乱序
    if ((before.rooms || []).includes(roomId)) this._leave(ws, roomId);

    // 封顶必须在 leave 之后判断，否则「重复加入同一间房」会被自己误判成超限。
    // 这里要重新 deserialize 一次：before 是 leave 之前的快照，里面还留着
    // 刚退掉的那个房间 ID，拿它算长度会多算一个。
    const cur = ws.deserializeAttachment() || {};
    if ((cur.rooms || []).length >= MAX_ROOMS_PER_CONN) {
      return { ok: false, reason: 'room-limit' };
    }

    let room = this._ensureRoom(rooms, roomId);
    if (!room) return { ok: false, reason: 'server-full' };

    const limit = ROOM_PEER_LIMITS[roomType] || DEFAULT_ROOM_LIMIT;
    if (room.size >= limit) {
      // 先剔僵尸（已关闭、但 webSocketClose 还没跑完的连接）再下结论。
      // 少了这一步，「刷新页面」就会把自己挡在门外：旧连接尚未回收，新连接的
      // 加入请求已经到了，于是 2/2 的房间把真正的第二台设备拒掉。
      for (const other of [...room]) {
        if (other.readyState !== 1) this._leave(other, roomId);
      }
      // _leave 可能把空房间整条回收 —— 必须重新取，否则后面往里加的就是孤儿集合
      room = this._ensureRoom(rooms, roomId);
      if (!room) return { ok: false, reason: 'server-full' };
      if (room.size >= limit) {
        return { ok: false, reason: 'room-full', count: room.size, limit };
      }
    }

    const existing = [];
    for (const other of room) existing.push(this._info(other));

    const att = ws.deserializeAttachment() || {};
    for (const other of room) {
      this._send(other, { type: 'peer-joined', peer: this._info(ws), roomType, roomId });
    }

    room.add(ws);
    this._patch(ws, { rooms: (att.rooms || []).concat(roomId) });

    this._send(ws, { type: 'peers', peers: existing, roomType, roomId });
    return { ok: true };
  }

  /**
   * 每连接的滑动限流（固定 1 秒窗口）。
   *
   * 用内存 Map 而不是 attachment：写 attachment 要走序列化，每条消息都写一遍
   * 反而更贵；而限流状态本来就允许丢 —— DO 既然会休眠，说明根本没什么消息。
   *
   * @returns {boolean} false 表示超过阈值，调用方应当断开这条连接
   */
  _allowMessage(ws, raw) {
    const bytes = typeof raw === 'string' ? raw.length : ((raw && raw.byteLength) || 0);
    const now = Date.now();
    let b = this._rate.get(ws);
    if (!b || now - b.t >= 1000) {
      b = { t: now, n: 0, bytes: 0 };
      this._rate.set(ws, b);
    }
    b.n++;
    b.bytes += bytes;
    return b.n <= MSG_MAX_PER_SEC && b.bytes <= MSG_MAX_BYTES_PER_SEC;
  }

  _leave(ws, roomId) {
    const a = ws.deserializeAttachment() || {};
    if (!(a.rooms || []).includes(roomId)) return;   // 本来就不在这间房，别广播

    this._patch(ws, { rooms: a.rooms.filter((r) => r !== roomId) });

    const rooms = this._roomsIndex();
    const room = rooms.get(roomId);
    if (!room) return;

    room.delete(ws);
    const others = [...room];
    if (room.size === 0) rooms.delete(roomId);

    for (const other of others) {
      this._send(other, { type: 'peer-left', peerId: a.peerId, roomId });
    }
  }

  /* --------------------------- 设备配对 --------------------------- */

  async _pairInitiate(ws, att) {
    const roomSecret = randomHex(32);

    let pairKey = null;
    for (let i = 0; i < 30; i++) {
      const candidate = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
      if (!(await this.ctx.storage.get('pair:' + candidate))) { pairKey = candidate; break; }
    }
    if (!pairKey) {
      this._send(ws, { type: 'pair-invalid', reason: '服务器繁忙，请重试' });
      return;
    }

    if (att.pairKey) { try { await this.ctx.storage.delete('pair:' + att.pairKey); } catch { /* noop */ } }

    await this.ctx.storage.put('pair:' + pairKey, {
      roomSecret,
      creatorId: att.peerId,
      expiresAt: Date.now() + PAIR_TTL_MS,
    });
    this._patch(ws, { pairKey });

    // 配对要额外占一间 secret: 房间，同样受上限保护；
    // 失败就把刚写下的配对码收回去，别留个进不去的死码在库里。
    const rr = this._join(ws, 'secret:' + roomSecret, 'secret');
    if (!rr.ok) {
      await this.ctx.storage.delete('pair:' + pairKey);
      this._patch(ws, { pairKey: null });
      this._send(ws, { type: 'pair-invalid', reason: this._roomErrorText(rr) });
      return;
    }
    this._send(ws, { type: 'pair-initiated', pairKey, roomSecret });

    // 让过期配对码能被回收（alarm 是 DO 里唯一的定时手段，且只唤醒一次）
    const cur = await this.ctx.storage.getAlarm();
    if (!cur) await this.ctx.storage.setAlarm(Date.now() + PAIR_TTL_MS + 60 * 1000);
  }

  async _pairJoin(ws, att, msg) {
    const pairKey = String(msg.pairKey || '').trim();
    const entry = await this.ctx.storage.get('pair:' + pairKey);

    if (!entry || entry.expiresAt < Date.now() || entry.creatorId === att.peerId) {
      this._send(ws, { type: 'pair-invalid', reason: '配对码无效或已过期' });
      return;
    }

    // 一次性使用，用完即焚
    await this.ctx.storage.delete('pair:' + pairKey);

    // 找到发起方（它此刻应该在 secret 房间里等着）
    const secretRoom = 'secret:' + entry.roomSecret;
    let creatorWs = null;
    for (const other of this._roomsIndex().get(secretRoom) || []) {
      const a = other.deserializeAttachment() || {};
      if (a.peerId === entry.creatorId) { creatorWs = other; break; }
    }
    if (creatorWs) this._patch(creatorWs, { pairKey: null });

    // 超限时绝不能照常通知双方「配对成功」：对端会切进一个你其实没进去的房间，
    // 症状是「提示配对成功了，但设备列表一直空着」。
    const rj = this._join(ws, secretRoom, 'secret');
    if (!rj.ok) {
      this._send(ws, { type: 'pair-invalid', reason: this._roomErrorText(rj) });
      return;
    }

    this._send(ws, { type: 'pair-joined', roomSecret: entry.roomSecret, peerId: entry.creatorId });
    if (creatorWs) {
      this._send(creatorWs, { type: 'pair-joined', roomSecret: entry.roomSecret, peerId: att.peerId });
    }
  }

  async alarm() {
    // 清掉过期的配对码
    const all = await this.ctx.storage.list({ prefix: 'pair:' });
    const now = Date.now();
    let nextExpiry = 0;
    for (const [key, val] of all) {
      if (!val || val.expiresAt < now) {
        await this.ctx.storage.delete(key);
      } else if (!nextExpiry || val.expiresAt < nextExpiry) {
        nextExpiry = val.expiresAt;
      }
    }
    if (nextExpiry) await this.ctx.storage.setAlarm(nextExpiry + 60 * 1000);
  }

  /* --------------------------- 转发 --------------------------- */

  /**
   * 只在发送者所在的同一个房间里转发。
   *
   * ⚠ 必须校验 room.has(senderWs)：只判断「房间存在 + 目标在房间里」是不够的。
   * 房间是公开可猜的（pub: 房间码会外传，lan:/wan: 由 IP 推导），而 peerId 一旦
   * 在房间里广播过就被记住了 —— 如果不校验发送者身份，一个**已经退出房间**的人
   * 仍能继续往里面投递 SDP/ICE，甚至用 relay 类型塞任意数据。
   */
  _relay(senderWs, msg) {
    const room = msg.roomId ? this._roomsIndex().get(msg.roomId) : null;
    if (!room) return;
    if (!room.has(senderWs)) return;

    let target = null;
    for (const ws of room) {
      const a = ws.deserializeAttachment();
      if (a && a.peerId === msg.to) { target = ws; break; }
    }
    if (!target) return;

    const sa = senderWs.deserializeAttachment() || {};
    const out = Object.assign({}, msg, {
      senderId: sa.peerId,
      senderName: sa.displayName,
    });
    delete out.to;
    this._send(target, out);
  }

  _info(ws) {
    const a = ws.deserializeAttachment() || {};
    return { id: a.peerId, displayName: a.displayName, ip: a.rawIp };
  }

  _send(ws, message) {
    if (!ws) return;
    try { ws.send(JSON.stringify(message)); } catch { /* 连接正在关闭，忽略 */ }
  }
}
