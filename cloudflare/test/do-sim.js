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

import { SignalRoom, roomIdForIp, guessDeviceName } from '../src/room.js';

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
  constructor(storage) { this.storage = storage; this.sockets = []; }
  acceptWebSocket(ws) { this.sockets.push(ws); }
  getWebSockets() { return this.sockets.filter((w) => w.readyState === 1); }
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
    config: {},
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
