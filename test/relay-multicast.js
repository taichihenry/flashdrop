/**
 * FlashDrop · 中继通道端到端加密 + 多播发送 实测
 * ---------------------------------------------------------------------------
 * 这个脚本专门验证三件事，都必须**在真实浏览器里跑出来**才算数：
 *
 *   1. 中继通道确实端到端加密了 —— 包括在信令 socket 上抓原始帧，
 *      确认线上跑的是密文（kind=enc），明文关键字一个字节都没出现。
 *   2. 一台发给多台（多播）能同时送达，且每个目标只收到**一次**请求。
 *      （drop 事件冒泡曾被漏挡，导致拖文件时 sendFiles 被调两次，这里钉死它。）
 *   3. 中继背压真的生效 —— bufferedAmount() 会返回非零值。
 *      修之前它恒等于 0，等于完全没有流控。
 *
 * 用 FD_FORCE_RELAY 强制跳过 P2P，直接走中继 —— 不然本机两个浏览器总是能
 * 直连成功，中继那条路根本不会被走到。
 *
 * 跑法：
 *   node test/relay-multicast.js                              # 默认打本机 18766
 *   node test/relay-multicast.js https://xxx.example.com      # 指定站点
 *   HEADFUL=1 node test/relay-multicast.js                    # 有界面
 */

'use strict';

const fs = require('fs');
const { launch, waitFor, sleep, tempProfile, findChrome } = require('./lib');

const CHROME = findChrome();
const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:18766';
const HEADLESS = process.env.HEADFUL !== '1';

const instances = [];
const tmpDirs = [];
let failures = 0;

