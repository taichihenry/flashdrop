/**
 * 房间弹窗与「退出房间」入口的交互自测
 * ---------------------------------------------------------------------------
 * 守的是两件曾经出过问题、又不会报错的事：
 *
 *   [2] 点「创建」/「加入」之后，弹窗必须**自己关掉**。
 *       之前要手动点「关闭」，用户会以为没成功。
 *   [3] 主界面右上角的房间标签本身就是退出按钮。
 *       之前退出入口只存在于弹窗里，弹窗一关就再也找不到 ——
 *       「我进了房间，现在怎么退？」没有任何答案。
 *   [7] 本站关闭自动发现时（服务端 WAN_ROOM_MODE=off），空状态必须说明
 *       原因并给出替代做法。否则用户只看到一个空列表，以为页面坏了。
 *
 * 为什么值得单独写一个脚本：这两个都是**纯 UI 行为**，信令层完全正常，
 * 端到端测试（scan-room.js）从头到尾都不会碰。典型的「功能全对、用起来不对」。
 *
 * 跑法：node test/room-ui.js
 * 前提：无（脚本自己拉起服务与浏览器）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { launch, waitFor, sleep, tempProfile, findChrome } = require('./lib');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const CHROME = findChrome();
const SRV_PORT = 8695;

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? '  ' + detail : ''}`); }
}

/* ============================== 服务与浏览器 ============================== */

let srvProc = null;
const instances = [];
const tmpDirs = [];

function waitPort(port, tries = 60) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/info' }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (++n > tries) return reject(new Error('端口没起来: ' + port));
        setTimeout(tick, 300);
      });
      req.setTimeout(1500, () => req.destroy());
    };
    tick();
  });
}

