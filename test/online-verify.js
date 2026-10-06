'use strict';
/**
 * 线上部署验收（打真实端点，需要联网）
 * ===========================================================================
 * 为什么必须有这么一个脚本：本地那 190 项测试**全部跑在 127.0.0.1 上**、
 * 用的是 Node 版服务（server.js）。线上是 Cloudflare Workers + Durable Object
 * （cloudflare/src/），是**另一套实现**，本地测试一行都覆盖不到它。
 * 两端协议相同、行为却可能不同 —— 部署完不复验，等于没验。
 *
 * 而且本轮真的抓到过只有线上才暴露的问题：`WAN_ROOM_MODE="off"` 在 IPv6
 * 网络下形同虚设 —— 静态文件里字段明明是对的，行为却是错的。
 * 所以验收必须**看行为**，不能只看文件内容。
 *
 * 跑法：node test/online-verify.js [域名]
 *   域名默认 6.xn--fiqs8s（即 6.中国 的 punycode）
 *
 * 注意：会在线上真实建一个 6 位公共房间（上限 2 人），跑完即断开。
 */

const WebSocket = require('ws');

const DOMAIN = process.argv[2] || '6.xn--fiqs8s';
const WS_URL = `wss://${DOMAIN}/ws`;
const ROOM_CODE = 'vfy' + Math.random().toString(36).slice(2, 5);   // 必须正好 6 位

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? '  ' + detail : ''}`); }
}
const section = (n) => console.log(`\n${n}`);

/** 建一条 WS，连上后发 joinMsg；等到 waitType 或超时 */
function open(joinMsg, waitType, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const msgs = [];
    const timer = setTimeout(() => reject(new Error(`超时（等 ${waitType}）`)), timeoutMs);
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      msgs.push(m);
      if (m.type === 'self') ws.send(JSON.stringify(joinMsg));
      if (m.type === waitType) { clearTimeout(timer); resolve({ ws, msgs }); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const pick = (o, t) => o.msgs.filter((m) => m.type === t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`\n目标：https://${DOMAIN}`);

  /* ---------------------------- 1. 静态入口 ---------------------------- */
  section('[1] 静态入口与 /api/info');
  let info = null;
  try {
    const r = await fetch(`https://${DOMAIN}/api/info`, { cache: 'no-store' });
    info = await r.json();
    check('/api/info 可达', r.ok, `status=${r.status}`);
    check('返回 public 模式（确系公网部署）', info.mode === 'public', JSON.stringify(info));
  } catch (e) {
    check('/api/info 可达', false, e.message);
  }
  for (const path of ['/', '/app.js', '/net.js']) {
    try {
      const r = await fetch(`https://${DOMAIN}${path}`, { cache: 'no-store' });
      check(`${path} 返回 200`, r.status === 200, `status=${r.status}`);
    } catch (e) {
      check(`${path} 返回 200`, false, e.message);
    }
  }

  /* --------------------------- 2. 服务端下发 --------------------------- */
  section('[2] 建连时服务端下发的 self.config');
  let selfCfg = null;
  {
    const r = await open({ type: 'ping' }, 'self');
    selfCfg = r.msgs.find((m) => m.type === 'self').config;
    r.ws.close();
    console.log('    config =', JSON.stringify(selfCfg));
  }
  const iceUrls = (selfCfg.iceServers || []).map((s) => s.urls).join(' ');
  check('下发了 STUN 列表', (selfCfg.iceServers || []).length > 0);
  check('STUN 不含国内不通的 stun1.l.google.com', !iceUrls.includes('stun1.l.google.com'));
  check('STUN 含 stun.cloudflare.com（国内可达）', iceUrls.includes('stun.cloudflare.com'));
  check('未配置 TURN 时不谎报可用', selfCfg.turnAvailable === false || info === null || info.turn === true);

  /* --------------------------- 3. 公共房间配对 --------------------------- */
  section('[3] 公共房间：两端进同一房能否互相看见');
  {
    const a = await open({ type: 'join-room', code: ROOM_CODE, createIfInvalid: true }, 'room-joined');
    const b = await open({ type: 'join-room', code: ROOM_CODE, createIfInvalid: true }, 'room-joined');
    await sleep(2000);
    const bPeers = pick(b, 'peers').pop().peers;
    check('后进的一端能看到先进的一端', bPeers.length === 1, `peers=${JSON.stringify(bPeers.map((p) => p.displayName))}`);
    check('另一端身份信息完整（有 id 和设备名）',
      !!bPeers[0] && !!bPeers[0].id && !!bPeers[0].displayName);
    a.ws.close(); b.ws.close();
    await sleep(400);
  }

  /* ------------------- 4. 自动发现（是否已按配置关闭） ------------------- */
  section('[4] 自动发现：join-lan-room 之后会不会被自动分房');
  {
    const c = new WebSocket(WS_URL);
    const cm = [];
    await new Promise((resolve) => {
      c.on('message', (d) => {
        const m = JSON.parse(d);
        cm.push(m);
        if (m.type === 'self') { c.send(JSON.stringify({ type: 'join-lan-room' })); setTimeout(resolve, 2500); }
      });
    });
    const roomMsgs = cm.filter((m) => ['peers', 'peer-joined', 'lan-room-full'].includes(m.type));
    const detail = roomMsgs.length
      ? JSON.stringify(roomMsgs.map((m) => ({ type: m.type, roomId: m.roomId })))
      : '（没有任何房间消息）';

    if (selfCfg && selfCfg.autoDiscover === false) {
      check('服务端声明关闭了自动发现 → 实测确实没有被分房', roomMsgs.length === 0, detail);
    } else {
      console.log(`  ⏭  站点当前开启了自动发现（autoDiscover=${selfCfg && selfCfg.autoDiscover}），跳过此项`);
      console.log(`      实测房间消息：${detail}`);
    }
    c.close();
  }

  console.log('\n' + '─'.repeat(56));
  console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
  console.log('─'.repeat(56) + '\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('\n验收脚本自身出错：', e && e.message);
  process.exit(2);
});