function check(label, ok, extra) {
  console.log(`    ${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
}

async function bootRelay(label, port) {
  const profileDir = tempProfile(`fd-relay-${label}-`);
  tmpDirs.push(profileDir);
  const inst = await launch({
    label, url: BASE, port, profileDir, headless: HEADLESS, chrome: CHROME,
  });
  instances.push(inst);

  // 关键：必须在应用脚本执行前注入。Peer 是在建连接时才读这个开关的，
  // 页面加载完再设就晚了（对象已经建好了）。
  await inst.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.FD_FORCE_RELAY = true;',
  });
  await inst.cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(`${label} 重新加载`, () =>
    inst.cdp.eval('!!(window.__fd && window.FD_FORCE_RELAY)'), 30000);
  await waitFor(`${label} 进入房间`, () =>
    inst.cdp.eval('window.__fd.signaling.roomId || null'), 30000);
  return inst;
}

async function cleanup() {
  for (const i of instances) {
    try { await i.cdp.eval('window.__fd && window.__fd.signaling.close()'); } catch { /* noop */ }
  }
  await sleep(600);
  for (const i of instances) i.cdp.close();
  await Promise.all(instances.map((i) => i.close().catch(() => {})));
  await sleep(1200);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
}

/* ------------------------------ 页面内取值 ------------------------------ */

const JS_DUMP = `JSON.stringify({
  room: window.__fd.signaling.roomType + ' / ' + window.__fd.signaling.roomId,
  peers: [...window.__fd.signaling.peers.values()].map(p =>
    p.name + ' [' + p.state + '/' + (p.transport ? p.transport.kind : '?') +
    (p.transport && p.transport.kind === 'relay'
      ? (p.transport.encrypted ? ' 🔒已加密' : ' －未协商') : '') + ']')
})`;

/** 按名字找 peer（点名，不用"第一个"） */
const jsFind = (name) => `(() => {
  const p = [...window.__fd.signaling.peers.values()].find(x => x.name === ${JSON.stringify(name)});
  return p ? p.id : null;
})()`;

/** 某个 peer 的连接方式与加密状态 */
const jsTransport = (name) => `(() => {
  const p = [...window.__fd.signaling.peers.values()].find(x => x.name === ${JSON.stringify(name)});
  if (!p) return JSON.stringify({ found: false });
  const t = p.transport;
  return JSON.stringify({
    found: true, state: p.state,
    kind: t ? t.kind : null,
    encrypted: t && t.kind === 'relay' ? !!t.encrypted : null,
    plain: t && t.kind === 'relay' ? !!t._plain : null,
  });
})()`;

/** 选设备卡片（每次重新查 DOM —— 点一下会整块重渲染，旧引用会失效）；
 *  已经是选中态就不点了，否则会把它取消掉。 */
const jsPick = (name) => `(() => {
  const hit = [...document.querySelectorAll('.peer')]
    .find(c => (c.querySelector('.peer-name') || {}).textContent === ${JSON.stringify(name)});
  if (!hit) return 'not-found';
  if (hit.classList.contains('selected')) return 'already-selected';
  hit.click();
  return 'clicked';
})()`;

/* -------------------------------- 主流程 -------------------------------- */

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error(`找不到浏览器：${CHROME}`);
    process.exit(2);
  }

  console.log('\n===== FlashDrop 中继加密 + 多播 实测 =====');
  console.log(`  浏览器：${CHROME}`);
  console.log(`  目标  ：${BASE}`);
  console.log(`  模式  ：${HEADLESS ? 'headless' : '有界面'}\n`);

  console.log('[1] 启动 3 个隔离实例，并强制走中继（跳过 P2P）');
  const A = await bootRelay('A', 9431);
  const B = await bootRelay('B', 9432);
  const C = await bootRelay('C', 9433);
  console.log('    完成\n');

  console.log('[2] 改名，便于点名');
  await A.cdp.eval(`window.__fd.signaling.rename('RM_A')`);
  await B.cdp.eval(`window.__fd.signaling.rename('RM_B')`);
  await C.cdp.eval(`window.__fd.signaling.rename('RM_C')`);
  await sleep(1500);
  console.log('    A ' + await A.cdp.eval(JS_DUMP));
  console.log('    B ' + await B.cdp.eval(JS_DUMP));
  console.log('    C ' + await C.cdp.eval(JS_DUMP));
  console.log('');

  console.log('[3] 互相可见 + 确认走的是中继通道');
  let ok = true;
  for (const [inst, name] of [[A, 'RM_B'], [A, 'RM_C'], [B, 'RM_A'], [C, 'RM_A']]) {
    try {
      await waitFor(`${name} 可见`, () => inst.cdp.eval(jsFind(name)), 40000);
    } catch (e) {
      ok = false;
      console.log(`    ❌ ${e.message}`);
    }
  }
  check('三个实例互相可见', ok);

  const stAB = JSON.parse(await A.cdp.eval(jsTransport('RM_B')));
  const stBA = JSON.parse(await B.cdp.eval(jsTransport('RM_A')));
  check('A→B 走的是 WebSocket 中继', stAB.kind === 'relay', JSON.stringify(stAB));
  check('B→A 走的是 WebSocket 中继', stBA.kind === 'relay', JSON.stringify(stBA));
  console.log('');

  console.log('[4] 端到端加密：抓 A 的信令 socket，看线上到底发了什么');
  await A.cdp.eval(`(() => {
    const s = window.__fd.signaling;
    window.__wire = [];
    const orig = s.send.bind(s);
    s.send = (obj) => {
      if (obj && obj.type === 'relay') window.__wire.push(obj.payload);
      return orig(obj);
    };
    return true;
  })()`);

  // 顺带挂一个背压采样器和一个 _sendJSON 计数器
  await A.cdp.eval(`(() => {
    window.__bp = { max: 0, samples: 0, nonZero: 0 };
    window.__bpTimer = setInterval(() => {
      for (const p of window.__fd.signaling.peers.values()) {
        const t = p.transport;
        if (t && t.kind === 'relay' && typeof t.bufferedAmount === 'function') {
          const v = t.bufferedAmount();
          window.__bp.samples++;
          if (v > 0) window.__bp.nonZero++;
          if (v > window.__bp.max) window.__bp.max = v;
        }
      }
    }, 8);

    window.__reqs = [];
    const proto = window.FlashDrop.Peer.prototype;
    const origJson = proto._sendJSON;
    proto._sendJSON = function (obj) {
      if (obj && obj.type === 'request') window.__reqs.push(this.name);
      return origJson.call(this, obj);
    };
    return true;
  })()`);

  // 注意：密钥协商是「第一条数据要发时才启动」的懒加载，所以这里还看不到
  // encrypted=true —— 加密状态的断言放在 [5] 发完数据之后。
  console.log('    已挂上抓帧钩子（此时还没发过数据，密钥自然还没协商）');
  console.log('');

  console.log('[5] 多播文字：A 一次发送 → B 与 C 都要收到');
  await A.cdp.eval(jsPick('RM_B'));
  await sleep(400);
  await A.cdp.eval(jsPick('RM_C'));
  await sleep(400);

  const tLabel = await A.cdp.eval(`document.getElementById('target-name').textContent`);
  const tSub = await A.cdp.eval(`document.getElementById('target-sub').textContent`);
  check('发送面板显示多选状态', tLabel === '2 台设备', `target-name="${tLabel}" / sub="${tSub}"`);

  const text = 'secret-' + Math.random().toString(36).slice(2, 10);
  await A.cdp.eval(`(() => {
    document.getElementById('text-input').value = ${JSON.stringify(text)};
    document.getElementById('btn-send-text').click();
    return true;
  })()`);

  for (const [inst, name] of [[B, 'B'], [C, 'C']]) {
    const got = await waitFor(`文字送达 ${name}`, () =>
      inst.cdp.eval(`(() => {
        const b = document.querySelector('.text-bubble');
        return b && b.textContent.includes(${JSON.stringify(text)}) ? b.textContent : null;
      })()`), 25000).catch(() => null);
    check(`文字送达 ${name}`, !!got, got || '未收到');
  }

  // 线上跑的是不是你刚发的那段明文？
  const wire = JSON.parse(await A.cdp.eval(`(() => {
    const w = window.__wire;
    let leaked = false;
    for (const p of w) {
      if (p.kind === 'text' && String(p.data).includes(${JSON.stringify(text)})) leaked = true;
      if (p.kind === 'enc' && String(p.data).includes(${JSON.stringify(text)})) leaked = true;
    }
    return JSON.stringify({
      total: w.length,
      enc: w.filter(p => p.kind === 'enc').length,
      plain: w.filter(p => p.kind === 'text' || p.kind === 'binary').length,
      kx: w.filter(p => p.kind === 'kx').length,
      leaked,
    });
  })()`));
  console.log('    信令 socket 上的中继帧：' + JSON.stringify(wire));
  check('中继帧全部是密文（enc）', wire.enc > 0 && wire.plain === 0);
  check('明文内容没有出现在线上', wire.leaked === false);

  const encAB = JSON.parse(await A.cdp.eval(jsTransport('RM_B'))).encrypted;
  const encAC = JSON.parse(await A.cdp.eval(jsTransport('RM_C'))).encrypted;
  const encBA = JSON.parse(await B.cdp.eval(jsTransport('RM_A'))).encrypted;
  const encCA = JSON.parse(await C.cdp.eval(jsTransport('RM_A'))).encrypted;
  check('A→B 通道已派生密钥', encAB === true);
  check('A→C 通道已派生密钥', encAC === true);
  check('B→A 通道已派生密钥', encBA === true);
  check('C→A 通道已派生密钥', encCA === true);
  console.log('');

  console.log('[6] 多播文件：A 拖入 6 MB → B 与 C 都要收到且 SHA-256 一致');
  for (const inst of [B, C]) {
    await inst.cdp.eval(`window.__files = [];
      window.__flashdropOnFile = (f) => { window.__files.push(f); };`);
  }

  const wantSha = await A.cdp.eval(`(async () => {
    const SIZE = 6 * 1024 * 1024;
    const buf = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) buf[i] = (i * 31 + 7) & 0xff;
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const dt = new DataTransfer();
    dt.items.add(new File([buf], 'multicast-6mb.bin', { type: 'application/octet-stream' }));
    document.getElementById('dropzone').dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    );
    return sha;
  })()`);

  for (const [inst, name] of [[B, 'B'], [C, 'C']]) {
    await waitFor(`${name} 弹接收确认`, () =>
      inst.cdp.eval(`!document.getElementById('modal-receive').hidden`), 30000)
      .then(() => console.log(`    ✅ ${name} 弹出接收确认框`))
      .catch(() => console.log(`    ❌ ${name} 没弹接收确认框`));
    await inst.cdp.eval(`document.getElementById('btn-accept').click()`);
  }

  for (const [inst, name] of [[B, 'B'], [C, 'C']]) {
    const gotSha = await waitFor(`${name} 收完文件`, async () => {
      if (!(await inst.cdp.eval(`window.__files.length`))) return null;
      return inst.cdp.eval(`(async () => {
        const buf = await window.__files[0].blob.arrayBuffer();
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
          .map(b => b.toString(16).padStart(2, '0')).join('');
      })()`);
    }, 90000).catch(() => null);
    check(`${name} 收到的 6 MB 内容一致`, gotSha === wantSha,
      gotSha ? (gotSha === wantSha ? 'SHA-256 一致' : `不一致 收=${gotSha}`) : '没收到');
  }

  const reqs = JSON.parse(await A.cdp.eval(`JSON.stringify(window.__reqs)`));
  const perTarget = {};
  for (const n of reqs) perTarget[n] = (perTarget[n] || 0) + 1;
  console.log('    每个目标收到的发送请求次数：' + JSON.stringify(perTarget));
  check('每个目标只收到 1 次请求（没有重复发送）',
    Object.values(perTarget).length === 2 && Object.values(perTarget).every((v) => v === 1));
  console.log('');

  console.log('[7] 背压：中继的 bufferedAmount() 必须能返回非零值');
  const bp = JSON.parse(await A.cdp.eval(`(() => {
    clearInterval(window.__bpTimer);
    return JSON.stringify(window.__bp);
  })()`));
  console.log('    采样：' + JSON.stringify(bp));
  check('中继 bufferedAmount() 出现过非零值', bp.nonZero > 0, `采样 ${bp.samples} 次，峰值 ${bp.max} 字节`);
  console.log('');

  console.log('[8] 收尾状态');
  console.log('    A ' + await A.cdp.eval(JS_DUMP));
  console.log('    B ' + await B.cdp.eval(JS_DUMP));
  console.log('    C ' + await C.cdp.eval(JS_DUMP));
  console.log('');

  await cleanup();

  console.log('========================================');
  console.log(failures === 0 ? '  全部通过 ✅' : `  有 ${failures} 项未通过 ❌`);
  console.log('========================================\n');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n脚本异常：' + (e && e.stack ? e.stack : e));
  await cleanup().catch(() => {});
  process.exit(1);
});
