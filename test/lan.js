/**
 * 局域网真机场景仿真：电脑 ↔ 手机（同一个 Wi-Fi）
 * ---------------------------------------------------------------------------
 * 这是最贴近老板实际用法的测试，也是之前被漏掉的那个场景：
 *   · 电脑开的是 http://127.0.0.1:8686   （loopback）
 *   · 手机开的是 https://192.168.1.5:8687 （局域网 IP + 自签证书）
 * 两者源 IP 不同，如果分房规则不把 loopback 归入本机局域网，就会
 * 「明明同一个 Wi-Fi 却互相看不见」。这条断言就是专门守住它的。
 *
 * 跑法：node test/lan.js
 *   LAN_IP=192.168.1.5 node test/lan.js
 * 前提：服务已启动（node run.js）
 */

'use strict';

const fs = require('fs');
const { launch, waitFor, sleep, tempProfile, findChrome } = require('./lib');

const CHROME = findChrome();
const LAN_IP = process.env.LAN_IP || '192.168.1.5';
const PC_URL = process.env.PC_URL || 'http://127.0.0.1:8686';
const PHONE_URL = process.env.PHONE_URL || `https://${LAN_IP}:8687`;
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';

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

/**
 * 起一台浏览器。手机那台额外做两件事，让它真的像手机：
 *   1. 用移动端视口
 *   2. 换掉 UA 再重载页面（服务端是拿 UA 推断设备名的）
 */
async function boot(label, url, port, opts = {}) {
  const profileDir = tempProfile(`fd-lan-${label}-`);
  tmpDirs.push(profileDir);
  const inst = await launch({
    label, url, port, profileDir, chrome: CHROME, headless: true,
    width: opts.mobile ? 390 : 1200,
    height: opts.mobile ? 844 : 900,
  });
  instances.push(inst);

  if (opts.mobile) {
    await inst.cdp.send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA });
    await inst.cdp.send('Page.reload');
    await waitFor(`${label} 重载完成`, async () => {
      try { return await inst.cdp.eval(`document.readyState === 'complete' && typeof window.FlashDrop === 'object'`); }
      catch { return false; }
    }, 25000, 250);
    await sleep(1200);
  }
  return inst;
}

