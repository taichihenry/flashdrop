/**
 * 跨网络场景自测
 * ---------------------------------------------------------------------------
 * 模拟「电脑走家庭 WiFi（宽带出口 IP）」+「手机走移动网络（运营商出口 IP）」
 * 两台设备连同一个公网部署的 FlashDrop 服务，验证：
 *   1. 自动发现（LAN 房间）在这种场景下必然失效 —— 两端落在不同房间
 *   2. 用 6 位配对码能让它们跨房间建立连接
 *   3. 配对之后文件能真实送达（SHA-256 一致）
 *
 * 实现手法：本机起两个反向代理，向信令服务注入不同的 X-Forwarded-For，
 * 让服务端以为两个浏览器来自不同网络。浏览器无法自定义这个头，只能靠反代模拟——
 * 而这恰好也就是真实反代部署（Nginx / Cloudflare）时的链路，顺便把
 * TRUST_PROXY 那条路一起验了。
 *
 * 跑法：node test/crossnet.js
 * 前提：无（脚本自己拉起服务和反代）
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

const SRV_PORT = 8691;                 // FlashDrop 信令服务
const PROXY_A = 9111;                  // 「电脑」入口
const PROXY_B = 9112;                  // 「手机」入口
const IP_A = '198.51.100.10';          // 假装是家庭宽带公网出口
const IP_B = '203.0.113.99';           // 假装是移动网络出口

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
      TRUST_PROXY: '1',        // 关键：信任反代注入的来源 IP
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
  const profileDir = tempProfile(`fd-x-${label}-`);
  tmpDirs.push(profileDir);
  const inst = await launch({ label, url, port, profileDir, headless: true, chrome: CHROME });
  instances.push(inst);
  return inst;
}

/* ============================== 主流程 ============================== */

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error(`找不到 Chrome：${CHROME}\n用 CHROME=... 指定路径。`);
    process.exit(2);
  }

  console.log('\n===== 跨网络场景自测（电脑 WiFi ↔ 手机移动网络）=====');
  console.log(`  信令服务：127.0.0.1:${SRV_PORT}（TRUST_PROXY=1）`);
  console.log(`  电脑入口：127.0.0.1:${PROXY_A}  →  来源 IP ${IP_A}`);
  console.log(`  手机入口：127.0.0.1:${PROXY_B}  →  来源 IP ${IP_B}\n`);

  console.log('[1] 拉起服务与两个反代');
  await startServer();
  proxies.push(startProxy(PROXY_A, IP_A));
  proxies.push(startProxy(PROXY_B, IP_B));
  await sleep(400);
  console.log('    完成\n');

  console.log('[2] 两个浏览器分别从「不同网络」接入');
  const A = await boot('pc', `http://127.0.0.1:${PROXY_A}`, 9711);
  const B = await boot('phone', `http://127.0.0.1:${PROXY_B}`, 9712);
  await sleep(2500);

  const roomA = await A.cdp.eval(`window.__fd.signaling.roomId || ''`);
  const roomB = await B.cdp.eval(`window.__fd.signaling.roomId || ''`);
  console.log(`    电脑落房：${roomA}`);
  console.log(`    手机落房：${roomB}`);
  check('两端来自不同网络，落进不同房间', !!roomA && !!roomB && roomA !== roomB,
    roomA === roomB ? '竟然同房' : '');
  console.log('');

  console.log('[3] 验证「自动发现」在这种场景下确实失效');
  await sleep(1500);
  const autoA = await A.cdp.eval(`window.__fd.signaling.peers.size`);
  const autoB = await B.cdp.eval(`window.__fd.signaling.peers.size`);
  check('电脑看不到手机', autoA === 0, `peers=${autoA}`);
  check('手机看不到电脑', autoB === 0, `peers=${autoB}`);
  console.log('    → 跨网络的设备不会互相出现，这是按 IP 分房的必然结果\n');

  console.log('[4] 用 6 位配对码跨房间配对');
  await A.cdp.eval(`window.__fd.signaling.pairInitiate()`);
  const code = await waitFor('电脑生成配对码', async () => {
    const t = await A.cdp.eval(`document.getElementById('pair-code').textContent`);
    return /^\d{6}$/.test(String(t).trim()) ? String(t).trim() : null;
  }, 15000).catch((e) => { check('生成配对码', false, e.message); return null; });
  if (!code) throw new Error('拿不到配对码，后续无法继续');
  check('生成 6 位配对码', true, code);

  await B.cdp.eval(`window.__fd.signaling.pairJoin(${JSON.stringify(code)})`);
  const joined = await waitFor('手机进入配对房间', () =>
    B.cdp.eval(`window.__fd.signaling.peers.size`), 20000)
    .catch((e) => { check('手机加入配对', false, e.message); return 0; });
  check('手机加入配对房间', joined >= 1, `peers=${joined}`);

  const seen = await waitFor('电脑也看到手机', () =>
    A.cdp.eval(`window.__fd.signaling.peers.size`), 20000)
    .catch((e) => { check('电脑看到手机', false, e.message); return 0; });
  check('电脑看到手机（跨网络互见）', seen >= 1, `peers=${seen}`);
  console.log('');

  console.log('[5] 等待传输通道就绪');
  const state = await waitFor('通道就绪', () =>
    A.cdp.eval(`(() => {
      const p = [...window.__fd.signaling.peers.values()][0];
      if (!p) return null;
      return (p.state === 'connected' || p.state === 'relay') ? p.state + '|' + p.transport.kind : null;
    })()`), 25000).catch((e) => { check('通道就绪', false, e.message); return null; });
  if (state) {
    const [st, kind] = String(state).split('|');
    // 本机两个浏览器都在 127.0.0.1，WebRTC 必然走 host candidate 直连，
    // 所以这里只能证明「链路可建立」，不能代表真实跨网络的打洞成功率。
    check('跨网络配对后通道已建立', true, `state=${st} transport=${kind}`);
    console.log('    注意：本机测不出真实 NAT 打洞率，跨网络必须配 TURN 兜底\n');
  }

  console.log('[6] 跨网络传文件（2 MB，校验 SHA-256）');
  await B.cdp.eval(`window.__files = []; window.__flashdropOnFile = (f) => window.__files.push(f);`);

  // —— 诊断探针：抓两端实际收发的消息 ——
  await A.cdp.eval(`(() => {
    window.__tx = [];
    const s = window.__fd.signaling;
    const orig = s.send.bind(s);
    s.send = (m) => {
      const tag = m.type + (m.roomId ? '@' + String(m.roomId).slice(7, 14) : '@NO-ROOM');
      window.__tx.push(tag);
      if (window.__tx.length > 80) window.__tx.shift();
      return orig(m);
    };
    return true;
  })()`);
  await B.cdp.eval(`(() => {
    window.__rx = [];
    const s = window.__fd.signaling;
    const rr = s._routeRelay.bind(s);
    s._routeRelay = (m) => {
      window.__rx.push('relay/' + (m.payload ? m.payload.kind : '?') + '/' +
        (m.payload && m.payload.kind === 'text' ? String(m.payload.data).slice(0, 70) : ''));
      return rr(m);
    };
    const rs = s._routeSignal.bind(s);
    s._routeSignal = (m) => { window.__rx.push('signal/' + (m.signal ? m.signal.type : '?')); return rs(m); };
    return true;
  })()`);

  const dump = async () => {
    console.log('    A 端 peers 明细：');
    console.log('      ' + await A.cdp.eval(`JSON.stringify([...window.__fd.signaling.peers.values()]
      .map(p => ({ id: p.id.slice(0, 8), state: p.state, kind: p.transport.kind, room: String(p.roomId).slice(0, 16) })))`));
    console.log('    B 端 peers 明细：');
    console.log('      ' + await B.cdp.eval(`JSON.stringify([...window.__fd.signaling.peers.values()]
      .map(p => ({ id: p.id.slice(0, 8), state: p.state, kind: p.transport.kind, room: String(p.roomId).slice(0, 16) })))`));
    console.log('    A 发出（尾部 14 条）：');
    for (const t of await A.cdp.eval(`window.__tx.slice(-14)`)) console.log('      → ' + t);
    console.log('    B 收到（尾部 14 条）：');
    for (const t of await B.cdp.eval(`window.__rx.slice(-14)`)) console.log('      ← ' + t);
  };
  const sendSha = await A.cdp.eval(`(async () => {
    const SIZE = 2 * 1024 * 1024;
    const buf = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) buf[i] = (i * 53 + 11) & 0xff;
    const file = new File([buf], 'crossnet-2mb.bin', { type: 'application/octet-stream' });
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
  else { await dump(); throw new Error('接收端没弹确认框，后续断言无意义'); }

  const recvSha = await waitFor('手机收完文件', async () => {
    if (!(await B.cdp.eval(`window.__files.length`))) return null;
    return B.cdp.eval(`(async () => {
      const buf = await window.__files[0].blob.arrayBuffer();
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
        .map(b => b.toString(16).padStart(2, '0')).join('');
    })()`);
  }, 60000).catch((e) => { check('手机收完文件', false, e.message); return null; });

  if (recvSha) {
    check('跨网络文件内容一致（SHA-256）', recvSha === sendSha,
      recvSha === sendSha ? '' : `\n      发送端 ${sendSha}\n      接收端 ${recvSha}`);
  }
  const done = await A.cdp.eval(`window.__sendDone`);
  check('发送侧正常收尾', done === 'ok', String(done));
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
