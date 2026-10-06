'use strict';
/**
 * Durable Object 信令逻辑离线测试
 * ===========================================================================
 * 为什么不用 wrangler dev：本机网络环境对 npm / workerd 二进制不友好，
 * 而这里要验的是**纯逻辑**（分房、转发、配对、休眠重建），跟 Cloudflare 的
 * 运行时关系不大。于是自己搭一套最小 shim，把 DO 的接口按语义实现一遍：
 *
 *   ctx.acceptWebSocket / ctx.getWebSockets / ctx.storage
 *   ws.serializeAttachment / ws.deserializeAttachment   ← 关键，做深拷贝
 *
 * attachment 的深拷贝是刻意的：真实 DO 每次 deserializeAttachment() 都返回
 * 一个新对象，如果代码里改了对象却没写回 serializeAttachment，线上就会丢状态
 * 而本地假 shim 若返回同一引用则永远测不出来。这类 bug 只在 DO 上出现。
 */

import { SignalRoom, roomIdForIp, guessDeviceName, buildSelfConfig } from '../src/room.js';

/* ---------------------- 运行时 API 的替身 ---------------------- */

/**
 * setWebSocketAutoResponse 用到的类，Node 里没有（只有 Cloudflare 运行时提供）。
 *
 * 补替身是为了让「保活自动响应」这条优化**可以被断言** —— 它是纯省钱的那一条：
 * 让 DO 在休眠时不被打扰，从而不产生 duration 计费。而它的失效方式是**静默**的
 * （请求字符串拼错就悄悄退回「每次都唤醒」），所以必须有测试守着。
 */
class FakeRequestResponsePair {
  constructor(request, response) { this._req = request; this._resp = response; }
  getRequest() { return this._req; }
  getResponse() { return this._resp; }
}
globalThis.WebSocketRequestResponsePair = FakeRequestResponsePair;

/* ============================== 测试脚手架 ============================== */

let passed = 0, failed = 0;
const failures = [];

function ok(cond, label) {
  if (cond) { passed++; console.log(`  \u2713 ${label}`); }
  else { failed++; failures.push(label); console.log(`  \u2717 ${label}`); }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  ok(a === b, `${label}${a === b ? '' : `\n      期望 ${b}\n      实际 ${a}`}`);
}

function section(name) { console.log(`\n${name}`); }

/* ------------------------------ shim ------------------------------ */

class FakeWS {
  constructor(tag) {
    this.tag = tag;
    this.sent = [];
    this.readyState = 1;      // OPEN
    this._att = null;
  }
  send(s) { this.sent.push(JSON.parse(s)); }
  serializeAttachment(o) { this._att = o === null ? null : JSON.parse(JSON.stringify(o)); }
  deserializeAttachment() { return this._att === null ? null : JSON.parse(JSON.stringify(this._att)); }
  /** 取出并清空已发出的消息 */
  take() { const s = this.sent; this.sent = []; return s; }
  types() { return this.sent.map((m) => m.type); }
}

class FakeStorage {
  constructor() { this.map = new Map(); this._alarm = null; }
  async get(k) { return this.map.get(k); }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { return this.map.delete(k); }
  async list({ prefix } = {}) {
    const out = new Map();
    for (const [k, v] of this.map) if (!prefix || k.startsWith(prefix)) out.set(k, v);
    return out;
  }
  async getAlarm() { return this._alarm; }
  async setAlarm(t) { this._alarm = t; }
}

class FakeCtx {
  constructor(storage) { this.storage = storage; this.sockets = []; this.autoResponse = null; }
  acceptWebSocket(ws) { this.sockets.push(ws); }
  // 只统计「活着」的连接 —— 真实 DO 的 getWebSockets 也是这个语义，
  // 而 _connectionsFull() 和 _roomsIndex() 都依赖这个前提。
  getWebSockets() { return this.sockets.filter((w) => w.readyState === 1); }
  setWebSocketAutoResponse(pair) { this.autoResponse = pair; }
}

