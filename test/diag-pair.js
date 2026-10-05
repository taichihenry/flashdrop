/**
 * FlashDrop · 同机双浏览器互传诊断
 * ---------------------------------------------------------------------------
 * 和 e2e.js 的关键区别：**指名道姓地传**。
 *
 * e2e.js 里是 `[...peers.values()][0]` —— 取房间里的第一个设备。这在"房间里
 * 只有两台设备"时没问题，可一旦房间里有第三台（比如用户自己开着的浏览器、
 * 上一轮测试的残留），它就会把消息发给**别人**，然后断言失败，看起来像产品坏了。
 *
 * 这个脚本的做法是先给两个实例各自改名（DiagA / DiagB），再按名字精确选中，
 * 顺手把「房间里到底有谁」「连接是 P2P 还是中继」「ICE 用了哪类候选」都打出来。
 *
 * 跑法：
 *   node test/diag-pair.js                          # 默认打线上
 *   node test/diag-pair.js https://xxx.example.com  # 指定站点
 *   HEADFUL=1 node test/diag-pair.js                # 有界面（能肉眼看）
 */

'use strict';

const fs = require('fs');
const { launch, waitFor, sleep, tempProfile, findChrome } = require('./lib');

const CHROME = findChrome();
const BASE = process.argv[2] || process.env.BASE || 'https://6.xn--fiqs8s';
const HEADLESS = process.env.HEADFUL !== '1';

const procs = [];
const cdps = [];
const instances = [];
const tmpDirs = [];

/** 额外浏览器参数，用环境变量传（例如 CHROME_ARGS="--disable-ipv6"） */
const EXTRA_ARGS = (process.env.CHROME_ARGS || '').split(/\s+/).filter(Boolean);

async function boot(label, port) {
  const profileDir = tempProfile(`fd-diag-${label}-`);
  tmpDirs.push(profileDir);
  const inst = await launch({
    label, url: BASE, port, profileDir, headless: HEADLESS, chrome: CHROME,
    extraArgs: EXTRA_ARGS,
  });
  procs.push(inst.proc);
  cdps.push(inst.cdp);
  instances.push(inst);
  // launch 只等 DOM 就绪，app.js 的初始化（挂 window.__fd）还要再晚一点
  await waitFor(`${label} 前端初始化`, () => inst.cdp.eval('!!window.__fd'), 25000);
  // 关键：等它真正进了房间再改名。否则改名广播会发生在入房之前，
  // 对端join 时看到的就是旧名字，会误判成"互相看不见"。
  await waitFor(`${label} 进入房间`, () => inst.cdp.eval('window.__fd.signaling.roomId || null'), 25000);
  return inst;
}

async function cleanup() {
  for (const c of cdps) {
    try { await c.eval('window.__fd && window.__fd.signaling.close()'); } catch { /* noop */ }
  }
  await sleep(600);
  for (const c of cdps) c.close();
  await Promise.all(instances.map((i) => i.close().catch(() => {})));
  await sleep(1200);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
}

/* ------------------------------ 页面内取值 ------------------------------ */

const JS_DUMP = `JSON.stringify({
  self: window.__fd.signaling.selfId,
  room: window.__fd.signaling.roomType + ' / ' + window.__fd.signaling.roomId,
  addr: window.__fd.signaling._probedAddr || null,
  code: window.__fd.signaling.roomCode || null,
  ws: window.__fd.signaling.ws ? window.__fd.signaling.ws.readyState : null,
  peers: [...window.__fd.signaling.peers.values()].map(p =>
    p.name + ' [' + p.state + (p.transport ? '/' + p.transport.kind : '') + ']')
})`;

const jsFindPeer = (name) => `(() => {
  const p = [...window.__fd.signaling.peers.values()].find(x => x.name === ${JSON.stringify(name)});
  return p ? p.id : null;
})()`;

/** 按显示名找设备卡片并点击（走完整的界面路径）
 *  设备只有一台时界面会自动选中它，这时再点一下就成了"取消选中"，
 *  所以这里先看是否已经选中，避免把选择给点掉了。 */
