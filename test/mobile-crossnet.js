/**
 * 移动端跨地域 / 跨网络场景仿真：手机 ↔ 手机（各自走自己的移动网络）
 * ---------------------------------------------------------------------------
 * 老板的要求是「两台手机在不同地域、不同网络下也能稳定互传」。这个场景和
 * 同 Wi-Fi 有本质区别，必须单独验：
 *
 *   1) 两台手机出口 IP 不同 → 按 IP 分房必然把两部落到不同房间
 *      → 「自动发现」彻底失效，只能靠 6 位配对码跨房间找对方
 *   2) 两端都是移动端浏览器（多半没有 File System Access API）
 *      → 接收只能全攒内存，大文件有内存天花板
 *
 * 实现手法与 crossnet.js 一致：本机起两个反向代理，向信令服务注入不同的
 * X-Forwarded-For，让服务端以为两个浏览器来自不同的移动网络。浏览器无法自己
 * 伪造这个头，只能靠反代 —— 而这恰好就是真实部署（Nginx / Cloudflare）的链路。
 *
 * ⚠ 保真度说明（别把结论读过头）：
 *   两个浏览器跑在同一台机器上，ICE 能靠 host 候选直连成功，所以本测试里的
 *   transport 会是 p2p —— 但真实的两台手机在 CGNAT 后面时通常打不通 P2P，
 *   必须靠 TURN 中继。那条「P2P 完全不通」的兜底链路由 test/relay-fallback.js 单独验。
 *
 * 跑法：node test/mobile-crossnet.js
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

const SRV_PORT = 8693;                 // FlashDrop 信令服务
const PROXY_A = 9121;                  // 「手机 A」入口
const PROXY_B = 9122;                  // 「手机 B」入口
const IP_A = '198.51.100.10';          // 假装是移动网络出口（地域一）
const IP_B = '203.0.113.99';           // 假装是移动网络出口（地域二）

const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

// 等效 iOS Safari 等不支持流式落盘的浏览器
const NO_FS_ACCESS = `
  try {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined, configurable: true, writable: true,
    });
  } catch (e) { /* noop */ }
