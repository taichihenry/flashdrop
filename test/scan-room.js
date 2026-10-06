/**
 * 扫码房间自测（跨网络扫码自动配对）
 * ---------------------------------------------------------------------------
 * 验证本次改造的核心：首页那个大二维码里装的是一条**带房间号的网址**。
 * 扫码方打开它就自动落进同一间房、互相看见 —— 与两端是不是同一个网络无关。
 *
 * 手法与 crossnet.js 一致：本机起两个反向代理，向信令服务注入不同的
 * X-Forwarded-For，模拟「电脑走 Wi-Fi、手机走流量」。
 *
 * 测试结构（对照组是重点）：
 *   [2] 电脑打开页面 → 自动生成房间码，二维码指向带该码的链接
 *   [3] 手机「不扫码」自己打开 → 落进**另一个**房间 → 两边互相看不见
 *       ← 这就是改造前的状态，也是为什么必须走扫码房间
 *   [4] 手机「扫二维码」→ 打开同一个房间码 → 自动同房、互见
 *   [5] 真实传一个文件，两端 SHA-256 比对
 *
 * 跑法：node test/scan-room.js
 * 前提：无（脚本自己拉起服务与反代）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { launch, waitFor, sleep, tempProfile, findChrome } = require('./lib');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const CHROME = findChrome();

const SRV_PORT = 8693;                 // FlashDrop 信令服务
const PROXY_A = 9113;                  // 「电脑」入口
const PROXY_B = 9114;                  // 「手机」入口
const IP_A = '198.51.100.10';          // 假装家庭宽带公网出口
const IP_B = '203.0.113.99';           // 假装移动网络出口

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? '  ' + detail : ''}`); }
}

/* ============================== 反代（注入来源 IP） ============================== */

