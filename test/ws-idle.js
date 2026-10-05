/**
 * 信令连接存活性观察
 * ---------------------------------------------------------------------------
 * 目的：确认信令 WebSocket 在「没有信令交互」时会不会被平台掐断。
 *
 * 背景：Cloudflare 对 WebSocket 有 **100 秒空闲超时**（期间没有任何数据帧就
 * 断开）。FlashDrop 服务端刻意不做 setInterval 心跳（怕一直唤醒 Durable
 * Object 烧额度），客户端又只在收到 ping 时才回 pong —— 也就是**双方都不主动
 * 说话**。那么只要用户挂着页面不动，信令就会被断掉。
 *
 * 而客户端的 ws.onclose 里会把所有 peer 直接销毁 —— 正在传输的文件会当场中断。
 *
 * 跑法：
 *   node test/ws-idle.js                    # 默认观察 3 分钟
 *   node test/ws-idle.js https://xxx 200    # 指定站点 / 观察秒数
 */

'use strict';

const fs = require('fs');
const { launch, waitFor, sleep, tempProfile, findChrome } = require('./lib');

const CHROME = findChrome();
const BASE = process.argv[2] || process.env.BASE || 'https://flashdrop.midoai.com';
const SECONDS = Number(process.argv[3] || 190);

const SAMPLE = `JSON.stringify({
  ws: window.__fd.signaling.ws ? window.__fd.signaling.ws.readyState : null,
  self: String(window.__fd.signaling.selfId || '').slice(0, 8),
  room: String(window.__fd.signaling.roomId || ''),
  peers: window.__fd.signaling.peers.size,
  reconnects: window.__fd.__reconnects || 0
})`;

(async () => {
  if (!fs.existsSync(CHROME)) { console.error('找不到浏览器：' + CHROME); process.exit(2); }

  console.log('\n===== 信令连接存活性观察 =====');
  console.log(`  目标：${BASE}   观察 ${SECONDS} 秒\n`);

  const profileDir = tempProfile('fd-idle-');
  const inst = await launch({ label: 'idle', url: BASE, port: 9431, profileDir, headless: true, chrome: CHROME });
  await waitFor('前端初始化', () => inst.cdp.eval('!!window.__fd'), 25000);
  await waitFor('进入房间', () => inst.cdp.eval('window.__fd.signaling.roomId || null'), 25000);

  // 记录每次信令断开，用来数「被平台掐了几次」
  await inst.cdp.eval(`(() => {
    window.__fd.__reconnects = 0;
    const s = window.__fd.signaling;
    const orig = s.emit.bind(s);
    s.emit = (name, payload) => {
      if (name === 'signaling-closed') window.__fd.__reconnects++;
      return orig(name, payload);
    };
    return true;
  })()`);

  let last = null;
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < SECONDS) {
    const raw = await inst.cdp.eval(SAMPLE);
    const t = Math.round((Date.now() - t0) / 1000);
    if (raw !== last) {
      console.log(`  [${String(t).padStart(3)}s] ${raw}`);
      last = raw;
    } else {
      process.stdout.write(`  [${String(t).padStart(3)}s] 无变化\n`);
    }
    await sleep(15000);
  }

  console.log('\n  说明：ws=1 是 OPEN，ws=3 是 CLOSED。');
  console.log('  若 self 变了说明重连过（每次重连服务端都会发一个新 peerId）。\n');

  try { await inst.cdp.eval('window.__fd.signaling.close()'); } catch { /* noop */ }
  await sleep(400);
  inst.cdp.close();
  await inst.close().catch(() => {});
  await sleep(500);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* noop */ }
})().catch((e) => { console.error(e); process.exit(1); });