`;

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

/* ============================== 服务与浏览器生命周期 ============================== */

let srvProc = null;
const instances = [];
const proxies = [];
const tmpDirs = [];

function waitPort(port, tries = 60) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/info' }, (res) => { res.resume(); resolve(true); });
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
      // 只认连接地址分房，忽略浏览器自己上报的出口地址（同上：否则伪造的 IP 会被顶掉）
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

async function bootMobile(label, url, port, ua) {
  const profileDir = tempProfile(`fd-mx-${label}-`);
  tmpDirs.push(profileDir);
  const inst = await launch({
    label, url, port, profileDir, headless: true, chrome: CHROME,
    width: 390, height: 844,
  });
  instances.push(inst);

  await inst.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_FS_ACCESS });
  await inst.cdp.send('Emulation.setUserAgentOverride', { userAgent: ua });
  await inst.cdp.send('Page.reload');
  await waitFor(`${label} 重载完成`, async () => {
    try { return await inst.cdp.eval(`document.readyState === 'complete' && typeof window.FlashDrop === 'object'`); }
    catch { return false; }
  }, 25000, 250);
  await sleep(1000);
  return inst;
}

/* ============================== 主流程 ============================== */

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error(`找不到 Chrome：${CHROME}\n用 CHROME=... 指定路径。`);
    process.exit(2);
  }

  console.log('\n===== 移动端跨地域场景自测（手机 A ↔ 手机 B，各自不同网络）=====');
  console.log(`  信令服务：127.0.0.1:${SRV_PORT}（TRUST_PROXY=1）`);
  console.log(`  手机 A 入口：127.0.0.1:${PROXY_A}  →  出口 IP ${IP_A}`);
  console.log(`  手机 B 入口：127.0.0.1:${PROXY_B}  →  出口 IP ${IP_B}\n`);

  console.log('[1] 拉起服务与两个反代');
  await startServer();
  proxies.push(startProxy(PROXY_A, IP_A));
  proxies.push(startProxy(PROXY_B, IP_B));
  await sleep(400);
  console.log('    完成\n');

  console.log('[2] 两台手机从各自的网络接入');
  const A = await bootMobile('A', `http://127.0.0.1:${PROXY_A}`, 9721, UA_ANDROID);
  const B = await bootMobile('B', `http://127.0.0.1:${PROXY_B}`, 9722, UA_IPHONE);
  await sleep(2000);

  const roomA = await A.cdp.eval(`window.__fd.signaling.roomId || ''`);
  const roomB = await B.cdp.eval(`window.__fd.signaling.roomId || ''`);
  console.log(`    手机 A 落房：${roomA}`);
  console.log(`    手机 B 落房：${roomB}`);
  check('两台手机来自不同网络，落进不同房间', !!roomA && !!roomB && roomA !== roomB,
    roomA === roomB ? '竟然同房' : '');
  console.log('');

  console.log('[3] 确认「自动发现」在这种场景下确实失效');
  await sleep(1200);
  const autoA = await A.cdp.eval(`window.__fd.signaling.peers.size`);
  const autoB = await B.cdp.eval(`window.__fd.signaling.peers.size`);
  check('手机 A 看不到手机 B', autoA === 0, `peers=${autoA}`);
  check('手机 B 看不到手机 A', autoB === 0, `peers=${autoB}`);
  console.log('    → 跨网络的手机不会自动出现，必须手动配对\n');

  console.log('[4] 用 6 位配对码跨房间配对');
  await A.cdp.eval(`window.__fd.signaling.pairInitiate()`);
  const code = await waitFor('手机 A 生成配对码', async () => {
    const t = await A.cdp.eval(`document.getElementById('pair-code').textContent`);
    return /^\d{6}$/.test(String(t).trim()) ? String(t).trim() : null;
  }, 15000).catch((e) => { check('生成配对码', false, e.message); return null; });
  if (!code) throw new Error('拿不到配对码，后续无法继续');
  check('手机 A 生成 6 位配对码', true, code);

  await B.cdp.eval(`window.__fd.signaling.pairJoin(${JSON.stringify(code)})`);
  const joined = await waitFor('手机 B 进入配对房间', () =>
    B.cdp.eval(`window.__fd.signaling.peers.size`), 20000)
    .catch((e) => { check('手机 B 加入配对', false, e.message); return 0; });
  check('手机 B 用配对码找到对方', joined >= 1, `peers=${joined}`);

  const seen = await waitFor('手机 A 也看到 B', () =>
    A.cdp.eval(`window.__fd.signaling.peers.size`), 20000)
    .catch((e) => { check('手机 A 看到 B', false, e.message); return 0; });
  check('手机 A 看到手机 B', seen >= 1, `peers=${seen}`);
  console.log('');

  console.log('[5] 传输通道');
  const st = await waitFor('通道就绪', () => A.cdp.eval(`(() => {
    const p = [...window.__fd.signaling.peers.values()][0];
    return p && (p.state === 'connected' || p.state === 'relay') ? p.state + '|' + p.transport.kind : null;
  })()`), 30000).catch((e) => { check('通道就绪', false, e.message); return null; });
  if (st) {
    const [state, kind] = String(st).split('|');
    check('跨房间配对后通道建立', state === 'connected' || state === 'relay',
      `state=${state} transport=${kind}`);
    console.log(`    通道类型：${kind}${kind === 'p2p'
      ? '（本机双实例能直连；真机在 CGNAT 后面时多半会降到中继）'
      : '（已走中继，数据经服务器转发）'}`);
  }
  console.log('');

  console.log('[6] 手机 A → 手机 B：文字');
  const MARK = 'cross-region-' + Date.now();
  await A.cdp.eval(`(() => {
    const p = [...window.__fd.signaling.peers.values()][0];
    p.sendText(${JSON.stringify(MARK)});
  })()`);
  await waitFor('B 显示文字气泡', () =>
    B.cdp.eval(`[...document.querySelectorAll('.text-bubble')].some(e => e.textContent.includes(${JSON.stringify(MARK)}))`), 15000)
    .then((ok) => check('手机 B 收到文字', ok === true))
    .catch((e) => check('手机 B 收到文字', false, e.message));
  console.log('');

  console.log('[7] 手机 A → 手机 B：3 个文件（含中文名，约 8 MB）');
  await B.cdp.eval(`window.__files = []; window.__flashdropOnFile = (f) => window.__files.push(f);`);
  const wantSha = await A.cdp.eval(`(async () => {
    const mk = (name, mb, mime, seed) => {
      const size = Math.round(mb * 1024 * 1024);
      const buf = new Uint8Array(size);
      for (let i = 0; i < size; i++) buf[i] = (i * seed + 7) & 0xff;
      return new File([buf], name, { type: mime });
    };
    const files = [
      mk('外地拍的视频封面.jpg', 4, 'image/jpeg', 43),
      mk('出差报销单.pdf', 3, 'application/pdf', 71),
      mk('会议录音.m4a', 1, 'audio/mp4', 97),
    ];
    const shas = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      shas.push([...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
        .map(x => x.toString(16).padStart(2, '0')).join(''));
    }
    window.__want = shas;
    window.__sendDone = 'pending';
    const p = [...window.__fd.signaling.peers.values()][0];
    p.sendFiles(files).then(() => { window.__sendDone = 'ok'; })
      .catch((e) => { window.__sendDone = 'err: ' + e.message; });
    return shas.join(',');
  })()`);

  await waitFor('B 弹出接收确认', () => B.cdp.eval(`!document.getElementById('modal-receive').hidden`), 30000)
    .then(() => check('手机 B 弹出接收确认框', true))
    .catch((e) => check('手机 B 弹出接收确认框', false, e.message));

  await B.cdp.eval(`document.getElementById('btn-accept').click()`);
  const recv = await waitFor('B 收完 3 个文件', async () => {
    if (await B.cdp.eval(`window.__files.length`) < 3) return null;
    return B.cdp.eval(`(async () => {
      const out = [];
      for (const f of window.__files) {
        const buf = await f.blob.arrayBuffer();
        out.push(f.name + ':' + f.saved + ':' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
          .map(x => x.toString(16).padStart(2, '0')).join(''));
      }
      return out.join('|');
    })()`);
  }, 120000).catch((e) => { check('B 收完 3 个文件', false, e.message); return null; });

  if (recv) {
    const parts = String(recv).split('|').map((s) => s.split(':'));
    const got = parts.map((p) => p[2]);
    const want = String(wantSha).split(',');
    check('3 个文件全部收到且内容一致（SHA-256）',
      got.length === 3 && got.every((h, i) => h === want[i]),
      got.length === 3 ? '中文名与内容均正确' : `只收到 ${got.length} 个`);
    check('跨网络下仍走「内存接收」（移动端无流式落盘）', parts.every((p) => p[1] === 'memory'),
      parts.map((p) => `${p[0]}=${p[1]}`).join(' '));
    console.log('    收到：' + parts.map((p) => p[0]).join('、'));
  }
  check('发送侧正常收尾', (await A.cdp.eval(`window.__sendDone`)) === 'ok');
  console.log('');

  const BIG_MB = 40;
  console.log(`[8] 反向：手机 B → 手机 A：${BIG_MB} MB 单文件（跨网络大文件）`);
  await A.cdp.eval(`window.__files = []; window.__flashdropOnFile = (f) => window.__files.push(f);`);
  const bigSha = await B.cdp.eval(`(async () => {
    const SIZE = ${BIG_MB} * 1024 * 1024;
    const buf = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) buf[i] = (i * 233 + 17) & 0xff;
    const file = new File([buf], 'cross-region.bin', { type: 'application/octet-stream' });
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
      .map(x => x.toString(16).padStart(2, '0')).join('');
    const p = [...window.__fd.signaling.peers.values()][0];
    p.sendFiles([file]).catch(() => {});
    return sha;
  })()`);

  await waitFor('A 弹出接收确认', () => A.cdp.eval(`!document.getElementById('modal-receive').hidden`), 30000)
    .catch((e) => check('手机 A 弹出接收确认框', false, e.message));
  await A.cdp.eval(`document.getElementById('btn-accept').click()`);
  await sleep(150);
  await A.cdp.eval(`window.__t0 = Date.now()`);

  const gotBig = await waitFor(`A 收完 ${BIG_MB} MB`, async () => {
    if (!(await A.cdp.eval(`window.__files.length`))) return null;
    return A.cdp.eval(`(async () => {
      const buf = await window.__files[0].blob.arrayBuffer();
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
        .map(x => x.toString(16).padStart(2, '0')).join('');
      return sha + '|' + (Date.now() - window.__t0);
    })()`);
  }, 180000).catch((e) => { check(`A 收完 ${BIG_MB} MB`, false, e.message); return null; });

  if (gotBig) {
    const [sha, ms] = String(gotBig).split('|');
    const mbps = (BIG_MB / (Number(ms) / 1000)).toFixed(2);
    check(`${BIG_MB} MB 跨网络完整送达`, sha === bigSha, `${mbps} MB/s`);
  }
  console.log('');

  console.log(`===== 结果：${passed} 通过 / ${failed} 失败 =====\n`);
  await cleanup();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\n测试异常：', e && e.stack || e);
  await cleanup();
  process.exit(3);
});
