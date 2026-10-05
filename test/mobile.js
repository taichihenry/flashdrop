/**
 * 移动端场景仿真：手机 ↔ 手机（同一个 Wi-Fi）
 * ---------------------------------------------------------------------------
 * 老板问的是「两台手机之间能不能传」。这个文件专门守两件事：
 *
 *  1) 同 Wi-Fi 下两台手机能不能互相发现
 *     —— 两台都是私网 IP，分房规则要落在同一间房，否则「同 Wi-Fi 却看不见」。
 *
 *  2) 手机端收不收得下文件
 *     —— iOS Safari / Firefox **没有 File System Access API**（`showDirectoryPicker`），
 *        只能走「全部攒内存 → 合成 Blob → a[download]」这条路。
 *        本测试把两台设备都降级到这条路上跑，验证内容是完整的。
 *        注意：这条路有内存天花板，大文件会崩 —— 详见文件末尾的说明。
 *
 * 跑法：node test/mobile.js
 * 前提：信令服务已启动。为避免和老板自己开着的页面串房间，请用独立端口：
 *   node run.js --port 18766
 *   BASE=http://127.0.0.1:18766 node test/mobile.js
 */

'use strict';

const fs = require('fs');
const { launch, waitFor, sleep, tempProfile, findChrome } = require('./lib');

const CHROME = findChrome();
const BASE = process.env.BASE || 'http://127.0.0.1:18766';

// 两台「手机」用不同的 UA：一台安卓、一台 iPhone。
// 服务端是拿 UA 推设备名的，UA 不同才能验证「双方各自显示成手机」。
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

// 页面加载前把 showDirectoryPicker 抹掉，等效 iOS Safari 等不支持该 API 的浏览器
const NO_FS_ACCESS = `
  try {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined, configurable: true, writable: true,
    });
  } catch (e) { /* 抹不掉就算了 */ }
`;

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? '  ' + detail : ''}`); }
}

const instances = [];
const tmpDirs = [];

async function cleanup() {
  for (const i of instances) { try { await i.close(); } catch { /* noop */ } }
  await sleep(800);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
}

/** 起一台"手机"：移动端视口 + 移动 UA + 禁用 File System Access API */
async function bootMobile(label, url, port, ua) {
  const profileDir = tempProfile(`fd-mob-${label}-`);
  tmpDirs.push(profileDir);
  const inst = await launch({
    label, url, port, profileDir, chrome: CHROME, headless: true,
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

/** 造一个确定性内容的 File，返回 {file 的 sha} 供两端比对 */
const MK_FILE_JS = `
  (name, mb, mime, seed) => {
    const size = Math.round(mb * 1024 * 1024);
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) buf[i] = (i * seed + 7) & 0xff;
    return new File([buf], name, { type: mime });
  }
