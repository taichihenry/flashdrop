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

/** 打洞用的 STUN。Cloudflare 自家这个在边缘侧最稳，境外用户可直连。 */
export const BASE_ICE = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const ROOM_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 去掉易混字符
const PAIR_TTL_MS = 10 * 60 * 1000;   // 配对码 10 分钟有效
const MAX_NAME_LEN = 24;

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

    // 没有 setInterval 心跳：那会不断唤醒 DO、把 duration 额度烧光。
    // 死连接由 Cloudflare 自己回收，客户端侧靠 onclose 自动重连。
  }

  get wanRoomMode() {
    return (this.env && this.env.WAN_ROOM_MODE) === 'off' ? 'off' : 'ip';
  }

  /* --------------------------- 连接建立 --------------------------- */

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('FlashDrop signaling endpoint (WebSocket only)', {
        status: 426,
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
      config: {
        iceServers: BASE_ICE,
        wsRelay: (this.env && this.env.WS_RELAY) !== 'off',
        // 告诉前端「本服务带 TURN 闸门」，前端才会在 P2P 失败时去要凭证
        turnAvailable: !!((this.env && this.env.TURN_KEY_ID) || (this.env && this.env.TURN_KEY_SECRET)),
      },
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /* --------------------------- 消息分发 --------------------------- */

  async webSocketMessage(ws, raw) {
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
        if (roomId) this._join(ws, roomId, 'lan');
        break;
      }

      case 'create-room': {
        const code = randomRoomCode(5);
        this._join(ws, 'pub:' + code, 'public');
        this._send(ws, { type: 'room-created', roomId: code });
        break;
      }

      case 'join-room': {
        const code = String(msg.code || '').trim().toLowerCase();
        if (!/^[a-z0-9]{4,12}$/.test(code)) {
          this._send(ws, { type: 'room-error', reason: '格式不对' });
          break;
        }
        const roomId = 'pub:' + code;
        if (!this._roomsIndex().has(roomId) && !msg.createIfInvalid) {
          this._send(ws, { type: 'room-error', reason: '房间不存在' });
          break;
        }
        this._join(ws, roomId, 'public');
        this._send(ws, { type: 'room-joined', roomId: code });
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
          this._join(ws, 'secret:' + msg.roomSecret, 'secret');
          this._send(ws, { type: 'rejoin-ok', roomSecret: msg.roomSecret });
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

  _join(ws, roomId, roomType) {
    const rooms = this._roomsIndex();
    const before = ws.deserializeAttachment() || {};
    // 已在房里：先退出，保证对端不会收到「先 joined 后 left」的乱序
    if ((before.rooms || []).includes(roomId)) this._leave(ws, roomId);

    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const room = rooms.get(roomId);

    const existing = [];
    for (const other of room) existing.push(this._info(other));

    const att = ws.deserializeAttachment() || {};
    for (const other of room) {
      this._send(other, { type: 'peer-joined', peer: this._info(ws), roomType, roomId });
    }

    room.add(ws);
    this._patch(ws, { rooms: (att.rooms || []).concat(roomId) });

    this._send(ws, { type: 'peers', peers: existing, roomType, roomId });
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

    this._join(ws, 'secret:' + roomSecret, 'secret');
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

    this._join(ws, secretRoom, 'secret');

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
