/**
 * ICE 配置测试：P2P 到底有没有拿到 STUN
 * ---------------------------------------------------------------------------
 * 为什么必须单独测这一条：
 *
 *   RTCPeerConnection 的 iceServers 如果是空数组，浏览器就**只能收集 host
 *   候选**（本机网卡地址）。跨网络时对端根本路由不到这些地址，于是 P2P 一次
 *   都不会成功，所有连接静默掉进 WebSocket 中继 —— 表面上"能用"，实际又慢
 *   又白烧 Durable Object 额度，而且用户完全看不出哪里不对。
 *
 *   这个坑非常隐蔽：`new RTCPeerConnection()` 不传 iceServers **不会报错也
 *   不会警告**，ICE 依然会"成功地"跑到 failed 状态。所以只能靠断言守住。
 *
 * 验证方式分两层（缺一不可）：
 *   [A] 静态层：signaling.config.iceServers 里必须有 STUN —— 证明配置写对了。
 *   [B] 运行时层：拦截 RTCPeerConnection 构造函数，记录浏览器**真实收到**的
 *       configuration —— 证明配置真的传到了 WebRTC API，而不是躺在某个变量里
 *       没被用上（"配了没接线"是这类 bug 最常见的形态）。
 *
 * 另一条同等重要：**没配 TURN 时不能凭空出现 TURN**。STUN 免费，TURN 按
 * 出口流量计费（$0.05/GB，每月前 1000 GB 免费）。这两者必须分得清清楚楚。
 *
 * 跑法：node test/ice-config.js
 * 前提：无（脚本自己拉起服务）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { launch, waitFor, sleep, tempProfile, findChrome } = require('./lib');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const CHROME = findChrome();
const SRV_PORT = 8698;

/**
 * 把浏览器真实收到的 ICE 配置录下来。
 *
 * 必须用 addScriptToEvaluateOnNewDocument 在**页面脚本执行前**打补丁，
 * launch 之后再 eval 就晚了 —— net.js 那时候已经把 Peer 都建完了。
 */
const RECORD_ICE_CONFIG = `
  (() => {
    // 顺便把 fetch 的 URL 也录下来，用来验证「没配 TURN 时不会白跑
    // /turn-credentials」—— 那个请求在 Cloudflare 上要花 1 次 Worker 请求
    // + 1 次 DO 请求，白跑就是白烧额度。
    window.__fetchedUrls = [];
    const of = window.fetch;
    if (of) {
      window.fetch = function (u, ...rest) {
        try { window.__fetchedUrls.push(String(u)); } catch { /* noop */ }
        return of.call(this, u, ...rest);
      };
    }

    const Orig = window.RTCPeerConnection;
    if (!Orig) return;
    window.__iceCfgs = [];
    function Patched(cfg, ...rest) {
      try {
        window.__iceCfgs.push({
          iceServers: (cfg && cfg.iceServers) || [],
          policy: (cfg && cfg.iceTransportPolicy) || 'all',
        });
      } catch { /* 记录失败不能影响建连 */ }
      return new Orig(cfg, ...rest);
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

/**
 * 从源码里抠出一个 `xxx = [ { urls: '...' } ]` 数组的 urls 列表。
 *
 * 为什么要读源码而不是 import：三份列表分处三个进程/运行时
 * （public/net.js 跑浏览器、server.js 跑 Node、cloudflare/src/room.js 跑
 * Worker），没有一个能同时 import 它们的宿主。而"三处各写一份、改一处忘两处"
 * 恰恰是这个项目反复踩的坑（TURN 上限、ROOM_HASH_RE 都中过招），
 * 所以这里用最笨但最可靠的办法把漂移钉死。
 */
function readIceArray(file, marker) {
  const src = fs.readFileSync(file, 'utf8');
  const idx = src.indexOf(marker);
  if (idx < 0) return null;
  const open = src.indexOf('[', idx);
  const close = src.indexOf(']', open);
  if (open < 0 || close < 0) return null;
  const body = src.slice(open + 1, close);
  return [...body.matchAll(/urls:\s*'([^']+)'/g)].map((m) => m[1]);
}

function waitPort(port, tries = 80) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/info`);
        if (r.ok) return resolve();
      } catch { /* 还没起来 */ }
      if (++n >= tries) return reject(new Error(`服务未在 ${port} 上就绪`));
      setTimeout(tick, 300);
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