async function main() {
  if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome：' + CHROME); process.exit(2); }

  console.log('\n===== 局域网真机场景仿真（同一个 Wi-Fi）=====');
  console.log(`  电脑：${PC_URL}`);
  console.log(`  手机：${PHONE_URL}（移动端视口 + Android UA）\n`);

  console.log('[1] 两端接入');
  const pc = await boot('pc', PC_URL, 9811);
  const phone = await boot('phone', PHONE_URL, 9812, { mobile: true });
  console.log('    完成\n');

  console.log('[2] 环境与设备识别');
  const env = JSON.parse(await phone.cdp.eval(`JSON.stringify({
    origin: location.origin,
    secure: window.isSecureContext,
    rtc: typeof window.RTCPeerConnection,
    device: document.getElementById('btn-name') ? document.getElementById('btn-name').textContent.trim() : ''
  })`));
  console.log('    手机侧：' + JSON.stringify(env));
  check('手机侧 WebRTC 可用', env.rtc === 'function');
  check('手机侧走 HTTPS（安全上下文）', env.secure === true, `isSecureContext=${env.secure}`);
  check('服务端已按 UA 识别为安卓设备', /Android/i.test(env.device), env.device || '（未取到）');

  // crypto.subtle 和 RTCPeerConnection 的规则**不一样**：前者在非安全上下文下直接不存在，
  // 后者只是被标记为不安全但依然可用。所以拿 http://<局域网IP> 跑测试时，
  // 传输能通但 SHA-256 算不了 —— 这里提前说清楚，别让它以崩溃的形式表达。
  const pcEnv = JSON.parse(await pc.cdp.eval(`JSON.stringify({
    origin: location.origin, secure: window.isSecureContext, subtle: typeof crypto.subtle
  })`));
  check('电脑侧是安全上下文（否则算不了 SHA-256）', pcEnv.secure === true,
    `${pcEnv.origin}  subtle=${pcEnv.subtle}`);
  if (pcEnv.secure !== true) {
    console.log('\n  ⚠ 电脑端用的不是安全上下文，crypto.subtle 不存在，无法校验 SHA-256。');
    console.log('    请改用 http://127.0.0.1:8686 或 https://<LAN_IP>:8687 再跑。\n');
    return 3;
  }
  console.log('');

  console.log('[3] 关键断言：两端必须落进同一个局域网房间');
  const roomPc = await pc.cdp.eval(`window.__fd.signaling.roomId || ''`);
  const roomPh = await phone.cdp.eval(`window.__fd.signaling.roomId || ''`);
  console.log(`    电脑：${roomPc}`);
  console.log(`    手机：${roomPh}`);
  check('两端房间一致（loopback 已归入本机局域网）', !!roomPc && roomPc === roomPh,
    roomPc === roomPh ? '' : '不同房 → 同 WiFi 下会互相看不见');
  console.log('');

  console.log('[4] 互相发现');
  await waitFor('电脑看到手机', () => pc.cdp.eval(`window.__fd.signaling.peers.size`), 25000)
    .then((n) => check('电脑看到手机', n === 1, `peers=${n}${n > 1 ? '  ⚠ 房间里多出设备了 —— 多半是你自己的浏览器也开着这个页面，把它关掉再跑' : ''}`))
    .catch((e) => check('电脑看到手机', false, e.message));
  await waitFor('手机看到电脑', () => phone.cdp.eval(`window.__fd.signaling.peers.size`), 25000)
    .then((n) => check('手机看到电脑', n === 1, `peers=${n}${n > 1 ? '  ⚠ 同上的环境污染' : ''}`))
    .catch((e) => check('手机看到电脑', false, e.message));
  console.log('');

  console.log('[5] 传输通道');
  const st = await waitFor('通道就绪', () => pc.cdp.eval(`(() => {
    const p = [...window.__fd.signaling.peers.values()][0];
    return p && (p.state === 'connected' || p.state === 'relay') ? p.state + '|' + p.transport.kind : null;
  })()`), 25000).catch((e) => { check('通道就绪', false, e.message); return null; });
  if (st) {
    const [state, kind] = String(st).split('|');
    check('同 WiFi 下走 P2P 直连（不经服务器）', kind === 'p2p', `state=${state} transport=${kind}`);
  }
  console.log('');

  console.log('[6] 手机 → 电脑：3 个文件（含中文名，共约 14 MB）');
  await pc.cdp.eval(`window.__files = []; window.__flashdropOnFile = (f) => window.__files.push(f);`);
  const sendSha = await phone.cdp.eval(`(async () => {
    const mk = (name, mb, mime, seed) => {
      const size = Math.round(mb * 1024 * 1024);
      const buf = new Uint8Array(size);
      for (let i = 0; i < size; i++) buf[i] = (i * seed + 7) & 0xff;
      return new File([buf], name, { type: mime });
    };
    const files = [
      mk('假期照片原图.jpg', 6, 'image/jpeg', 31),
      mk('会议纪要.pdf', 5, 'application/pdf', 53),
      mk('素材包.zip', 3, 'application/zip', 97),
    ];
    const shas = [];
    for (const f of files) {
      const b = await f.arrayBuffer();
      shas.push([...new Uint8Array(await crypto.subtle.digest('SHA-256', b))]
        .map(x => x.toString(16).padStart(2, '0')).join(''));
    }
    window.__want = shas;
    window.__sendDone = 'pending';
    const p = [...window.__fd.signaling.peers.values()][0];
    p.sendFiles(files).then(() => { window.__sendDone = 'ok'; })
      .catch((e) => { window.__sendDone = 'err: ' + e.message; });
    return shas.join(',');
  })()`);

  await waitFor('电脑弹出接收确认', () =>
    pc.cdp.eval(`!document.getElementById('modal-receive').hidden`), 25000)
    .then(() => check('电脑弹出接收确认框', true))
    .catch((e) => check('电脑弹出接收确认框', false, e.message));
  console.log('    确认框：' + await pc.cdp.eval(`document.getElementById('receive-total').textContent`));

  // 发送侧（手机）诊断：确认框没弹时，问题一定在发送侧，先把状态掏出来
  console.log('    手机侧诊断：' + await phone.cdp.eval(`(() => {
    const p = [...window.__fd.signaling.peers.values()][0];
    return JSON.stringify({
      sendDone: window.__sendDone,
      state: p && p.state,
      kind: p && p.transport && p.transport.kind,
      isOpen: !!(p && p.transport && p.transport.isOpen && p.transport.isOpen()),
      pendingText: (p && p._pendingText && p._pendingText.length) || 0,
      turnTried: p && p._turnTried,
      turnExhausted: window.__fd.signaling.turnExhausted,
      peers: window.__fd.signaling.peers.size,
    });
  })()`));

  await pc.cdp.eval(`document.getElementById('btn-accept').click()`);

  const recv = await waitFor('电脑收完 3 个文件', async () => {
    if (await pc.cdp.eval(`window.__files.length`) < 3) return null;
    return pc.cdp.eval(`(async () => {
      const out = [];
      for (const f of window.__files) {
        const b = await f.blob.arrayBuffer();
        out.push(f.name + ':' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))]
          .map(x => x.toString(16).padStart(2, '0')).join(''));
      }
      return out.join('|');
    })()`);
  }, 120000).catch((e) => { check('电脑收完 3 个文件', false, e.message); return null; });

  if (recv) {
    const got = recv.split('|').map((s) => s.split(':')[1]);
    const want = String(sendSha).split(',');
    check('3 个文件全部收到且内容一致（SHA-256）',
      got.length === 3 && got.every((h, i) => h === want[i]),
      got.length === 3 ? '中文名与内容均正确' : `只收到 ${got.length} 个`);
    console.log('    收到：' + recv.split('|').map((s) => s.split(':')[0]).join('、'));
  }
  check('发送侧正常收尾', (await phone.cdp.eval(`window.__sendDone`)) === 'ok');
  console.log('');

  console.log('[7] 电脑 → 手机：12 MB 单文件（测吞吐）');
  await phone.cdp.eval(`window.__files = []; window.__flashdropOnFile = (f) => window.__files.push(f);`);
  const bigSha = await pc.cdp.eval(`(async () => {
    const SIZE = 12 * 1024 * 1024;
    const buf = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) buf[i] = (i * 179 + 23) & 0xff;
    const file = new File([buf], 'lan-12mb.bin', { type: 'application/octet-stream' });
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
      .map(x => x.toString(16).padStart(2, '0')).join('');
    window.__t0 = Date.now();
    const p = [...window.__fd.signaling.peers.values()][0];
    p.sendFiles([file]).catch(() => {});
    return sha;
  })()`);

  await waitFor('手机弹出接收确认', () =>
    phone.cdp.eval(`!document.getElementById('modal-receive').hidden`), 25000)
    .catch((e) => check('手机弹出接收确认框', false, e.message));
  await phone.cdp.eval(`document.getElementById('btn-accept').click()`);
  // 计时口径：从「对方点下接受、数据真正开始流动」起算。
  // 若把等待点按钮的时间也算进去，slow 的就成了测试脚本而不是传输本身。
  await sleep(150);
  await pc.cdp.eval(`window.__t0 = Date.now()`);

  const gotBig = await waitFor('手机收完 12 MB', async () => {
    if (!(await phone.cdp.eval(`window.__files.length`))) return null;
    return phone.cdp.eval(`(async () => {
      const b = await window.__files[0].blob.arrayBuffer();
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))]
        .map(x => x.toString(16).padStart(2, '0')).join('');
      return JSON.stringify({ sha, size: window.__files[0].blob.size, saved: window.__files[0].saved });
    })()`);
  }, 120000).catch((e) => { check('手机收完 12 MB', false, e.message); return null; });

  if (gotBig) {
    const r = JSON.parse(gotBig);
    const secs = (await pc.cdp.eval(`Date.now()`) - await pc.cdp.eval(`window.__t0`)) / 1000;
    check('12 MB 内容一致（SHA-256）', r.sha === bigSha);
    check('字节数正确', r.size === 12 * 1024 * 1024, `${r.size} B`);
    console.log(`    耗时约 ${secs.toFixed(1)} s，平均 ${(12 / Math.max(secs, 0.1)).toFixed(1)} MB/s（手机端落到 ${r.saved}）`);
  }
  console.log('');

  console.log('[8] 文字：手机 → 电脑');
  const txt = '局域网测试 ' + Math.random().toString(36).slice(2, 7);
  await phone.cdp.eval(`(() => {
    const c = document.querySelector('.peer'); if (c) c.click();
    return true;
  })()`);
  await sleep(400);
  await phone.cdp.eval(`(() => {
    document.getElementById('text-input').value = ${JSON.stringify(txt)};
    document.getElementById('btn-send-text').click();
    return true;
  })()`);
  const gotText = await waitFor('电脑收到文字', () => pc.cdp.eval(`(() => {
    const b = document.querySelector('.text-bubble');
    return b && b.textContent.includes(${JSON.stringify(txt)}) ? b.textContent : null;
  })()`), 20000).catch(() => null);
  check('文字送达且界面已显示', gotText === txt);
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