async function startServer() {
  srvProc = spawn(NODE, ['run.js'], {
    cwd: ROOT,
    env: { ...process.env, NO_TLS: '1', PORT: String(SRV_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srvProc.stdout.on('data', () => { /* banner 太长，忽略 */ });
  srvProc.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  await waitPort(SRV_PORT);
}

async function boot(label, port) {
  const profileDir = tempProfile(`fd-roomui-${label}-`);
  tmpDirs.push(profileDir);
  const inst = await launch({
    label, url: `http://127.0.0.1:${SRV_PORT}/`, port, profileDir,
    headless: true, chrome: CHROME, width: 1080, height: 900,
  });
  instances.push(inst);
  return inst;
}

async function cleanup() {
  for (const c of instances) { try { await c.close(); } catch { /* noop */ } }
  await sleep(600);
  if (srvProc) { try { srvProc.kill(); } catch { /* noop */ } }
  await sleep(400);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
}

/* ============================== 页面小工具 ============================== */

const READY = `document.readyState === 'complete' && !!(window.__fd && window.__fd.state && window.__fd.state.sessionRoom)`;

const click = (inst, id) =>
  inst.cdp.eval(`(document.getElementById(${JSON.stringify(id)}).click(), true)`);

/** 房间弹窗是否开着（两个条件都要满足才算，和 app.js 里判断「往哪写错误」的条件一致） */
const roomModalOpen = (inst) => inst.cdp.eval(
  `!document.getElementById('overlay').hidden && !document.getElementById('modal-room').hidden`,
);

/** 主界面房间标签的文字；不可见时返回 null */
const badgeText = (inst) => inst.cdp.eval(
  `(() => { const b = document.getElementById('room-badge'); return b.hidden ? null : b.textContent; })()`,
);

// 归一成 null：signaling.roomCode 没设置时是 undefined，直接比 === null 会误判
const roomCodeOf = (inst) => inst.cdp.eval(`window.__fd.signaling.roomCode || null`);

const setInput = (inst, id, value) =>
  inst.cdp.eval(`(() => { document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; return true; })()`);

/**
 * 第三方探针：绕开页面直接问服务端「这间房里现在有谁」。
 *
 * 为什么要它：客户端说「我退了」不等于服务端真的把连接移出了房间。
 * 界面上的标签消失只证明前端状态被清了，房间成员表可能还挂着一条死记录
 * （之后的表现就是「明明都退了，重进房间还看得见幽灵设备」）。
 */
/** peer 信息里字段名以服务端为准，取到哪个用哪个 —— 断言只看数量，诊断要看得懂 */
const peerLabel = (p) => (p && (p.name || p.deviceName || p.id)) || JSON.stringify(p);

function probePeers(code) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${SRV_PORT}/ws`);
    const seen = [];
    const done = (v) => { try { ws.close(); } catch { /* noop */ } resolve(v); };
    const timer = setTimeout(() => done({ peers: null, seen, error: 'timeout' }), 8000);

    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      seen.push(m.type);
      if (m.type === 'peers') { clearTimeout(timer); done({ peers: m.peers || [], seen }); }
      if (m.type === 'room-error') { clearTimeout(timer); done({ error: m.reason, seen }); }
    });
    ws.on('error', () => { clearTimeout(timer); done({ error: 'ws-error', seen }); });
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'join-room', code, createIfInvalid: false,
    })));
  });
}

async function becameTrue(desc, fn, timeoutMs = 8000) {
  try { await waitFor(desc, fn, timeoutMs, 200); return true; } catch { return false; }
}

/* ============================== 主流程 ============================== */

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error(`找不到 Chrome：${CHROME}\n用 CHROME=... 指定路径。`);
    process.exit(2);
  }

  console.log('\n===== 房间弹窗与退出入口自测 =====');
  console.log(`  服务：127.0.0.1:${SRV_PORT}`);
  console.log('');

  await startServer();

  console.log('[1] 两台设备各自打开页面');
  const A = await boot('A', 9611);
  const B = await boot('B', 9612);
  await waitFor('A 就绪', () => A.cdp.eval(READY), 30000, 250);
  await waitFor('B 就绪', () => B.cdp.eval(READY), 30000, 250);

  const sA = await A.cdp.eval(`window.__fd.state.sessionRoom`);
  const sB = await B.cdp.eval(`window.__fd.state.sessionRoom`);
  check('两端扫码房间码互不相同（不是固定值）', !!sA && !!sB && sA !== sB, `${sA} vs ${sB}`);
  check('初始没有任何房间标签', (await badgeText(A)) === null);
  check('初始不在临时房间里', (await roomCodeOf(A)) === null);
  console.log('');

  console.log('[2] 创建房间：弹窗应自动关闭，主界面出现房间标签');
  await click(A, 'btn-room');
  check('点顶栏「房间」后弹窗打开', (await roomModalOpen(A)) === true);

  await click(A, 'btn-room-create');
  check('创建后弹窗自动关闭（不必手动点关闭）',
    await becameTrue('弹窗自动关', async () => (await roomModalOpen(A)) === false));

  const codeA = await roomCodeOf(A);
  check('已进入房间', /^[a-z0-9]{4,12}$/.test(String(codeA)), String(codeA));

  const btA = await badgeText(A);
  check('主界面出现房间标签', !!btA && String(btA).includes(String(codeA)), JSON.stringify(btA));
  check('标签自带退出符号 ✕（一眼看得出能点）', !!btA && String(btA).includes('✕'), JSON.stringify(btA));
  console.log('');

  console.log('[3] 点主界面标签即可退出房间（关键：弹窗是关的）');
  check('此刻弹窗确实是关着的', (await roomModalOpen(A)) === false);
  await click(A, 'room-badge');
  check('标签消失', await becameTrue('标签消失', async () => (await badgeText(A)) === null, 5000));
  check('客户端房间状态已清空', (await roomCodeOf(A)) === null);

  const snapLeft = await probePeers(codeA);
  const emptyOk = snapLeft.error === '房间不存在'
    || (Array.isArray(snapLeft.peers) && snapLeft.peers.length === 0);
  check('服务端侧也真的退出了（不只是界面变干净）', emptyOk, JSON.stringify(snapLeft));
  console.log('');

  console.log('[4] 输入房间码加入：弹窗同样应自动关闭');
  await click(B, 'btn-room');
  await click(B, 'btn-room-create');
  await waitFor('B 弹窗关闭', async () => (await roomModalOpen(B)) === false, 8000, 200);
  const codeB = await roomCodeOf(B);
  check('B 建房成功', !!codeB, String(codeB));

  await click(A, 'btn-room');
  await setInput(A, 'room-input', String(codeB));
  await click(A, 'btn-room-join');
  check('输入码加入后弹窗自动关闭',
    await becameTrue('A 弹窗自动关', async () => (await roomModalOpen(A)) === false));
  check('A 已进入 B 的房间', (await roomCodeOf(A)) === String(codeB));

  const btA2 = await badgeText(A);
  check('A 的标签显示该房间码', !!btA2 && String(btA2).includes(String(codeB)), JSON.stringify(btA2));

  const snapIn = await probePeers(String(codeB));
  const names = (snapIn.peers || []).map(peerLabel);
  check('服务端确认两端确实同房', names.length >= 2, JSON.stringify(names));
  console.log('');

  console.log('[5] 一端点标签退出后，服务端房间里只剩另一端');
  await click(B, 'room-badge');
  check('B 点标签后自己退房', await becameTrue('B 标签消失', async () => (await badgeText(B)) === null, 5000));
  await sleep(700);   // 等 peer-left 在服务端落定

  const snapOut = await probePeers(String(codeB));
  const names2 = (snapOut.peers || []).map(peerLabel);
  check('服务端房间只剩 A（B 确实退了，没留幽灵）', names2.length === 1, JSON.stringify(names2));
  console.log('');

  console.log('[6] 回归：加入不存在的房间，弹窗不能被关掉');
  await click(A, 'btn-room');
  await setInput(A, 'room-input', 'zzzzzz');
  await click(A, 'btn-room-join');
  await sleep(1300);

  const stillOpen = await roomModalOpen(A);
  const errText = await A.cdp.eval(
    `(() => { const e = document.getElementById('room-error'); return e.hidden ? null : e.textContent; })()`,
  );
  check('失败时弹窗保持打开', stillOpen === true);
  check('并在弹窗里给出原因', !!errText, JSON.stringify(errText));
  console.log('');

  console.log('[7] 关闭自动发现时，空状态必须给出说明（否则像页面坏了）');
  // 服务端 WAN_ROOM_MODE=off 时**不会回任何房间消息**（连「房间已满」都不回），
  // 前端只会看到一个空的「附近设备」列表 —— 用户会以为是页面坏了。
  // 所以服务端在 self 里下发 autoDiscover=false，界面据此说明。
  // 这里直接派发一次 self 事件来模拟下发，不依赖服务端配置。
  check('默认（自动发现开启）不显示该说明',
    await A.cdp.eval(`document.getElementById('lan-off-hint').hidden`) === true);

  await A.cdp.eval(
    `window.__fd.signaling.emit('self', { peerId: 'srv', displayName: 'x', config: { autoDiscover: false } })`,
  );
  const offHint = await A.cdp.eval(
    `(() => { const h = document.getElementById('lan-off-hint'); return { hidden: h.hidden, text: h.textContent.replace(/\\s+/g, ' ').trim() }; })()`,
  );
  check('收到 autoDiscover=false 后显示说明', offHint.hidden === false);
  check('说明里给出「改用什么」的替代做法', /房间码|二维码|配对/.test(offHint.text), JSON.stringify(offHint.text));

  // 必须能收回去：重连到另一台服务端（或配置改回来）后，不能一直挂着错误说明
  await A.cdp.eval(
    `window.__fd.signaling.emit('self', { peerId: 'srv', displayName: 'x', config: { autoDiscover: true } })`,
  );
  check('恢复 autoDiscover=true 后说明收起',
    await A.cdp.eval(`document.getElementById('lan-off-hint').hidden`) === true);
  console.log('');

  console.log('===== 结果 =====');
  console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
  console.log('');
}

main()
  .then(async () => {
    await cleanup();
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch(async (e) => {
    console.error('\n运行出错：', e && e.stack ? e.stack : e);
    await cleanup();
    process.exit(2);
  });