const jsClickCard = (name) => `(() => {
  const cards = [...document.querySelectorAll('.peer')];
  const hit = cards.find(c => (c.querySelector('.peer-name') || {}).textContent === ${JSON.stringify(name)});
  if (!hit) return 'card-not-found';
  if (hit.classList.contains('selected')) return 'already-selected';
  hit.click();
  return 'clicked';
})()`;

/** 选中后返回该 peer 的连接状态 + ICE 候选类型分布 */
const jsPeerStats = (name) => `(async () => {
  const p = [...window.__fd.signaling.peers.values()].find(x => x.name === ${JSON.stringify(name)});
  if (!p) return JSON.stringify({ found: false });
  const out = { found: true, state: p.state, kind: p.transport ? p.transport.kind : null };
  const pc = p.transport && p.transport.pc;
  if (!pc || typeof pc.getStats !== 'function') {
    out.ice = p.transport && p.transport.kind === 'relay' ? 'ws-relay(无 PeerConnection)' : 'n/a';
    return JSON.stringify(out);
  }
  const stats = await pc.getStats();
  const local = {}, pairs = [];
  let selected = null;
  stats.forEach((s) => {
    if (s.type === 'local-candidate') local[s.candidateType] = (local[s.candidateType] || 0) + 1;
    if (s.type === 'candidate-pair' && s.state === 'succeeded') pairs.push(s);
  });
  for (const pr of pairs) if (pr.nominated) selected = pr;
  if (selected) {
    const lc = stats.get(selected.localCandidateId);
    const rc = stats.get(selected.remoteCandidateId);
    out.selected = (lc ? lc.candidateType : '?') + ' ⇄ ' + (rc ? rc.candidateType : '?');
    out.protocol = lc && lc.protocol;
  }
  out.localCandidates = local;
  out.iceConnectionState = pc.iceConnectionState;
  out.connectionState = pc.connectionState;
  return JSON.stringify(out);
})()`;

