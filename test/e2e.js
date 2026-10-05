/**
 * FlashDrop 端到端自测
 * ---------------------------------------------------------------------------
 * 用真实 Chrome 起两个独立实例（各自独立的用户数据目录 = 两个互不相关的浏览器），
 * 让它们连上同一个 FlashDrop 服务，然后验证：
 *   1. 环境被识别为安全上下文，WebRTC 可用
 *   2. 两端能自动互相发现
 *   3. 走的是 P2P 直传，而不是服务器中继
 *   4. A→B 发文字，B 界面上真的出现
 *   5. A→B 发 3 MB、B→A 发 1 MB，双向都能通，且 SHA-256 与原始数据一致
 *   6. 流式落盘分支：分片写入顺序正确、字节数正确、句柄正确关闭
 *
 * 跑法：
 *   node test/e2e.js
 *   CHROME="C:/path/to/chrome.exe" BASE=http://127.0.0.1:8686 node test/e2e.js
 *   TEST_INSECURE=http://192.168.1.5:8686 node test/e2e.js   # 附带探测非安全上下文
 *
 * 前提：FlashDrop 服务已在运行。
 */

'use strict';

const fs = require('fs');
const { launch, waitFor, sleep, tempProfile, findChrome, killTree } = require('./lib');

const CHROME = findChrome();
const BASE = process.env.BASE || 'http://127.0.0.1:8686';
const HEADLESS = process.env.HEADFUL !== '1';

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? '  ' + detail : ''}`); }
}

/* ============================== 主流程 ============================== */

const procs = [];
const cdps = [];
const instances = [];
const tmpDirs = [];

async function cleanup() {
  // 第一步：让页面自己断开 WebSocket。服务端收到 close 就立刻把设备移出房间，
  // 这是清场最可靠的一环 —— 只靠杀进程的话，TCP 连接不保证及时释放，
  // 下一轮测试就会看到"幽灵设备"（房间里有上一轮的残骸），非常难查。
  for (const c of cdps) {
    try { await c.eval('window.__fd && window.__fd.signaling.close()'); } catch { /* 忽略 */ }
  }
  await sleep(500);

  // 第二步：关调试连接
  for (const c of cdps) c.close();

  // 第三步：让浏览器自己退出（必须走 CDP 的 Browser.close，
  // 因为 spawn 出来的进程是"启动器即退"，proc.pid 早就失效了）
  await Promise.all(instances.map((i) => i.close()));
  await sleep(1200);

  // 第四步：兜底再按 pid 杀一遍，聊胜于无
  await Promise.all(procs.map((p) => killTree(p)));

  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
}

async function boot(label, url, port) {
  const profileDir = tempProfile(`fd-e2e-${label}-`);
  tmpDirs.push(profileDir);
  const inst = await launch({ label, url, port, profileDir, headless: HEADLESS, chrome: CHROME });
  procs.push(inst.proc);
  cdps.push(inst.cdp);
  instances.push(inst);
  return inst;
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error(`找不到 Chrome：${CHROME}\n用 CHROME=... 指定路径。`);
    process.exit(2);
  }

  console.log('\n===== FlashDrop 端到端自测 =====');
  console.log(`  浏览器：${CHROME}`);
  console.log(`  目标  ：${BASE}`);
  console.log(`  模式  ：${HEADLESS ? 'headless' : '有界面'}\n`);

  console.log('[1] 启动两个独立浏览器实例');
  const A = await boot('A', BASE, 9411);
  const B = await boot('B', BASE, 9412);
  console.log('    完成\n');

  console.log('[2] 检查运行环境');
  const env = JSON.parse(await A.cdp.eval(`JSON.stringify({
    secure: window.isSecureContext,
    rtc: typeof window.RTCPeerConnection,
    hasLib: typeof window.FlashDrop === 'object',
    hasQr: typeof window.qrcode === 'function',
    hasApp: !!window.__fd
  })`));
  check('安全上下文', env.secure === true, `isSecureContext=${env.secure}`);
  check('RTCPeerConnection 可用', env.rtc === 'function');
  check('net.js 已加载', env.hasLib === true);
  check('二维码库已加载', env.hasQr === true);
  check('app.js 已初始化', env.hasApp === true);
  console.log('');

  console.log('[3] 等待两端互相发现（LAN 房间自动配对）');
  await waitFor('A 发现对端', () => A.cdp.eval(`window.__fd.signaling.peers.size`), 25000)
    .then((n) => check('A 发现设备', n >= 1, `peers=${n}`))
    .catch((e) => check('A 发现设备', false, e.message));
  await waitFor('B 发现对端', () => B.cdp.eval(`window.__fd.signaling.peers.size`), 25000)
    .then((n) => check('B 发现设备', n >= 1, `peers=${n}`))
    .catch((e) => check('B 发现设备', false, e.message));

  const room = await A.cdp.eval(`JSON.stringify({roomType: window.__fd.signaling.roomType, roomId: window.__fd.signaling.roomId})`);
  console.log('    房间信息 A：' + room);
  console.log('');

  console.log('[4] 等待 P2P 数据通道建立');
  const stateA = await waitFor('A 的传输通道就绪', () =>
    A.cdp.eval(`(() => {
      const p = [...window.__fd.signaling.peers.values()][0];
      if (!p) return null;
      return (p.state === 'connected' || p.state === 'relay') ? p.state + '|' + p.transport.kind : null;
    })()`), 25000).catch((e) => { check('通道就绪', false, e.message); return null; });

  if (stateA) {
    const [st, kind] = String(stateA).split('|');
    check('使用的是 P2P 直连（非中继）', kind === 'p2p', `state=${st} transport=${kind}`);
  }
  console.log('');

  console.log('[5] 文字消息 A → B（走完整界面路径）');
  await A.cdp.eval(`(() => {
    const card = document.querySelector('.peer');
    if (card) card.click();
    return !!card;
  })()`);
  await sleep(400);

  const text = 'FlashDrop 自测消息 ' + Math.random().toString(36).slice(2, 8);
  await A.cdp.eval(`(() => {
    document.getElementById('text-input').value = ${JSON.stringify(text)};
    document.getElementById('btn-send-text').click();
    return true;
  })()`);

  const gotText = await waitFor('B 收到文字', () =>
    B.cdp.eval(`(() => {
      const b = document.querySelector('.text-bubble');
      return b && b.textContent.includes(${JSON.stringify(text)}) ? b.textContent : null;
    })()`), 20000).catch(() => null);
  check('文字送达且界面已显示', gotText === text, gotText ? '内容匹配' : '未收到');
  console.log('');

  console.log('[6] 文件 A → B（3 MB，校验 SHA-256）');
  await B.cdp.eval(`window.__files = [];
    window.__flashdropOnFile = (f) => { window.__files.push(f); };`);

  const sendResult = await A.cdp.eval(`(async () => {
    const SIZE = 3 * 1024 * 1024;
    const buf = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) buf[i] = (i * 31 + 7) & 0xff;
    const file = new File([buf], 'e2e-3mb.bin', { type: 'application/octet-stream' });
    window.__expectedSha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    // 故意不 await：sendFiles 会一直等到对方「接受」才返回，
    // 而「接受」得等测试脚本在 B 上点按钮，await 会直接死锁。
    window.__sendDone = 'pending';
    const p = [...window.__fd.signaling.peers.values()][0];
    p.sendFiles([file])
      .then(() => { window.__sendDone = 'ok'; })
      .catch((e) => { window.__sendDone = 'err: ' + e.message; });
    return window.__expectedSha;
  })()`);

  await waitFor('B 弹出接收确认', () =>
    B.cdp.eval(`!document.getElementById('modal-receive').hidden`), 20000)
    .then(() => check('B 弹出接收确认框', true))
    .catch((e) => check('B 弹出接收确认框', false, e.message));

  console.log('    确认框信息：' + await B.cdp.eval(`document.getElementById('receive-total').textContent`));
  await B.cdp.eval(`document.getElementById('btn-accept').click()`);

  const recvShaA = await waitFor('B 收完文件', async () => {
    if (!(await B.cdp.eval(`window.__files.length`))) return null;
    return B.cdp.eval(`(async () => {
      const buf = await window.__files[0].blob.arrayBuffer();
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
        .map(b => b.toString(16).padStart(2, '0')).join('');
    })()`);
  }, 60000).catch((e) => { check('B 收完文件', false, e.message); return null; });

  if (recvShaA) {
    check('A→B 文件内容一致（SHA-256）', recvShaA === sendResult,
      recvShaA === sendResult ? '' : `\n      发送端 ${sendResult}\n      接收端 ${recvShaA}`);
    console.log('    接收：' + await B.cdp.eval(`window.__files[0].name + ' / ' + window.__files[0].blob.size + ' B'`));
  }
  const doneA = await A.cdp.eval(`window.__sendDone`);
  check('A 侧发送流程正常收尾', doneA === 'ok', String(doneA));
  console.log('');

  console.log('[7] 文件 B → A（1 MB，反向验证）');
  await A.cdp.eval(`window.__files = [];
    window.__flashdropOnFile = (f) => { window.__files.push(f); };`);

  const sendBack = await B.cdp.eval(`(async () => {
    const SIZE = 1024 * 1024;
    const buf = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) buf[i] = (i * 7 + 13) & 0xff;
    const file = new File([buf], 'e2e-1mb.bin', { type: 'application/octet-stream' });
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    window.__sendDoneB = 'pending';
    const p = [...window.__fd.signaling.peers.values()][0];
    p.sendFiles([file])
      .then(() => { window.__sendDoneB = 'ok'; })
      .catch((e) => { window.__sendDoneB = 'err: ' + e.message; });
    return sha;
  })()`);

  await waitFor('A 弹出接收确认', () =>
    A.cdp.eval(`!document.getElementById('modal-receive').hidden`), 20000)
    .catch((e) => check('A 弹出接收确认框', false, e.message));
  await A.cdp.eval(`document.getElementById('btn-accept').click()`);

  const recvShaB = await waitFor('A 收完文件', async () => {
    if (!(await A.cdp.eval(`window.__files.length`))) return null;
    return A.cdp.eval(`(async () => {
      const buf = await window.__files[0].blob.arrayBuffer();
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
        .map(b => b.toString(16).padStart(2, '0')).join('');
    })()`);
  }, 60000).catch((e) => { check('A 收完文件', false, e.message); return null; });

  if (recvShaB) {
    check('B→A 文件内容一致（SHA-256）', recvShaB === sendBack,
      recvShaB === sendBack ? '' : `\n      发送端 ${sendBack}\n      接收端 ${recvShaB}`);
  }
  const doneB = await B.cdp.eval(`window.__sendDoneB`);
  check('B 侧发送流程正常收尾', doneB === 'ok', String(doneB));
  console.log('');

  console.log('[8] 传输统计');
  console.log('    A 侧连接：' + await A.cdp.eval(`(() => {
    const p = [...window.__fd.signaling.peers.values()][0];
    return JSON.stringify({ state: p.state, transport: p.transport.kind, peerName: p.name });
  })()`));
  console.log('');

  console.log('[9] 流式落盘分支（模拟 File System Access API，校验写入顺序）');
  // headless 里没法弹真实的目录选择框，所以塞一个假的目录句柄，
  // 逼程序走「边收边写盘」那条路 —— 这条分支的分片顺序问题最容易漏测。
  await B.cdp.eval(`(() => {
    window.__disk = { parts: [], name: null, closed: false };
    window.showDirectoryPicker = async () => ({
      async getFileHandle(name) {
        window.__disk.name = name;
        return {
          async createWritable() {
            return {
              async write(u8) { window.__disk.parts.push(u8.slice()); },
              async close() { window.__disk.closed = true; },
              async abort() { window.__disk.aborted = true; },
            };
          },
        };
      },
    });
    window.__files2 = [];
    window.__flashdropOnFile = (f) => { window.__files2.push(f); };
    return true;
  })()`);

  const diskSha = await A.cdp.eval(`(async () => {
    const SIZE = 70 * 1024 * 1024;   // 必须超过 64 MB 的流式落盘阈值
    const buf = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) buf[i] = (i * 131 + 17) & 0xff;
    const file = new File([buf], 'disk-70mb.bin', { type: 'application/octet-stream' });
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const p = [...window.__fd.signaling.peers.values()][0];
    p.sendFiles([file]).catch(() => {});
    return sha;
  })()`);

  await waitFor('B 弹出接收确认（大文件）', () =>
    B.cdp.eval(`!document.getElementById('modal-receive').hidden`), 20000)
    .catch((e) => check('B 弹出接收确认框', false, e.message));
  await B.cdp.eval(`document.getElementById('btn-accept').click()`);

  const diskResult = await waitFor('B 收完 70 MB 并落盘', async () => {
    if (!(await B.cdp.eval(`window.__files2.length`))) return null;
    return B.cdp.eval(`(async () => {
      const d = window.__disk;
      const total = d.parts.reduce((a, p) => a + p.length, 0);
      const all = new Uint8Array(total);
      let off = 0;
      for (const p of d.parts) { all.set(p, off); off += p.length; }
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))]
        .map(b => b.toString(16).padStart(2, '0')).join('');
      return JSON.stringify({ sha, total, closed: d.closed, name: d.name, saved: window.__files2[0].saved });
    })()`);
  }, 120000).catch((e) => { check('B 收完 70 MB', false, e.message); return null; });

  if (diskResult) {
    const r = JSON.parse(diskResult);
    console.log(`    落盘：${r.name} / ${(r.total / 1048576).toFixed(1)} MB / closed=${r.closed} / saved=${r.saved}`);
    check('走了流式落盘分支', r.saved === 'disk', `saved=${r.saved}`);
    check('落盘字节数正确', r.total === 70 * 1024 * 1024, `${r.total} B`);
    check('写入顺序正确（SHA-256 一致）', r.sha === diskSha,
      r.sha === diskSha ? '' : `\n      发送端 ${diskSha}\n      落盘端 ${r.sha}`);
    check('文件句柄已正确关闭', r.closed === true);
  }
  console.log('');

  // 附加：非安全上下文（HTTP + 局域网 IP）下浏览器到底给不给 WebRTC
  if (process.env.TEST_INSECURE) {
    console.log('[10] 附加：HTTP + 局域网 IP 下的行为');
    const C = await boot('C', process.env.TEST_INSECURE, 9413);
    console.log('    探测结果：' + await C.cdp.eval(`JSON.stringify({
      origin: location.origin,
      secure: window.isSecureContext,
      rtc: typeof window.RTCPeerConnection,
      warned: !document.getElementById('insecure-banner').hidden
    })`));
    console.log('');
  }

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