`;

async function main() {
  if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome：' + CHROME); process.exit(2); }

  console.log('\n===== 移动端场景仿真：手机 ↔ 手机（同一个 Wi-Fi）=====');
  console.log(`  两台均访问：${BASE}`);
  console.log('  两台均为：移动端视口 + 移动 UA + 已禁用 File System Access API\n');

  console.log('[1] 两台手机接入');
  const a = await bootMobile('A', BASE, 9841, UA_ANDROID);
  const b = await bootMobile('B', BASE, 9842, UA_IPHONE);
  console.log('    完成\n');

  console.log('[2] 移动端环境探测');
  const envA = JSON.parse(await a.cdp.eval(`JSON.stringify({
    origin: location.origin, secure: window.isSecureContext,
    rtc: typeof window.RTCPeerConnection, subtle: typeof crypto.subtle,
    fsAccess: typeof window.showDirectoryPicker,
    device: (document.getElementById('btn-name') || {}).textContent || ''
  })`));
  console.log('    手机 A（安卓）：' + JSON.stringify(envA));
  check('手机 A：WebRTC 可用', envA.rtc === 'function');
  check('手机 A：安全上下文（WebRTC / crypto.subtle 的前提）', envA.secure === true);
  check('手机 A：已降级为「无 File System Access」（模拟 iOS Safari）',
    envA.fsAccess === 'undefined', `showDirectoryPicker=${envA.fsAccess}`);
  check('手机 A：服务端按 UA 识别为手机', /Android|iPhone|Mobile/i.test(envA.device), envA.device);

  const devB = await b.cdp.eval(`(document.getElementById('btn-name') || {}).textContent || ''`);
  check('手机 B：服务端按 UA 识别为手机', /iPhone|Android|Mobile/i.test(devB), devB);
  console.log('');

  console.log('[2b] 「只会崩页」的大文件有没有被拦在前面');
  // 不真的传 300MB，只验证判据：iPhone 上限 200MB，300MB 必须被判为有风险
  const risk = JSON.parse(await b.cdp.eval(`JSON.stringify({
    limitMB: Math.round(window.FlashDrop.memoryReceiveLimit() / 1024 / 1024),
    small: window.FlashDrop.memoryReceiveRisk(50 * 1024 * 1024).risky,
    huge: window.FlashDrop.memoryReceiveRisk(300 * 1024 * 1024).risky,
  })`));
  check('iPhone：识别出内存接收上限 200 MB', risk.limitMB === 200, `${risk.limitMB} MB`);
  check('iPhone：50 MB 判定为安全', risk.small === false);
  check('iPhone：300 MB 判定为有风险（会提示用户分批）', risk.huge === true);
  console.log('');

  console.log('[3] 关键断言：两台手机必须落进同一个房间（同 Wi-Fi 自动发现）');
  const roomA = await a.cdp.eval(`window.__fd.signaling.roomId || ''`);
  const roomB = await b.cdp.eval(`window.__fd.signaling.roomId || ''`);
  console.log(`    手机 A：${roomA}`);
  console.log(`    手机 B：${roomB}`);
  check('两台手机同房', !!roomA && roomA === roomB, roomA === roomB ? '' : '不同房 → 同 Wi-Fi 下会互相看不见');
  console.log('');

  console.log('[4] 互相发现');
  await waitFor('A 看到 B', () => a.cdp.eval(`window.__fd.signaling.peers.size`), 25000)
    .then(async (n) => {
      const names = await a.cdp.eval(`JSON.stringify([...window.__fd.signaling.peers.values()].map(p => p.name))`);
      check('手机 A 看到手机 B', n === 1, `peers=${n} ${names}${n > 1 ? '  ⚠ 房间里多出设备 —— 多半是你自己的浏览器也开着这个页面' : ''}`);
    })
    .catch((e) => check('手机 A 看到手机 B', false, e.message));
  await waitFor('B 看到 A', () => b.cdp.eval(`window.__fd.signaling.peers.size`), 25000)
    .then((n) => check('手机 B 看到手机 A', n === 1, `peers=${n}`))
    .catch((e) => check('手机 B 看到手机 A', false, e.message));
  console.log('');

  console.log('[5] 传输通道');
  const st = await waitFor('通道就绪', () => a.cdp.eval(`(() => {
    const p = [...window.__fd.signaling.peers.values()][0];
    return p && (p.state === 'connected' || p.state === 'relay') ? p.state + '|' + p.transport.kind : null;
  })()`), 25000).catch((e) => { check('通道就绪', false, e.message); return null; });
  if (st) {
    const [state, kind] = String(st).split('|');
    check('两台手机之间走 P2P 直连（数据不经服务器）', kind === 'p2p', `state=${state} transport=${kind}`);
  }
  console.log('');

  console.log('[6] 手机 A → 手机 B：文字');
  const MARK = 'hi-from-A-' + Date.now();
  await a.cdp.eval(`(() => {
    const p = [...window.__fd.signaling.peers.values()][0];
    p.sendText(${JSON.stringify(MARK)});
  })()`);
  // 直接看界面有没有冒出文字气泡 —— 这比订阅内部事件更贴近用户的真实感知
  await waitFor('B 显示文字气泡', () =>
    b.cdp.eval(`[...document.querySelectorAll('.text-bubble')].some(e => e.textContent.includes(${JSON.stringify(MARK)}))`), 15000)
    .then((ok) => check('手机 B 收到手机 A 的文字', ok === true))
    .catch((e) => check('手机 B 收到文字', false, e.message));
  console.log('');

  console.log('[7] 手机 A → 手机 B：3 个文件（含中文名，约 8 MB）');
  await b.cdp.eval(`window.__files = []; window.__flashdropOnFile = (f) => window.__files.push(f);`);
  const wantSha = await a.cdp.eval(`(async () => {
    const mk = ${MK_FILE_JS};
    const files = [
      mk('手机拍的截图.png', 4, 'image/png', 41),
      mk('行程单.pdf', 3, 'application/pdf', 67),
      mk('语音备忘.m4a', 1, 'audio/mp4', 89),
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

  await waitFor('B 弹出接收确认', () => b.cdp.eval(`!document.getElementById('modal-receive').hidden`), 25000)
    .then(() => check('手机 B 弹出接收确认框', true))
    .catch((e) => check('手机 B 弹出接收确认框', false, e.message));
  console.log('    确认框：' + await b.cdp.eval(`document.getElementById('receive-total').textContent`));
  // 小文件不必打扰用户：8 MB 不该弹任何接收能力提示（大文件的提示见 [8]）
  const hintText = String(await b.cdp.eval(`(() => { const h = document.getElementById('receive-hint'); return h.hidden ? '' : h.textContent; })()`)).trim();
  check('小文件不弹提示（界面保持干净）', hintText === '',
    hintText ? '意外显示了：' + hintText.slice(0, 40) : '');

  // 记录 B 侧的接收方式：内存 or 落盘
  await b.cdp.eval(`document.getElementById('btn-accept').click()`);
  await sleep(400);   // onclick 是 async，等 acceptIncoming 落定再读
  const streamed = await b.cdp.eval(`!!(window.__fd && window.__fd.signaling._incoming && window.__fd.signaling._incoming.dirHandle)`);
  check('手机 B 走「内存接收」（无 File System Access 时的必然路径）', streamed === false,
    streamed ? '竟然拿到了目录句柄' : '已确认降级路径生效');

  const recv = await waitFor('B 收完 3 个文件', async () => {
    if (await b.cdp.eval(`window.__files.length`) < 3) return null;
    return b.cdp.eval(`(async () => {
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
    check('接收方式标记为 memory', parts.every((p) => p[1] === 'memory'),
      parts.map((p) => `${p[0]}=${p[1]}`).join(' '));
    console.log('    收到：' + parts.map((p) => p[0]).join('、'));
  }
  check('发送侧正常收尾', (await a.cdp.eval(`window.__sendDone`)) === 'ok');
  console.log('');

  // 70 MB 同时干两件事：测吞吐 + 验证「大文件走内存接收」的提示会不会如实出现
  const BIG_MB = 70;
  console.log(`[8] 反向：手机 B → 手机 A：${BIG_MB} MB 单文件（测吞吐 + 大文件提示）`);
  await a.cdp.eval(`window.__files = []; window.__flashdropOnFile = (f) => window.__files.push(f);`);
  const bigSha = await b.cdp.eval(`(async () => {
    const SIZE = ${BIG_MB} * 1024 * 1024;
    const buf = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) buf[i] = (i * 211 + 13) & 0xff;
    const file = new File([buf], 'm2m-big.bin', { type: 'application/octet-stream' });
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
      .map(x => x.toString(16).padStart(2, '0')).join('');
    const p = [...window.__fd.signaling.peers.values()][0];
    p.sendFiles([file]).catch(() => {});
    return sha;
  })()`);

  await waitFor('A 弹出接收确认', () => a.cdp.eval(`!document.getElementById('modal-receive').hidden`), 25000)
    .catch((e) => check('手机 A 弹出接收确认框', false, e.message));

  const bigHint = String(await a.cdp.eval(`(() => { const h = document.getElementById('receive-hint'); return h.hidden ? '' : h.textContent; })()`)).trim();
  check('大文件：手机 A 看到「暂存内存、别切走」的提示',
    /暂存在内存/.test(bigHint) && !bigHint.includes('⚠'),
    bigHint ? bigHint.slice(0, 40) + '…' : '（没显示提示）');

  await a.cdp.eval(`document.getElementById('btn-accept').click()`);
  await sleep(150);
  // 计时口径：从「对方点下接受、数据真正开始流动」起算，
  // 不含用户盯着确认框发呆的时间。
  await a.cdp.eval(`window.__t0 = Date.now()`);

  const gotBig = await waitFor(`A 收完 ${BIG_MB} MB`, async () => {
    if (!(await a.cdp.eval(`window.__files.length`))) return null;
    return a.cdp.eval(`(async () => {
      const buf = await window.__files[0].blob.arrayBuffer();
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
        .map(x => x.toString(16).padStart(2, '0')).join('');
      return sha + '|' + (Date.now() - window.__t0);
    })()`);
  }, 180000).catch((e) => { check(`A 收完 ${BIG_MB} MB`, false, e.message); return null; });

  if (gotBig) {
    const [sha, ms] = String(gotBig).split('|');
    const mbps = (BIG_MB / (Number(ms) / 1000)).toFixed(2);
    check(`${BIG_MB} MB 在「纯内存接收」下也完整送达`, sha === bigSha, `${mbps} MB/s`);
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
