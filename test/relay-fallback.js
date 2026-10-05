/**
 * 最坏情况兜底测试：点对点彻底打不通时，还能不能把文件传完
 * ---------------------------------------------------------------------------
 * 为什么必须单独测这一条：
 *
 *   两台手机各自走移动网络时，多半都躲在运营商级 NAT（CGNAT）后面。
 *   这种情况下 P2P 穿透**根本不可能**，STUN 拿到的都是对方没用的地址。
 *   如果此时没有兜底，用户看到的就是永远卡在「连接中」——
 *   而且这个用户群占比不低，正是「不同地域、不同网络」这个需求的正面战场。
 *
 * 实现手法：在页面加载前把 RTCPeerConnection 改造成**只接受 relay 候选**
 *   （iceTransportPolicy:'relay'）且不给任何 TURN 服务器 ——
 *   效果等同于「两端都在严格 NAT 后面、也没有可用中继」。
 *   于是 ICE 必然失败，必须由程序自己降级到 WebSocket 中继把数据送过去。
 *
 * 判据：transport.kind 必须是 relay，且文件 SHA-256 完全一致。
 *
 * 跑法：node test/relay-fallback.js
 * 前提：无（脚本自己拉起服务）
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
const SRV_PORT = 8694;

/**
 * 让所有 RTCPeerConnection 都变成「打不通 P2P」的形态：
 *   · iceTransportPolicy: 'relay' → 只收集中继候选，不收集 host / srflx
 *   · iceServers: []              → 一个中继服务器都不给，于是无候选可用
 * 这正是双端 CGNAT + 无 TURN 的真实处境。
 */