/** 模拟一次 WS 建连，返回 [do 实例, 服务端 ws] */
async function connect(env, ctx, ip, ua) {
  const head = new Headers({ 'CF-Connecting-IP': ip, 'user-agent': ua || 'Mozilla/5.0 (iPhone)' });
  const req = { headers: head };

  // 复刻 SignalRoom.fetch() 里除了 WebSocketPair 之外的全部逻辑
  const ws = new FakeWS(`c${ctx.sockets.length + 1}`);
  ctx.acceptWebSocket(ws);

  const att = {
    peerId: crypto.randomUUID(),
    displayName: guessDeviceName(ua || 'Mozilla/5.0 (iPhone)'),
    rawIp: ip,
    ipRoom: roomIdForIp(ip, env.WAN_ROOM_MODE === 'off' ? 'off' : 'ip'),
    rooms: [],
    pairKey: null,
    joinedAt: Date.now(),
  };
  ws.serializeAttachment(att);
  ws.send(JSON.stringify({
    type: 'self',
    peerId: att.peerId,
    displayName: att.displayName,
    // 复用服务端真实的构造逻辑，别再硬编码一份 —— 硬编码正是「服务端改了
    // 测试却还绿着」的来源。
    config: buildSelfConfig(env),
  }));
  return ws;
}

const send = (doObj, ws, msg) => doObj.webSocketMessage(ws, JSON.stringify(msg));
const selfOf = (ws) => ws.take().find((m) => m.type === 'self');
const wait = () => new Promise((r) => setTimeout(r, 0));

/* ============================== 开跑 ============================== */