/* -------------------------------- 主流程 -------------------------------- */

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error(`找不到浏览器：${CHROME}`);
    process.exit(2);
  }

  console.log('\n===== FlashDrop 同机双浏览器互传诊断 =====');
  console.log(`  浏览器：${CHROME}`);
  console.log(`  目标  ：${BASE}`);
  console.log(`  模式  ：${HEADLESS ? 'headless' : '有界面'}\n`);

  console.log('[1] 启动两个互相隔离的浏览器实例');
  const A = await boot('A', 9421);
  const B = await boot('B', 9422);
  console.log('    完成\n');

  console.log('[2] 改名，便于点名互传');
  await A.cdp.eval(`window.__fd.signaling.rename('DiagA')`);
  await B.cdp.eval(`window.__fd.signaling.rename('DiagB')`);
  await sleep(1200);
  console.log('    ' + await A.cdp.eval(JS_DUMP));
  console.log('    ' + await B.cdp.eval(JS_DUMP));
  console.log('');

  console.log('[3] 等两端互相看见');
  let ok = true;
  await waitFor('A 看见 DiagB', () => A.cdp.eval(jsFindPeer('DiagB')), 40000)
    .then(() => console.log('    ✅ A 看见 DiagB'))
    .catch((e) => { ok = false; console.log('    ❌ ' + e.message); });
  await waitFor('B 看见 DiagA', () => B.cdp.eval(jsFindPeer('DiagA')), 40000)
    .then(() => console.log('    ✅ B 看见 DiagA'))
    .catch((e) => { ok = false; console.log('    ❌ ' + e.message); });

  if (!ok) {
    console.log('\n    房间成员如下，先看是不是分到了不同房间：');
    console.log('    A: ' + await A.cdp.eval(JS_DUMP));
    console.log('    B: ' + await B.cdp.eval(JS_DUMP));
    await cleanup();
    process.exit(1);
  }
  console.log('');

  console.log('[4] 等 A↔B 之间的通道就绪（最多 20 秒，含 TURN 补挂那一轮）');
  const st = await waitFor('A↔B 通道', async () => {
    const s = JSON.parse(await A.cdp.eval(jsPeerStats('DiagB')));
    return (s.state === 'connected' || s.state === 'relay') ? s : null;
  }, 20000).catch((e) => { console.log('    ❌ ' + e.message); return null; });

  if (st) console.log('    A 侧看到：' + JSON.stringify(st));
  console.log('');

  console.log('[5] 文字 DiagA → DiagB（点卡片 + 填输入框 + 点发送）');
  console.log('    点卡片：' + await A.cdp.eval(jsClickCard('DiagB')));
  await sleep(500);

  const text = 'diag-' + Math.random().toString(36).slice(2, 8);
  await A.cdp.eval(`(() => {
    document.getElementById('text-input').value = ${JSON.stringify(text)};
    document.getElementById('btn-send-text').click();
    return true;
  })()`);

  const got = await waitFor('B 收到文字', () =>
    B.cdp.eval(`(() => {
      const b = document.querySelector('.text-bubble');
      return b && b.textContent.includes(${JSON.stringify(text)}) ? b.textContent : null;
    })()`), 25000).catch(() => null);
  console.log(got ? `    ✅ B 界面上出现了：${got}` : '    ❌ B 没收到');
  console.log('');

  console.log('[6] 文件 DiagA → DiagB（2 MB，校验 SHA-256）');
  console.log('    发送前 A：' + await A.cdp.eval(JS_DUMP));
  console.log('    发送前 B：' + await B.cdp.eval(JS_DUMP));
  await B.cdp.eval(`window.__files = [];
    window.__flashdropOnFile = (f) => { window.__files.push(f); };`);

  const wantSha = await A.cdp.eval(`(async () => {
    const SIZE = 2 * 1024 * 1024;
    const buf = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) buf[i] = (i * 13 + 5) & 0xff;
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const p = [...window.__fd.signaling.peers.values()].find(x => x.name === 'DiagB');
    window.__sendDone = 'pending';
    p.sendFiles([new File([buf], 'diag-2mb.bin', { type: 'application/octet-stream' })])
      .then(() => { window.__sendDone = 'ok'; })
      .catch((e) => { window.__sendDone = 'err: ' + e.message; });
    return sha;
  })()`);

  await waitFor('B 弹接收确认', () => B.cdp.eval(`!document.getElementById('modal-receive').hidden`), 25000)
    .then(() => console.log('    ✅ B 弹出接收确认框'))
    .catch(() => console.log('    ❌ B 没弹接收确认框'));
  await B.cdp.eval(`document.getElementById('btn-accept').click()`);

  const gotSha = await waitFor('B 收完文件', async () => {
    if (!(await B.cdp.eval(`window.__files.length`))) return null;
    return B.cdp.eval(`(async () => {
      const buf = await window.__files[0].blob.arrayBuffer();
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
        .map(b => b.toString(16).padStart(2, '0')).join('');
    })()`);
  }, 60000).catch(() => null);

  console.log(gotSha
    ? (gotSha === wantSha ? '    ✅ 文件完整送达，SHA-256 一致' : `    ❌ 内容不一致\n       发送 ${wantSha}\n       接收 ${gotSha}`)
    : '    ❌ 文件没收到');
  console.log('    A 侧发送收尾：' + await A.cdp.eval('window.__sendDone'));
  console.log('');

  console.log('[7] 最终连接方式');
  console.log('    A 侧：' + await A.cdp.eval(jsPeerStats('DiagB')));
  console.log('    B 侧：' + await B.cdp.eval(jsPeerStats('DiagA')));
  console.log('    A 房间：' + await A.cdp.eval(JS_DUMP));
  console.log('    B 房间：' + await B.cdp.eval(JS_DUMP));
  console.log('');

  await cleanup();
}

main().catch(async (e) => {
  console.error('\n诊断脚本异常：' + (e && e.stack ? e.stack : e));
  await cleanup().catch(() => {});
  process.exit(1);
});