const FORCE_NO_P2P = `
  (() => {
    const Orig = window.RTCPeerConnection;
    if (!Orig) return;
    function Patched(cfg, ...rest) {
      const c = Object.assign({}, cfg || {}, {
        iceTransportPolicy: 'relay',
        iceServers: [],
      });
      return new Orig(c, ...rest);
    }
    Patched.prototype = Orig.prototype;
    Object.setPrototypeOf(Patched, Orig);
    window.RTCPeerConnection = Patched;
  })();
`;

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? '  ' + detail : ''}`); }
}

let srvProc = null;
const instances = [];
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
    env: { ...process.env, NO_TLS: '1', PORT: String(SRV_PORT), PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srvProc.stdout.on('data', () => { /* 忽略 banner */ });
  srvProc.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  await waitPort(SRV_PORT);
}

async function cleanup() {
  for (const c of instances) { try { await c.close(); } catch { /* noop */ } }
  await sleep(600);
  if (srvProc) { try { srvProc.kill(); } catch { /* noop */ } }
  await sleep(400);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
}

async function boot(label, url, port) {
  const profileDir = tempProfile(`fd-rf-${label}-`);
  tmpDirs.push(profileDir);
  const inst = await launch({ label, url, port, profileDir, headless: true, chrome: CHROME });
  instances.push(inst);
  await inst.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FORCE_NO_P2P });
  await inst.cdp.send('Page.reload');
  await waitFor(`${label} 重载完成`, async () => {
    try { return await inst.cdp.eval(`document.readyState === 'complete' && typeof window.FlashDrop === 'object'`); }
    catch { return false; }
  }, 25000, 250);
  await sleep(900);
  return inst;
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error(`找不到 Chrome：${CHROME}\n用 CHROME=... 指定路径。`);
    process.exit(2);
  }

  console.log('\n===== 兜底链路上限测试：P2P 完全打不通时 =====');
  console.log('  两端都已改造为「只收中继候选 + 无 TURN」——等效双端 CGNAT 且无中继\n');

  console.log('[1] 拉起服务与两个浏览器');
  await startServer();
  const A = await boot('A', `http://127.0.0.1:${SRV_PORT}`, 9731);
  const B = await boot('B', `http://127.0.0.1:${SRV_PORT}`, 9732);
  console.log('    完成\n');

  console.log('[2] 确认改造生效：P2P 确实拿不到候选');
  const peers = await waitFor('两端互相发现', () => A.cdp.eval(`window.__fd.signaling.peers.size`), 25000)
    .catch((e) => { check('两端互相发现', false, e.message); return 0; });
  check('两台设备互相发现（同房间）', peers >= 1, `peers=${peers}`);
  console.log('');

  console.log('[3] 等待程序自行判定「P2P 不通」并降级（可能需要 6–15 秒）');
  const st = await waitFor('降级到中继', () => A.cdp.eval(`(() => {
    const p = [...window.__fd.signaling.peers.values()][0];
    if (!p) return null;
    return p.transport && p.transport.kind === 'relay' && p.state === 'relay'
      ? 'relay' : null;
  })()`), 40000).catch((e) => { check('自动降级到中继', false, e.message); return null; });
  check('P2P 不通时自动降级到 WebSocket 中继', st === 'relay');

  const bKind = await B.cdp.eval(`(() => {
    const p = [...window.__fd.signaling.peers.values()][0];
    return p && p.transport ? p.transport.kind + '/' + p.state : '';
  })()`);
  check('对端也已切到中继', String(bKind).startsWith('relay'), bKind);
  console.log('');

  console.log('[4] 走中继传 3 个文件（含中文名）');
  await B.cdp.eval(`window.__files = []; window.__flashdropOnFile = (f) => window.__files.push(f);`);
  const wantSha = await A.cdp.eval(`(async () => {
    const mk = (name, kb, mime, seed) => {
      const size = Math.max(1, Math.round(kb * 1024));
      const buf = new Uint8Array(size);
      for (let i = 0; i < size; i++) buf[i] = (i * seed + 11) & 0xff;
      return new File([buf], name, { type: mime });
    };
    const files = [
      mk('中继测试图片.jpg', 900, 'image/jpeg', 29),
      mk('说明文档.pdf', 700, 'application/pdf', 47),
      mk('数据包.zip', 500, 'application/zip', 83),
    ];
    const shas = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      shas.push([...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
        .map(x => x.toString(16).padStart(2, '0')).join(''));
    }
    window.__sendDone = 'pending';
    const p = [...window.__fd.signaling.peers.values()][0];
    p.sendFiles(files).then(() => { window.__sendDone = 'ok'; })
      .catch((e) => { window.__sendDone = 'err: ' + e.message; });
    return shas.join(',');
  })()`);

  await waitFor('B 弹出接收确认', () => B.cdp.eval(`!document.getElementById('modal-receive').hidden`), 30000)
    .then(() => check('对端弹出接收确认框', true))
    .catch((e) => check('对端弹出接收确认框', false, e.message));
  await B.cdp.eval(`document.getElementById('btn-accept').click()`);

  const recv = await waitFor('B 收完 3 个文件', async () => {
    if (await B.cdp.eval(`window.__files.length`) < 3) return null;
    return B.cdp.eval(`(async () => {
      const out = [];
      for (const f of window.__files) {
        const buf = await f.blob.arrayBuffer();
        out.push(f.name + ':' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
          .map(x => x.toString(16).padStart(2, '0')).join(''));
      }
      return out.join('|');
    })()`);
  }, 120000).catch((e) => { check('B 收完 3 个文件', false, e.message); return null; });

  if (recv) {
    const got = String(recv).split('|').map((s) => s.split(':')[1]);
    const want = String(wantSha).split(',');
    check('中继下 3 个文件内容完全一致（SHA-256）',
      got.length === 3 && got.every((h, i) => h === want[i]),
      got.length === 3 ? '中文名与内容均正确' : `只收到 ${got.length} 个`);
    console.log('    收到：' + String(recv).split('|').map((s) => s.split(':')[0]).join('、'));
  }
  check('发送侧正常收尾', (await A.cdp.eval(`window.__sendDone`)) === 'ok');
  console.log('');

  console.log('[5] 走中继传 6 MB 单文件（测中继吞吐）');
  await B.cdp.eval(`window.__files = []; window.__flashdropOnFile = (f) => window.__files.push(f);`);
  const bigSha = await A.cdp.eval(`(async () => {
    const SIZE = 6 * 1024 * 1024;
    const buf = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) buf[i] = (i * 191 + 5) & 0xff;
    const file = new File([buf], 'relay-6mb.bin', { type: 'application/octet-stream' });
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
      .map(x => x.toString(16).padStart(2, '0')).join('');
    const p = [...window.__fd.signaling.peers.values()][0];
    p.sendFiles([file]).catch(() => {});
    return sha;
  })()`);

  await waitFor('B 弹出接收确认', () => B.cdp.eval(`!document.getElementById('modal-receive').hidden`), 30000)
    .catch((e) => check('6MB：对端弹出接收确认框', false, e.message));
  await B.cdp.eval(`document.getElementById('btn-accept').click()`);
  await sleep(150);
  await B.cdp.eval(`window.__t0 = Date.now()`);

  const gotBig = await waitFor('B 收完 6 MB', async () => {
    if (!(await B.cdp.eval(`window.__files.length`))) return null;
    return B.cdp.eval(`(async () => {
      const buf = await window.__files[0].blob.arrayBuffer();
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
        .map(x => x.toString(16).padStart(2, '0')).join('');
      return sha + '|' + (Date.now() - window.__t0);
    })()`);
  }, 180000).catch((e) => { check('B 收完 6 MB', false, e.message); return null; });

  if (gotBig) {
    const [sha, ms] = String(gotBig).split('|');
    const mbps = (6 / (Number(ms) / 1000)).toFixed(2);
    check('中继下 6 MB 内容一致', sha === bigSha, `${mbps} MB/s`);
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