async function main() {
  const storage = new FakeStorage();
  const ctx = new FakeCtx(storage);
  const env = { WAN_ROOM_MODE: 'ip', WS_RELAY: 'on' };

  let doObj = new SignalRoom(ctx, env);

  section('一、地址 → 房间（房间划分策略）');
  eq(roomIdForIp('192.168.1.5', 'ip'), 'lan:192.168.1', '同一 /24 私网落进同一间房');
  eq(roomIdForIp('192.168.1.99', 'ip'), 'lan:192.168.1', '同网段第二台设备');
  eq(roomIdForIp('192.168.2.5', 'ip'), 'lan:192.168.2', '不同网段分开');
  eq(roomIdForIp('10.0.3.7', 'ip'), 'lan:10.0.3', '10.x 私网按 /24 聚合');
  eq(roomIdForIp('203.0.113.9', 'ip'), 'wan:203.0.113.9', '公网 IP 各自成房');
  eq(roomIdForIp('203.0.113.9', 'off'), null, 'WAN_ROOM_MODE=off 时不自动分房');
  eq(roomIdForIp('2408:8207:1234:5678:9abc::1', 'ip'), 'v6:2408:8207:1234:5678', 'IPv6 按 /64 聚合');
  ok(guessDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1').includes('iPhone'),
    'UA 推断出 iPhone');

  section('二、自动发现（同一 Wi-Fi 两台设备）');
  const a = await connect(env, ctx, '192.168.1.5', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120');
  const b = await connect(env, ctx, '192.168.1.7', 'Mozilla/5.0 (iPhone) Safari/604.1');
  ok(!!selfOf(a) && !!selfOf(b), '两端都收到 self');

  await send(doObj, a, { type: 'join-lan-room' });
  eq(a.take().filter((m) => m.type === 'peers')[0].peers.length, 0, 'A 先加入：房间里还没有别人');

  await send(doObj, b, { type: 'join-lan-room' });
  const bPeers = b.take().find((m) => m.type === 'peers');
  eq(bPeers.peers.length, 1, 'B 加入后看到 A');
  eq(bPeers.roomType, 'lan', '房间类型是 lan');
  const aGot = a.take();
  eq(aGot.filter((m) => m.type === 'peer-joined').length, 1, 'A 收到 B 上线广播');

  section('三、信令转发');
  const aId = a.deserializeAttachment().peerId;
  const bId = b.deserializeAttachment().peerId;
  await send(doObj, a, {
    type: 'signal', to: bId, roomId: 'lan:192.168.1', sdp: { type: 'offer', sdp: 'v=0' },
  });
  const sig = b.take().find((m) => m.type === 'signal');
  ok(!!sig, 'B 收到 A 的 SDP');
  eq(sig.to, undefined, '转发时抹掉 to');
  eq(sig.senderId, aId, '带上 senderId');
  ok(!a.sent.length, 'A 不会收到自己发的信令');

  section('四、房间隔离（不同网段互不可见）');
  const c = await connect(env, ctx, '192.168.9.9', 'Mozilla/5.0 (Linux) Firefox/121');
  await send(doObj, c, { type: 'join-lan-room' });
  eq(c.take().find((m) => m.type === 'peers').peers.length, 0, 'C 在别的网段，看不到任何人');
  ok(!a.sent.some((m) => m.type === 'peer-joined'), 'A 也没有收到 C 上线');

  section('五、越权转发防护');
  await send(doObj, c, { type: 'signal', to: bId, roomId: 'lan:192.168.1', sdp: { type: 'offer' } });
  ok(!b.sent.some((m) => m.type === 'signal'), 'C 不在该房间，塞进去的信令被丢弃');
  await send(doObj, a, { type: 'signal', to: 'no-such-peer', roomId: 'lan:192.168.1', sdp: {} });
  ok(!b.sent.some((m) => m.type === 'signal'), '发给不存在的设备不会广播出去');
  await send(doObj, a, { type: 'signal', to: bId, roomId: 'lan:192.168.9', sdp: {} });
  ok(!b.sent.some((m) => m.type === 'signal'), '伪造别的房间号也没用');

  section('六、改名广播');
  a.take(); b.take();
  await send(doObj, a, { type: 'rename', displayName: '我的笔记本' });
  const renamed = b.take().find((m) => m.type === 'peer-renamed');
  ok(!!renamed && renamed.displayName === '我的笔记本', 'B 收到改名');
  eq(a.deserializeAttachment().displayName, '我的笔记本', 'A 自己的 attachment 也更新了');

  section('七、配对码（跨网络）');
  a.take(); b.take();
  await send(doObj, a, { type: 'pair-initiate' });
  const initiated = a.take().find((m) => m.type === 'pair-initiated');
  ok(!!initiated && /^\d{6}$/.test(initiated.pairKey), 'A 拿到 6 位配对码');
  ok(!!storage.map.get('pair:' + initiated.pairKey), '配对码落到 storage（休眠后仍在）');
  eq(initiated.roomSecret.length, 64, 'roomSecret 是 32 字节 hex');

  await send(doObj, b, { type: 'pair-join', pairKey: initiated.pairKey });
  const bJoined = b.take().find((m) => m.type === 'pair-joined');
  const aJoined = a.take().find((m) => m.type === 'pair-joined');
  ok(!!bJoined && !!aJoined, '双方都收到 pair-joined');
  eq(bJoined.roomSecret, aJoined.roomSecret, '双方拿到同一个 roomSecret');
  ok(!storage.map.has('pair:' + initiated.pairKey), '配对码一次性，用完即焚');

  section('八、配对码的边界情况');
  await send(doObj, a, { type: 'pair-initiate' });
  const k2 = a.take().find((m) => m.type === 'pair-initiated').pairKey;
  await send(doObj, a, { type: 'pair-join', pairKey: k2 });
  ok(a.take().some((m) => m.type === 'pair-invalid'), '自己不能配对自己');
  await send(doObj, b, { type: 'pair-join', pairKey: '000000' });
  ok(b.take().some((m) => m.type === 'pair-invalid'), '乱填的配对码被判无效');

  section('九、公共房间码');
  a.take();
  await send(doObj, a, { type: 'create-room' });
  const created = a.take().find((m) => m.type === 'room-created');
  ok(!!created && /^[a-z0-9]{5}$/.test(created.roomId), '创建出 5 位房间码');
  const d = await connect(env, ctx, '198.51.100.7', 'Mozilla/5.0 (Android) Chrome/120');
  await send(doObj, d, { type: 'join-room', code: created.roomId });
  ok(d.take().some((m) => m.type === 'room-joined'), '另一台设备用房间码加入了');
  ok(a.take().some((m) => m.type === 'peer-joined'), 'A 看到 D 进来');
  await send(doObj, d, { type: 'join-room', code: 'zzzzz' });
  ok(d.take().some((m) => m.type === 'room-error'), '不存在的房间报错');
  await send(doObj, d, { type: 'join-room', code: 'a b' });
  ok(d.take().some((m) => m.type === 'room-error'), '非法房间码被拒');

  section('九之二、扫码会话房间（scope=session）');
  d.take(); a.take();
  // 「扫码会话房间」和「公共房间」共用 pub: 房间空间，靠 scope 区分 roomType ——
  // 前端据此按优先级挑一间发信令。所以回执必须把它带回去，否则前端无从判断
  // 这条 room-joined 到底是哪一类，会把会话房间记成公共房间。
  await send(doObj, d, { type: 'join-room', code: 'scanrm', scope: 'session', createIfInvalid: true });
  const joinedScan = d.take().find((m) => m.type === 'room-joined');
  ok(!!joinedScan, '能带着 scope=session 加入房间');
  eq(joinedScan && joinedScan.scope, 'session', 'room-joined 回执带回了 scope');
  eq(joinedScan && joinedScan.roomId, 'scanrm', '回执里的房间码原样返回');

  // 房间不存在 + createIfInvalid：先打开页面的人就是房主，
  // 它的加入请求一定早于扫码方，必须先建后进才顺。
  const e1 = await connect(env, ctx, '203.0.113.77');
  await send(doObj, e1, { type: 'join-room', code: 'scanrm', scope: 'session', createIfInvalid: true });
  ok(e1.take().some((m) => m.type === 'room-joined'), '不存在的房间带 createIfInvalid 能直接建出来');
  ok(d.take().some((m) => m.type === 'peer-joined'), '两台设备用同一个房间码即落进同一间房');

  // 老客户端不带 scope 时不能被打挂 —— 必须仍按公共房间处理
  const e2 = await connect(env, ctx, '203.0.113.78');
  await send(doObj, e2, { type: 'join-room', code: 'basic1' });
  ok(e2.take().some((m) => m.type === 'room-error'), '不存在的房间、且无 createIfInvalid → 报错');
  await send(doObj, e2, { type: 'join-room', code: 'basic1', createIfInvalid: true });
  eq(e2.take().find((m) => m.type === 'room-joined').scope, 'public', '缺省 scope 默认为 public（兼容旧客户端）');

  // 房间码长度：扫码房间卡死 6 位，公共房间放宽到 4~12 位。
  // 这条守的是「别人撞进你房间」的成本 —— 6 位空间 31^6 ≈ 8.9 亿，
  // 4 位只有 31^4 ≈ 92 万，穷举一遍几分钟的事，等于门没锁。
  await send(doObj, e2, { type: 'join-room', code: 'abcd', scope: 'session', createIfInvalid: true });
  ok(e2.take().some((m) => m.type === 'room-error'), '扫码房间拒收 4 位短码（防穷举）');
  await send(doObj, e2, { type: 'join-room', code: 'abcdefg', scope: 'session', createIfInvalid: true });
  ok(e2.take().some((m) => m.type === 'room-error'), '扫码房间拒收 7 位码');
  await send(doObj, e2, { type: 'join-room', code: 'abcd', createIfInvalid: true });
  ok(e2.take().some((m) => m.type === 'room-joined'), '公共房间仍收 4 位短码（用户要手输）');

  // 单连接房间数封顶：房间是「加入即创建」的，不封顶就能拿随机码无限建，
  // 每次都在 rooms 表里留一条 —— DO 那侧 attachment 上限 16,384 字节，撑爆后
  // serializeAttachment 抛错、被 _patch 静默吞掉，房间记录凭空消失。
  const e3 = await connect(env, ctx, '203.0.113.79');
  let overflow = false;
  for (let i = 0; i < 60 && !overflow; i++) {
    const code = ('r' + i).padStart(6, 'a');
    await send(doObj, e3, { type: 'join-room', code, scope: 'session', createIfInvalid: true });
    // 断言机器可读的 code，不匹配中文文案 —— 文案是给人看的，随时会改，
    // 拿它当断言条件会让「改个措辞」变成「测试挂了」。
    overflow = e3.take().some((m) => m.type === 'room-error' && m.code === 'room-limit');
  }
  ok(overflow, '单连接加入房间数达上限即被拒（防内存/存储放大）');
  e3.readyState = 3; await doObj.webSocketClose(e3);

  section('九之三、房间人数上限（防转发 + 防烧额度）');
  // 此刻 scanrm 房间里有 d 和 e1 两个连接 —— 正好是 session 的满员状态
  const f1 = await connect(env, ctx, '203.0.113.81');
  await send(doObj, f1, { type: 'join-room', code: 'scanrm', scope: 'session', createIfInvalid: true });
  const full = f1.take().find((m) => m.type === 'room-error');
  ok(!!full && full.code === 'room-full', '扫码房间第 3 个人被拒（2/2）');
  eq(full && full.limit, 2, '扫码房间上限是 2');
  eq(full && full.count, 2, '被拒时报出当时房里有 2 人');
  // 文案必须能指导下一步动作。「进不去」这种话会被当成网络故障，
  // 而正确的动作是「让对方重新生成二维码」或「改用配对码」。
  ok(!!full && /重新生成二维码/.test(full.reason), '给的是可操作的人话，不是「进不去」');

  // 配对房间同样是 2 人：a 和 b 此刻正待在 initiated 那间 secret 房里
  const f2 = await connect(env, ctx, '203.0.113.82');
  await send(doObj, f2, { type: 'rejoin-room', roomSecret: initiated.roomSecret });
  ok(!f2.take().some((m) => m.type === 'rejoin-ok'), '配对房间第 3 个人 rejoin 拿不到 ok');

  // 公共房间 12 人上限：房主 + 12 个加入者，第 13 个进不来
  const host = await connect(env, ctx, '198.51.100.201');
  await send(doObj, host, { type: 'create-room' });
  const pub = host.take().find((m) => m.type === 'room-created').roomId;
  let pubRejected = null;
  for (let i = 0; i < 13 && !pubRejected; i++) {
    const g = await connect(env, ctx, `198.51.100.${100 + i}`);
    await send(doObj, g, { type: 'join-room', code: pub });
    pubRejected = g.take().find((m) => m.type === 'room-error') || null;
  }
  ok(!!pubRejected && pubRejected.code === 'room-full', '公共房间第 13 个人被拒（12 人上限）');
  eq(pubRejected && pubRejected.limit, 12, '公共房间上限是 12');

  // 自动发现房间（lan）64 人上限。超限**静默不入房**并回一条提示，而不是报错 ——
  // 因为 CGNAT 下这些连接本来就来自成千上万个互不相干的陌生人，
  // 「进不去」对他们不是故障，反而是我们主动挡掉了串房。
  let lanJoined = 0, lanFullSeen = false;
  for (let i = 0; i < 66 && !lanFullSeen; i++) {
    const g = await connect(env, ctx, '198.51.100.77');   // 同一个出口地址 → 同一间房
    await send(doObj, g, { type: 'join-lan-room' });
    const msgs = g.take();
    if (msgs.some((m) => m.type === 'lan-room-full')) lanFullSeen = true;
    else if (msgs.some((m) => m.type === 'peers')) lanJoined++;
  }
  eq(lanJoined, 64, '自动发现房间最多容纳 64 个连接');
  ok(lanFullSeen, '第 65 个收到 lan-room-full 提示（静默不入房，不报错）');

  // 刷新场景：旧连接已断、但 close 事件还没跑完，新连接不能被这个僵尸挡住。
  // 少了「先剔僵尸再判满员」，页面刷新就会把自己关在 2/2 的门外。
  const s1 = await connect(env, ctx, '203.0.113.90');
  await send(doObj, s1, { type: 'join-room', code: 'flsh01', scope: 'session', createIfInvalid: true });
  const s2 = await connect(env, ctx, '203.0.113.91');
  await send(doObj, s2, { type: 'join-room', code: 'flsh01', scope: 'session', createIfInvalid: true });
  ok(s2.take().some((m) => m.type === 'room-joined'), '第二位设备正常进房');
  s1.readyState = 3;   // 模拟「刷新页面」：旧连接已关闭，close 事件尚未派发
  const s3 = await connect(env, ctx, '203.0.113.90');
  await send(doObj, s3, { type: 'join-room', code: 'flsh01', scope: 'session', createIfInvalid: true });
  ok(s3.take().some((m) => m.type === 'room-joined'), '刷新后新连接没被自己的僵尸挡在门外');

  section('九之四、限流与保活自动响应');
  // 条数维度
  const rl = new FakeWS('rl1');
  let rlBlocked = false;
  for (let i = 0; i < 400 && !rlBlocked; i++) rlBlocked = !doObj._allowMessage(rl, 'x');
  ok(rlBlocked, '同一秒内超过条数上限即被限流');

  // 字节维度必须能独立触发：否则有人用大消息、少量条数就能绕过限流
  const rl2 = new FakeWS('rl2');
  const oneMB = 'x'.repeat(1024 * 1024);
  let byteBlocked = false;
  for (let i = 0; i < 40 && !byteBlocked; i++) byteBlocked = !doObj._allowMessage(rl2, oneMB);
  ok(byteBlocked, '同一秒内累计体积超限也会被限流（不只靠条数）');

  // 限流桶要跟着连接回收，否则 Map 只增不减（key 是对象，连接没了就再没人取得到）
  const e5 = await connect(env, ctx, '203.0.113.83');
  await send(doObj, e5, { type: 'rename', displayName: '有消息就有桶' });
  ok(doObj._rate.has(e5), '有消息往来时会建限流桶');
  e5.readyState = 3; await doObj.webSocketClose(e5);
  ok(!doObj._rate.has(e5), '连接关闭后限流桶被回收');

  // 保活自动响应：纯省钱的那条优化，字符串错一个字就会静默失效
  ok(ctx.autoResponse instanceof FakeRequestResponsePair, 'DO 启动时注册了保活自动响应');
  eq(ctx.autoResponse && ctx.autoResponse.getRequest(), '{"type":"ping"}', '自动响应的请求串');
  eq(ctx.autoResponse && ctx.autoResponse.getResponse(), '{"type":"pong"}', '自动响应的响应串');
  // 与前端 net.js 的 this.send({ type: 'ping' }) 逐字比对 —— 那边一改格式
  // （加空格 / 换字段顺序），自动响应就悄悄退回「每次唤醒 DO 并计费」。
  eq(JSON.stringify({ type: 'ping' }), ctx.autoResponse && ctx.autoResponse.getRequest(),
    '前端 JSON.stringify 的结果与之逐字一致');
  eq(JSON.stringify({ type: 'pong' }), ctx.autoResponse && ctx.autoResponse.getResponse(),
    '响应那边同理（前端按 JSON.parse 处理，必须是合法 JSON）');

  section('九之五、全局闸门（连接数 / 房间数）');
  // 这两个上限支持 env 覆盖，正是为了能用很小的值在这里验证
  const ctx2 = new FakeCtx(new FakeStorage());
  const env2 = { MAX_CONNECTIONS: 2 };
  const do2 = new SignalRoom(ctx2, env2);
  eq(do2.maxConnections, 2, 'env 能覆盖连接数上限');
  eq(do2._connectionsFull(), false, '没有连接时不算满');
  await connect(env2, ctx2, '203.0.113.101');
  await connect(env2, ctx2, '203.0.113.102');
  ok(do2._connectionsFull(), '连接数达上限即判满（fetch 会回 503）');

  const ctx3 = new FakeCtx(new FakeStorage());
  const env3 = { MAX_ROOMS_TOTAL: 2 };
  const do3 = new SignalRoom(ctx3, env3);
  eq(do3.maxRoomsTotal, 2, 'env 能覆盖房间数上限');
  const g1 = await connect(env3, ctx3, '203.0.113.111');
  const g2 = await connect(env3, ctx3, '203.0.113.112');
  const g3 = await connect(env3, ctx3, '203.0.113.113');
  await send(do3, g1, { type: 'join-room', code: 'rooma1', scope: 'session', createIfInvalid: true });
  await send(do3, g2, { type: 'join-room', code: 'roomb2', scope: 'session', createIfInvalid: true });
  ok(g1.take().some((m) => m.type === 'room-joined') && g2.take().some((m) => m.type === 'room-joined'),
    '前两间房正常建出来');
  await send(do3, g3, { type: 'join-room', code: 'roomc3', scope: 'session', createIfInvalid: true });
  const over = g3.take().find((m) => m.type === 'room-error');
  ok(!!over && over.code === 'server-full', '超出的第三间房被全局房间数闸门拦下');
  // 闸门挡的是「新建」，不是「加入」—— 已在册的房间必须还能进，
  // 否则房间数一满，连别人已有的房间都进不去了。
  await send(do3, g3, { type: 'join-room', code: 'rooma1', scope: 'session', createIfInvalid: true });
  ok(g3.take().some((m) => m.type === 'room-joined'), '已存在的房间不受全局闸门影响');

  e1.readyState = 3; await doObj.webSocketClose(e1);
  e2.readyState = 3; await doObj.webSocketClose(e2);

  section('十、休眠后状态重建（最关键的一组）');
  // 模拟 DO 被休眠后重新实例化：ctx 不变（WS 还在），内存全丢
  doObj = new SignalRoom(ctx, env);
  eq(doObj._rooms, null, '新实例内存里没有房间表');

  a.take(); b.take();
  await send(doObj, a, { type: 'rename', displayName: '睡醒了' });
  ok(b.take().some((m) => m.type === 'peer-renamed'), '休眠重建后房间表仍正确（改名广播通了）');

  a.take(); b.take();
  await send(doObj, a, { type: 'signal', to: bId, roomId: 'lan:192.168.1', sdp: { type: 'offer', sdp: 'x' } });
  ok(b.take().some((m) => m.type === 'signal'), '休眠重建后信令转发仍然可用');

  await send(doObj, a, { type: 'rejoin-room', roomSecret: initiated.roomSecret });
  ok(a.take().some((m) => m.type === 'rejoin-ok'), '休眠重建后老配对仍能 rejoin');

  section('十一、断开与 peer-left');
  b.take(); a.take();
  b.readyState = 3;                       // CLOSED
  await doObj.webSocketClose(b);
  eq(a.take().filter((m) => m.type === 'peer-left')[0].peerId, bId, 'B 断开后 A 收到 peer-left');
  eq(doObj._roomsIndex().get('lan:192.168.1').size, 1, '房间里只剩 A');

  section('十二、房间空了就回收');
  const before = doObj._roomsIndex().size;
  a.readyState = 3;
  await doObj.webSocketClose(a);
  ok(doObj._roomsIndex().size < before, 'A 也走了之后 lan 房间被回收');

  section('十三、配对码过期清理');
  const d2 = await connect(env, ctx, '203.0.113.50');
  await send(doObj, d2, { type: 'pair-initiate' });
  const pk = d2.take().find((m) => m.type === 'pair-initiated').pairKey;
  storage.map.set('pair:' + pk, { roomSecret: 'x'.repeat(64), creatorId: 'zzz', expiresAt: Date.now() - 1 });
  await doObj.alarm();
  ok(!storage.map.has('pair:' + pk), 'alarm 清掉了过期的配对码');

  section('十四、WAN_ROOM_MODE=off（关闭自动发现，防 CGNAT 串房）');

  // 配置构造：前端靠这个字段决定要不要给出「自动发现已关闭」的说明
  eq(buildSelfConfig({ WAN_ROOM_MODE: 'off' }).autoDiscover, false,
    'off：下发 autoDiscover=false');
  eq(buildSelfConfig({ WAN_ROOM_MODE: 'ip' }).autoDiscover, true,
    'ip：下发 autoDiscover=true');
  eq(buildSelfConfig({}).autoDiscover, true,
    '未配置：默认开启（旧行为不受影响）');

  // off 只挡**公网 IPv4** 的自动分房；私网 /24 与 IPv6 /64 的分房逻辑不变。
  // 这一条很关键：Node 自建版跑在内网，服务端看到的是私网 IP，
  // 所以「局域网自动发现」在自建版上照常可用。
  eq(roomIdForIp('192.168.1.5', 'off'), 'lan:192.168.1',
    'off 下私网 /24 仍分房（自建版局域网发现不受影响）');
  eq(roomIdForIp('2408:8207:1234:5678:9abc::1', 'off'), 'v6:2408:8207:1234:5678',
    'off 下 IPv6 仍按 /64 聚合');

  // 行为层：公网部署下两台设备应当**完全无法自动互见**。
  // 两台用**同一个出口 IP**（同一路由器 / 同一 CGNAT 出口）—— 这是最关键的一种，
  // 因为 off 的真实代价正是「连同一个 Wi-Fi 的两台设备也不再自动出现」。
  // 同时也收不到任何房间消息（收不到才对 —— 前端据此展示说明，而不是让用户干等）。
  const offEnv = { WAN_ROOM_MODE: 'off', WS_RELAY: 'on' };
  const offCtx = new FakeCtx(new FakeStorage());
  const offDo = new SignalRoom(offCtx, offEnv);
  const oa = await connect(offEnv, offCtx, '203.0.113.9', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120');
  const ob = await connect(offEnv, offCtx, '203.0.113.9', 'Mozilla/5.0 (iPhone)');
  const oaSelf = selfOf(oa);      // 顺带清空 self
  selfOf(ob);
  eq(oaSelf.config.autoDiscover, false, 'off：建连即下发 autoDiscover=false（界面据此说明）');
  await send(offDo, oa, { type: 'join-lan-room' });
  await send(offDo, ob, { type: 'join-lan-room' });
  const oaM = oa.take(), obM = ob.take();
  eq(oaM.filter((m) => m.type === 'peers').length, 0, 'off：A 未加入任何房间（无 peers 消息）');
  eq(obM.filter((m) => m.type === 'peers').length, 0, 'off：B 未加入任何房间');
  eq(obM.filter((m) => m.type === 'peer-joined').length, 0, 'off：同一出口 IP 的 B 也看不到 A');
  eq(offDo._roomsIndex().size, 0, 'off：没有留下任何自动房间');

  // 对照组：完全相同的两台设备（同一个出口 IP），只把开关换成 "ip"，
  // 就能自动互见。有这一组，上面那几条才等于「开关真的在起作用」，
  // 而不是「这两台本来就看不见对方」。
  // 顺带说明 CGNAT 为什么危险：出口 IP 相同就自动进同一间房 ——
  // 在国内移动网络下，那可能是成千上万个互不相识的人。
  const ipEnv = { WAN_ROOM_MODE: 'ip', WS_RELAY: 'on' };
  const ipCtx = new FakeCtx(new FakeStorage());
  const ipDo = new SignalRoom(ipCtx, ipEnv);
  const ia = await connect(ipEnv, ipCtx, '203.0.113.9', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120');
  const ib = await connect(ipEnv, ipCtx, '203.0.113.9', 'Mozilla/5.0 (iPhone)');
  selfOf(ia); selfOf(ib);
  await send(ipDo, ia, { type: 'join-lan-room' });
  await send(ipDo, ib, { type: 'join-lan-room' });
  eq(ib.take().filter((m) => m.type === 'peers')[0].peers.length, 1, '对照组 ip 模式：同出口 IP 的 B 能看见 A');

  /* ---------------------------- 汇总 ---------------------------- */
  console.log('\n' + '─'.repeat(56));
  console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('  失败项：');
    for (const f of failures) console.log('    · ' + f.split('\n')[0]);
  }
  console.log('─'.repeat(56));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('\n测试自身崩了：', e);
  process.exit(2);
});