async function boot(label, port) {
  const profileDir = tempProfile(`fd-ice-${label}-`);
  tmpDirs.push(profileDir);
  const inst = await launch({
    label, url: `http://127.0.0.1:${SRV_PORT}`, port, profileDir, chrome: CHROME, headless: true,
  });
  instances.push(inst);
  // 打补丁之后必须重载，否则页面已经跑完初始化了
  await inst.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORD_ICE_CONFIG });
  await inst.cdp.send('Page.reload');
  await waitFor(`${label} 重载完成`, async () => {
    try {
      return await inst.cdp.eval(`document.readyState === 'complete' && typeof window.FlashDrop === 'object'`);
    } catch { return false; }
  }, 30000, 250);
  await sleep(1000);
  return inst;
}

async function cleanup() {
  for (const i of instances) { try { await i.close(); } catch { /* noop */ } }
  await sleep(800);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  if (srvProc) { try { srvProc.kill(); } catch { /* noop */ } }
}

async function main() {
  if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome：' + CHROME); process.exit(2); }

  console.log('\n===== ICE 配置测试：P2P 有没有拿到 STUN =====\n');

  console.log('[1] 拉起服务与两个浏览器');
  await startServer();
  const A = await boot('A', 9741);
  const B = await boot('B', 9742);
  console.log('    完成\n');

  console.log('[2] 静态层：signaling 的默认 ICE 配置');
  const cfg = JSON.parse(await A.cdp.eval(`JSON.stringify({
    exported: (window.FlashDrop.constants && window.FlashDrop.constants.DEFAULT_ICE_SERVERS) || [],
    live: window.__fd.signaling.config.iceServers || [],
  })`));
  const urls = (list) => list.map((s) => (typeof s === 'string' ? s : s.urls)).join(' ');
  console.log('    导出常量：' + urls(cfg.exported));
  console.log('    实际生效：' + urls(cfg.live));

  check('默认配置里有 STUN', /stun:/.test(urls(cfg.live)), urls(cfg.live) || '（空）');
  check('含 Cloudflare STUN（国内可达 + 官方免费无限）',
    /stun\.cloudflare\.com/.test(urls(cfg.live)));
  check('signaling 实际生效值与导出常量一致',
    urls(cfg.live) === urls(cfg.exported));
  check('未配 TURN 时不含 turn: 候选（TURN 按流量计费，不能凭空出现）',
    !/turn:/.test(urls(cfg.live)));
  console.log('');

  console.log('[3] 运行时层：等两端互见并真实建连');
  const peers = await waitFor('两端互相发现', () => A.cdp.eval(`window.__fd.signaling.peers.size`), 30000)
    .catch((e) => { check('两端互相发现', false, e.message); return 0; });
  check('两台设备互相发现（同房间）', peers >= 1, `peers=${peers}`);

  // 等到有 Peer 真的把 RTCPeerConnection 建出来
  const seen = await waitFor('浏览器收到 ICE 配置', async () => {
    const n = await A.cdp.eval(`(window.__iceCfgs || []).length`);
    return n > 0 ? n : null;
  }, 30000).catch((e) => { check('浏览器收到 ICE 配置', false, e.message); return 0; });
  check('浏览器真的构造了 RTCPeerConnection', seen > 0, `记录了 ${seen} 次构造`);
  console.log('');

  console.log('[4] 关键断言：浏览器真实收到的 configuration');
  const at = Number(seen) || 1;
  const real = JSON.parse(await A.cdp.eval(`JSON.stringify(
    (window.__iceCfgs || []).slice(0, ${at}).map((c) => (c.iceServers || []).map((s) => s.urls || s).join(' '))
  )`));
  real.forEach((s, i) => console.log(`    #${i + 1}  ${s || '（空 —— 这就是 bug！）'}`));

  const allHaveStun = real.length > 0 && real.every((s) => /stun:stun\.cloudflare\.com/.test(s));
  check('每一次 P2P 建连都带着 Cloudflare STUN', allHaveStun,
    allHaveStun ? '' : '有连接拿不到 STUN → 跨网络时只能收集 host 候选，P2P 必然失败');
  check('没有任何一次建连是空配置', real.length > 0 && real.every((s) => s.trim().length > 0));
  check('运行时配置里没有 TURN（本地环境未注入凭证）',
    real.every((s) => !/turn:/.test(s)));
  console.log('');

  console.log('[5] 确认 STUN 确实被 ICE 用上了（收集到 srflx 候选）');
  const cands = await waitFor('ICE 收集候选', async () => {
    const v = await A.cdp.eval(`(() => {
      const p = [...window.__fd.signaling.peers.values()][0];
      if (!p || !p.transport || !p.transport.pc) return null;
      const pc = p.transport.pc;
      return JSON.stringify({
        kind: p.transport.kind,
        state: p.state,
        ice: pc.iceConnectionState,
      });
    })()`);
    return v && v !== 'null' ? JSON.parse(v) : null;
  }, 30000).catch(() => null);

  if (cands) {
    console.log('    ' + JSON.stringify(cands));
    check('P2P 传输层已建立', cands.kind === 'p2p' || cands.kind === 'relay',
      `kind=${cands.kind} state=${cands.state} ice=${cands.ice}`);
  } else {
    check('P2P 传输层已建立', false, '拿不到 transport');
  }
  console.log('');

  console.log('[6] 没配 TURN 时不该白跑 /turn-credentials');
  const turn = JSON.parse(await A.cdp.eval(`(async () => {
    const sg = window.__fd.signaling;
    const before = (window.__fetchedUrls || []).filter((u) => u.includes('turn-credentials')).length;
    const got = await sg.ensureTurnServers();       // 主动触发一次
    const after = (window.__fetchedUrls || []).filter((u) => u.includes('turn-credentials')).length;
    return JSON.stringify({
      advertised: sg.config.turnAvailable,
      returned: (got || []).length,
      before, after,
    });
  })()`));
  console.log('    ' + JSON.stringify(turn));
  check('服务端明确告知「本服务不签发 TURN 凭证」', turn.advertised === false,
    `turnAvailable=${turn.advertised}`);
  check('ensureTurnServers 直接返回空数组（不发请求）', turn.returned === 0);
  check('确实没有发出 /turn-credentials 请求（省掉一次 Worker + DO 请求额度）',
    turn.after === turn.before, `请求数 ${turn.before} → ${turn.after}`);
  console.log('');

  console.log('[7] 源码一致性：三份 ICE 列表不得漂移');  // 真正生效的是**服务端下发**的那一份（net.js:1701 的 this.config = msg.config），
  // 前端默认值只在信令连上之前的极短窗口里兜底。所以这三份必须一模一样，
  // 否则会出现"本地测试好好的、部署上去 P2P 全废"这种最难查的错位。
  const sources = [
    ['public/net.js', 'const DEFAULT_ICE_SERVERS ='],
    ['server.js', 'const DEFAULT_ICE ='],
    ['cloudflare/src/room.js', 'export const BASE_ICE ='],
  ];
  const found = sources.map(([rel, marker]) => {
    const list = readIceArray(path.join(ROOT, rel), marker);
    console.log(`    ${rel.padEnd(28)} ${list ? list.join(' ') : '（没抽到！）'}`);
    return { rel, list };
  });

  check('三份源码文件都能抽到 ICE 列表', found.every((f) => Array.isArray(f.list) && f.list.length));
  const ref = JSON.stringify(found[0].list);
  found.forEach((f) => {
    check(`${f.rel} 与 public/net.js 逐字一致`, JSON.stringify(f.list) === ref,
      JSON.stringify(f.list) === ref ? '' : '三份漂移 → 部署后行为会和本地测试不一致');
  });
  const allUrls = found.map((f) => (f.list || []).join(' ')).join(' ');
  check('没有任何一份使用 stun1.l.google.com（国内不通，纯拖慢 ICE）',
    !/stun1\.l\.google\.com/.test(allUrls));
  check('每一份都含 stun.cloudflare.com（国内可达 + 免费无限 + 不计 TURN 计费）',
    found.every((f) => (f.list || []).some((u) => u.includes('stun.cloudflare.com'))));
  console.log('');

  console.log('─'.repeat(56));
  console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
  console.log('─'.repeat(56) + '\n');
  return failed === 0 ? 0 : 1;
}

main()
  .then(async (code) => { await cleanup(); process.exit(code); })
  .catch(async (e) => {
    console.error('\n测试异常：' + (e && e.stack ? e.stack : e));
    await cleanup();
    process.exit(1);
  });
