/**
 * 界面截图工具（开发用）
 * ---------------------------------------------------------------------------
 * 驱动两个真实浏览器实例走一遍典型流程，把每个关键界面截成 PNG，输出到 docs/。
 * 前提：FlashDrop 服务已在运行。
 *
 *   node test/screenshot.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, waitFor, sleep, tempProfile, findChrome, killTree } = require('./lib');

const BASE = process.env.BASE || 'http://127.0.0.1:8686';
const OUT = path.join(__dirname, '..', 'docs');
// 下载目录放临时区：截图脚本会真的触发下载，别把测试文件堆进仓库
const DOWNLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-downloads-'));

const procs = [];
const cdps = [];
const instances = [];
const dirs = [];

async function boot(label, port) {
  const profileDir = tempProfile(`fd-shot-${label}-`);
  dirs.push(profileDir);
  const inst = await launch({
    label, url: BASE, port, profileDir, chrome: findChrome(),
    headless: true, width: 1080, height: 900,
  });
  procs.push(inst.proc);
  cdps.push(inst.cdp);
  instances.push(inst);
  // 允许下载，避免 headless 里弹"是否允许多文件下载"把流程卡住
  try {
    await inst.cdp.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
    });
  } catch { /* 忽略 */ }
  return inst;
}

let n = 0;
async function shot(inst, name) {
  n++;
  const buf = await inst.cdp.screenshot();
  const file = path.join(OUT, `${String(n).padStart(2, '0')}-${name}.png`);
  fs.writeFileSync(file, buf);
  console.log('  saved ' + path.relative(path.join(__dirname, '..'), file) + `  (${(buf.length / 1024).toFixed(0)} KB)`);
}

async function cleanup() {
  // 先让页面主动断开，服务端立刻把设备移出房间（只杀进程不保证 TCP 及时释放）
  for (const c of cdps) {
    try { await c.eval('window.__fd && window.__fd.signaling.close()'); } catch { /* 忽略 */ }
  }
  await sleep(500);
  for (const c of cdps) c.close();
  // 让浏览器自己退出：spawn 出来的进程是"启动器即退"，proc.pid 早就失效了
  await Promise.all(instances.map((i) => i.close()));
  await sleep(1200);
  await Promise.all(procs.map((p) => killTree(p)));
  for (const d of dirs.concat([DOWNLOAD_DIR])) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('\n===== 生成界面截图 =====');

  console.log('[1] 单机状态（二维码引导页）');
  const A = await boot('A', 9511);
  await waitFor('二维码渲染完成', () =>
    A.cdp.eval(`document.querySelector('#qr-holder svg') !== null`), 15000).catch(() => {});
  await sleep(600);
  await shot(A, '扫码连接');

  console.log('[2] 第二台设备加入');
  const B = await boot('B', 9512);
  await waitFor('两端互相发现', () => A.cdp.eval(`window.__fd.signaling.peers.size >= 1`), 25000);
  await waitFor('P2P 通道就绪', () => A.cdp.eval(
    `(() => { const p = [...window.__fd.signaling.peers.values()][0]; return p && p.state === 'connected'; })()`
  ), 20000);

  // 万一有上一轮残留的浏览器还在房间里，早点报清楚，别等到后面截图超时才发现
  const nPeers = await A.cdp.eval(`window.__fd.signaling.peers.size`);
  if (nPeers !== 1) {
    throw new Error(`房间里有 ${nPeers} 台设备，预期只有 1 台。` +
      `多半是上一轮测试的浏览器没被杀干净，先清掉残留的 chrome 进程再跑。`);
  }

  await A.cdp.eval(`(() => { const c = document.querySelector('.peer'); if (c) c.click(); return true; })()`);
  await A.cdp.eval(`document.getElementById('text-input').value = '把这段文字复制到手机就行 → https://example.com/x/1234';`);
  await sleep(500);
  await shot(A, '选择设备与发送区');

  console.log('[3] 接收确认框');
  // headless 里弹不出目录选择框，让它直接失败，退到"接收后自动下载"那条路
  await B.cdp.eval(`window.showDirectoryPicker = async () => { throw new Error('headless: 无目录选择框'); };`);

  await A.cdp.eval(`(() => {
    const f = (name, mb, mime) => {
      const size = mb * 1024 * 1024;
      const buf = new Uint8Array(size);
      for (let i = 0; i < size; i += 65536) buf[i] = i & 0xff;
      return new File([buf], name, { type: mime });
    };
    const files = [
      f('2026-09-假期录像.mp4', 30, 'video/mp4'),
      f('素材包.zip', 15, 'application/zip'),
      f('旅行照片原图.jpg', 5, 'image/jpeg'),
    ];
    window.__shotSent = 'ok';
    const p = [...window.__fd.signaling.peers.values()][0];
    if (!p) { window.__shotSent = 'no-peer'; return true; }
    window.__shotPeerState = p.state + '/' + p.transport.kind;
    p.sendFiles(files).then(() => { window.__shotSent = 'done'; })
      .catch((e) => { window.__shotSent = 'err: ' + e.message; });
    return true;
  })()`);

  try {
    await waitFor('B 弹出确认框', () => B.cdp.eval(`!document.getElementById('modal-receive').hidden`), 20000);
  } catch (e) {
    console.log('    [诊断] A 侧发送状态：' + await A.cdp.eval(`window.__shotSent + ' / peer=' + window.__shotPeerState`));
    console.log('    [诊断] B 侧 peers=' + await B.cdp.eval(`window.__fd.signaling.peers.size`)
      + ' 连接态=' + await B.cdp.eval(`(() => { const p = [...window.__fd.signaling.peers.values()][0]; return p ? p.state + '/' + p.transport.kind + '/busy=' + p._busy + '/incoming=' + !!p._incoming : 'no-peer'; })()`));
    console.log('    [诊断] B 侧活动记录=' + await B.cdp.eval(`[...document.querySelectorAll('.act-title')].map(e => e.textContent).join(' | ') || '(空)'`));
    throw e;
  }
  await sleep(400);
  await shot(B, '接收确认');

  console.log('[4] 传输中');
  await B.cdp.eval(`document.getElementById('btn-accept').click()`);
  await waitFor('传输已开始', async () => {
    const w = await A.cdp.eval(`(() => {
      const b = document.querySelector('.act .bar > i');
      return b ? parseFloat(b.style.width) || 0 : 0;
    })()`);
    return w > 3;
  }, 30000).catch(() => {});
  await sleep(500);
  await shot(A, '传输中');

  console.log('[5] 完成后');
  await waitFor('传输完成', () => A.cdp.eval(
    `(() => { const p = [...window.__fd.signaling.peers.values()][0]; return !p._busy && !p._incoming; })()`
  ), 300000).catch(() => {});
  await sleep(800);
  await shot(A, '传输完成');

  console.log('\n完成。\n');
  return 0;
}

main()
  .then(async (c) => { await cleanup(); process.exit(c); })
  .catch(async (e) => {
    console.error('出错：', e && e.message);
    await cleanup();
    process.exit(2);
  });