function startProxy(listenPort, fakeIp) {
  const inject = (headers) => {
    const h = Object.assign({}, headers, { 'x-forwarded-for': fakeIp });
    delete h['cf-connecting-ip'];
    return h;
  };

  const server = http.createServer((req, res) => {
    const up = http.request(
      { host: '127.0.0.1', port: SRV_PORT, path: req.url, method: req.method, headers: inject(req.headers) },
      (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); },
    );
    up.on('error', () => { try { res.writeHead(502); res.end(); } catch { /* noop */ } });
    req.pipe(up);
  });

  // WebSocket 走 upgrade，必须单独透传，否则页面能开但信令永远连不上
  server.on('upgrade', (req, socket, head) => {
    const up = http.request({
      host: '127.0.0.1', port: SRV_PORT, path: req.url, headers: inject(req.headers),
    });
    up.on('upgrade', (pr, psock, phead) => {
      const lines = Object.entries(pr.headers).map(([k, v]) => `${k}: ${v}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (phead && phead.length) socket.unshift(phead);
      socket.pipe(psock);
      psock.pipe(socket);
      socket.on('error', () => psock.destroy());
      psock.on('error', () => socket.destroy());
    });
    up.on('error', () => socket.destroy());
    up.end();
  });

  server.listen(listenPort, '127.0.0.1');
  return server;
}

/* ============================== 服务启动与收尾 ============================== */

let srvProc = null;
const instances = [];
const proxies = [];
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
    env: {
      ...process.env,
      TRUST_PROXY: '1',        // 信任反代注入的来源 IP
      // 只认连接地址分房，忽略浏览器自己 STUN 探到的出口地址 ——
      // 否则真实出口会把反代伪造的 IP 顶掉，「两端来自不同网络」就不成立了。
      IGNORE_REPORTED_ADDR: '1',
      NO_TLS: '1',
      PORT: String(SRV_PORT),
      PYTHONIOENCODING: 'utf-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srvProc.stdout.on('data', () => { /* banner 太长，忽略 */ });
  srvProc.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  await waitPort(SRV_PORT);
}

async function cleanup() {
  for (const c of instances) { try { await c.close(); } catch { /* noop */ } }
  await sleep(600);
  for (const p of proxies) { try { p.close(); } catch { /* noop */ } }
  if (srvProc) { try { srvProc.kill(); } catch { /* noop */ } }
  await sleep(400);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
}

async function boot(label, url, port) {
  const profileDir = tempProfile(`fd-scan-${label}-`);
  tmpDirs.push(profileDir);
  const inst = await launch({ label, url, port, profileDir, headless: true, chrome: CHROME });
  instances.push(inst);
  return inst;
}

const READY = `document.readyState === 'complete' && !!(window.__fd && window.__fd.state && window.__fd.state.sessionRoom)`;

/**
 * 「扫码打开一个新页面」。
 *
 * ⚠ 中间那步跳 about:blank 不能省：从 `http://host/` 导航到
 * `http://host/#room=x` 只是**改 hash**，浏览器判定为同文档导航，页面根本不会
 * 重新加载、main() 也不会重跑 —— 那样就完全模拟不出「扫二维码新开一个页面」。
 */
async function scanNavigate(cdp, url, label) {
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await waitFor(`${label} 清空文档`, async () => {
    try { return (await cdp.eval('location.href')) === 'about:blank'; } catch { return false; }
  }, 10000, 150).catch(() => { /* 偶尔拿不到也无妨，下一步会兜住 */ });

  await cdp.send('Page.navigate', { url });
  await waitFor(`${label} 扫码页加载完成`, async () => {
    try {
      return await cdp.eval(`location.href === ${JSON.stringify(url)} && ${READY}`);
    } catch { return false; }
  }, 30000, 250);
}

/* ============================== 主流程 ============================== */

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error(`找不到 Chrome：${CHROME}\n用 CHROME=... 指定路径。`);
    process.exit(2);
  }

  console.log('\n===== 扫码房间自测（电脑 WiFi ↔ 手机移动网络，扫码即配对）=====');
  console.log(`  信令服务：127.0.0.1:${SRV_PORT}（TRUST_PROXY=1）`);
  console.log(`  电脑入口：127.0.0.1:${PROXY_A}  →  来源 IP ${IP_A}`);
  console.log(`  手机入口：127.0.0.1:${PROXY_B}  →  来源 IP ${IP_B}\n`);

  console.log('[1] 拉起服务与两个反代');
  await startServer();
  proxies.push(startProxy(PROXY_A, IP_A));
  proxies.push(startProxy(PROXY_B, IP_B));
  await sleep(400);

  const info = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: SRV_PORT, path: '/api/info' }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
    }).on('error', () => resolve({}));
  });
  check('/api/info 带上了 publicUrl 字段', 'publicUrl' in info, JSON.stringify(info.publicUrl));
  console.log('');

  console.log('[2] 电脑端打开页面 —— 它自动成为这个房间的创建者');
  const A = await boot('pc', `http://127.0.0.1:${PROXY_A}/`, 9713);
  await waitFor('电脑端就绪', () => A.cdp.eval(READY), 20000);

  const codeA = await A.cdp.eval(`window.__fd.state.sessionRoom`);
  check('页面自动生成了房间码', /^[a-z0-9]{6}$/.test(String(codeA)), String(codeA));

  const hashA = await A.cdp.eval(`location.hash`);
  check('地址栏已写入 #room=（刷新不会掉房）', hashA === '#room=' + codeA, hashA);

  const qrLink = await A.cdp.eval(`document.getElementById('lan-url').textContent`);
  // 格式要卡死：必须是 http(s)://host/<path>#room=<6 位>，
  // 少了根路径那个斜杠虽然浏览器能打开，复制出去却不像正常网址。
  check('二维码是一条规范的带房间号链接',
    new RegExp(`^https?://[^#]+/#room=${codeA}$`).test(String(qrLink)), String(qrLink));

  const qrShown = await A.cdp.eval(`!!document.querySelector('#qr-holder svg')`);
  check('二维码已渲染成 SVG', qrShown);

  const codeShown = await A.cdp.eval(`document.getElementById('room-code').textContent`);
  check('界面上能看到房间码（可念给对方）', codeShown === codeA, String(codeShown));
  console.log(`    → 二维码内容：${qrLink}\n`);

  console.log('[3] 对照组：手机端「不扫码」自己打开 → 跨网络必然谁也看不见谁');
  const B = await boot('phone', `http://127.0.0.1:${PROXY_B}/`, 9714);
  await waitFor('手机端就绪', () => B.cdp.eval(READY), 20000);
  await sleep(2500);

  const codeB = await B.cdp.eval(`window.__fd.state.sessionRoom`);
  check('手机端拿到的是另一个房间码', codeB !== codeA, `${codeA} vs ${codeB}`);

  const roomA0 = await A.cdp.eval(`window.__fd.signaling.roomId`);
  const roomB0 = await B.cdp.eval(`window.__fd.signaling.roomId`);
  check('两端落进不同房间', roomA0 !== roomB0, `${roomA0} vs ${roomB0}`);

  const blindA = await A.cdp.eval(`window.__fd.signaling.peers.size`);
  const blindB = await B.cdp.eval(`window.__fd.signaling.peers.size`);
  check('电脑看不到手机', blindA === 0, `peers=${blindA}`);
  check('手机看不到电脑', blindB === 0, `peers=${blindB}`);
  console.log('    → 这是改造前的状态：跨网络的设备不会自动出现，只能靠配对码\n');

  console.log('[4] 手机「扫二维码」→ 打开带房间码的链接');
  // 注意这里故意换了入口（PROXY_B 而不是二维码里的 192.168.x.x）——
  // 地址不同无所谓，**房间码相同就会进同一间房**，这正是这套机制的关键。
  await scanNavigate(B.cdp, `http://127.0.0.1:${PROXY_B}/#room=${codeA}`, '手机');

  const codeB2 = await B.cdp.eval(`window.__fd.state.sessionRoom`);
  check('手机沿用了链接里的房间码', codeB2 === codeA, String(codeB2));

  const seen = await waitFor('两端互见', async () => {
    const a = await A.cdp.eval(`window.__fd.signaling.peers.size`);
    const b = await B.cdp.eval(`window.__fd.signaling.peers.size`);
    return (a >= 1 && b >= 1) ? `${a}/${b}` : null;
  }, 25000).catch((e) => { check('两端互见', false, e.message); return null; });
  check('扫码后两端自动互相看见（跨网络）', !!seen, `peers(电脑/手机)=${seen}`);

  const roomA1 = await A.cdp.eval(`window.__fd.signaling.roomId`);
  const roomB1 = await B.cdp.eval(`window.__fd.signaling.roomId`);
  const wantRoom = 'pub:' + codeA;
  check('两端现在在同一间房', roomA1 === roomB1 && roomA1 === wantRoom, `${roomA1} vs ${roomB1}`);
  console.log('');

  console.log('[5] 等待传输通道就绪');
  const st = await waitFor('通道就绪', () =>
    A.cdp.eval(`(() => {
      const p = [...window.__fd.signaling.peers.values()][0];
      if (!p) return null;
      return (p.state === 'connected' || p.state === 'relay') ? p.state + '|' + p.transport.kind : null;
    })()`), 25000).catch((e) => { check('通道就绪', false, e.message); return null; });
  if (st) {
    const [state, kind] = String(st).split('|');
    // 同机两个浏览器都在 127.0.0.1，ICE 靠 host 候选必然直连成功 ——
    // 这里只能证明「链路可建立」，不代表真实跨网络的打洞成功率。
    check('扫码配对后通道已建立', true, `state=${state} transport=${kind}`);
    console.log('    注意：本机测不出真实 NAT 打洞率，跨网络仍需 TURN 兜底\n');
  }

  console.log('[6] 真实传一个文件（2 MB，校验 SHA-256）');
  await B.cdp.eval(`window.__files = []; window.__flashdropOnFile = (f) => window.__files.push(f);`);

  const sendSha = await A.cdp.eval(`(async () => {
    const SIZE = 2 * 1024 * 1024;
    const buf = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) buf[i] = (i * 53 + 11) & 0xff;
    const file = new File([buf], 'scan-room-2mb.bin', { type: 'application/octet-stream' });
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    window.__sendDone = 'pending';
    const p = [...window.__fd.signaling.peers.values()][0];
    p.sendFiles([file]).then(() => { window.__sendDone = 'ok'; })
      .catch((e) => { window.__sendDone = 'err: ' + e.message; });
    return sha;
  })()`);

  let popup = true;
  await waitFor('手机弹出接收确认', () =>
    B.cdp.eval(`!document.getElementById('modal-receive').hidden`), 8000)
    .catch((e) => { check('手机弹出接收确认框', false, e.message); popup = false; });
  if (popup) check('手机弹出接收确认框', true);
  if (popup) await B.cdp.eval(`document.getElementById('btn-accept').click()`);
  else throw new Error('接收端没弹确认框，后续断言无意义');

  const recvSha = await waitFor('手机收完文件', async () => {
    if (!(await B.cdp.eval(`window.__files.length`))) return null;
    return B.cdp.eval(`(async () => {
      const buf = await window.__files[0].blob.arrayBuffer();
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
        .map(b => b.toString(16).padStart(2, '0')).join('');
    })()`);
  }, 60000).catch((e) => { check('手机收完文件', false, e.message); return null; });

  if (recvSha) {
    check('扫码直传后文件内容一致（SHA-256）', recvSha === sendSha,
      recvSha === sendSha ? '' : `\n      发送端 ${sendSha}\n      接收端 ${recvSha}`);
  }
  check('发送侧正常收尾', (await A.cdp.eval(`window.__sendDone`)) === 'ok',
    String(await A.cdp.eval(`window.__sendDone`)));
  console.log('');

  console.log('[7] 原有能力未回归：配对码 / 公共房间入口仍在');
  const uiOk = await A.cdp.eval(`[
    'btn-pair', 'btn-room', 'pair-input', 'room-input', 'pair-code'
  ].every(id => !!document.getElementById(id))`);
  check('配对码与房间的入口还在', uiOk);
  const methods = await A.cdp.eval(`[
    'pairInitiate', 'pairJoin', 'createRoom', 'joinRoom', 'joinSessionRoom'
  ].every(m => typeof window.__fd.signaling[m] === 'function')`);
  check('信令层方法齐备', methods);
  console.log('');

  console.log('[8] 安全边界：服务端会拦住短码穷举');
  // 用一个独立探针连接直接对信令说话（完全绕开 app.js），验的是**服务端**自己会拦。
  // 为什么要拦：房间码是唯一的进门凭证，4 位码空间只有 31^4 ≈ 92 万，
  // 放行的话别人跑几分钟就能把房间扫个遍。
  const probeJoin = (code, scope) => A.cdp.eval(`(async () => {
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    return await new Promise((resolve) => {
      let ws;
      const seen = [];        // 诊断用：把服务端回过的消息类型全记下来，超时才好查
      try { ws = new WebSocket(url); } catch (e) { return resolve({ type: 'ctor-error', reason: e.message }); }
      const done = (v) => { try { ws.close(); } catch { /* noop */ } resolve(v); };
      const timer = setTimeout(() => done({ type: 'timeout', seen }), 8000);
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        seen.push(m.type);
        if (m.type === 'room-joined' || m.type === 'room-error') { clearTimeout(timer); done(Object.assign({}, m, { seen })); }
      };
      ws.onerror = () => { clearTimeout(timer); done({ type: 'ws-error', seen }); };
      ws.onopen = () => ws.send(JSON.stringify(${JSON.stringify({
        type: 'join-room', code, scope, createIfInvalid: true,
      })}));
    });
  })()`);

  const short = await probeJoin('abcd', 'session');
  check('4 位扫码房间码被服务端拒收', short && short.type === 'room-error', JSON.stringify(short));

  const long7 = await probeJoin('abcdefg', 'session');
  check('7 位扫码房间码被服务端拒收', long7 && long7.type === 'room-error', JSON.stringify(long7));

  const ok6 = await probeJoin('zzq7k2', 'session');
  check('6 位扫码房间码正常放行（没误伤）',
    ok6 && ok6.type === 'room-joined' && ok6.scope === 'session', JSON.stringify(ok6));

  const shortPub = await probeJoin('abcd', 'public');
  check('公共房间仍接受 4 位码（用户要手输，不能一起卡死）',
    shortPub && shortPub.type === 'room-joined', JSON.stringify(shortPub));
  console.log('');

  console.log('[9] 房间人数上限：扫码房间第 3 个人进不来');
  // 此刻 A 和 B 都在 codeA 这间扫码房间里 —— 正好 2/2。
  // 再用一个独立探针去 join 同一个码：探针完全绕开 app.js，验的是**服务端**会拦。
  // 为什么必须有这条上限：房间码是唯一的进门凭证，二维码一旦被截图转发，
  // 拿到的人都进得来（码长只防瞎猜）。限死人数才真正关上这个口子。
  const third = await probeJoin(codeA, 'session');
  check('第 3 个连接被服务端拒（房间已满）',
    third && third.type === 'room-error' && third.code === 'room-full', JSON.stringify(third));
  check('拒绝时带上了人数信息（界面才能说清原因）',
    third && third.limit === 2 && third.count === 2, JSON.stringify(third));

  // 对照：上面若是因为别的原因被拒（比如码格式），这条就露馅 ——
  // 沿用同一间房的 6 位码换个 scope 也不行，必须是真的撞上人数上限。
  check('[8] 的空房间能进、这里满员被拒 → 是人数上限而非码被拒',
    !!(ok6 && ok6.type === 'room-joined') && !!(third && third.code === 'room-full'),
    `空房 ${ok6 && ok6.type} / 满员 ${third && third.code}`);

  const peerCount = await A.cdp.eval(`window.__fd.signaling.peers.size`);
  check('第 3 人被拒不影响原有两端', peerCount === 1, String(peerCount));
  console.log('');

  console.log('===== 结果 =====');
  console.log(`  通过 ${passed} 项，失败 ${failed} 项\n`);
  return failed === 0 ? 0 : 1;
}

main()
  .then(async (code) => { await cleanup(); process.exit(code); })
  .catch(async (e) => {
    console.error('\n测试中断：', e && e.message ? e.message : e);
    console.error(e && e.stack ? e.stack.split('\n').slice(1, 4).join('\n') : '');
    await cleanup();
    process.exit(2);
  });
