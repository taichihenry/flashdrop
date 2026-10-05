/**
 * 复现 / 验证：一台终端改名后，其他终端能不能实时看到新名字。
 * ---------------------------------------------------------------------------
 * 跑法：
 *   node test/rename.js                          # 默认打线上
 *   node test/rename.js http://localhost:8443    # 打本地
 *   HEADED=1 node test/rename.js                 # 有头模式，肉眼看
 *
 * 诊断思路：在 A 上钩住 signaling.send（看它到底发了 rename 没有），
 * 在 B 上钩住 signaling.emit（看它到底收到 peer-renamed 没有）。
 * 两头都挂钩，才能定位是「没发」「服务端没转」还是「转了没收」。
 */

'use strict';

const { launch, waitFor, sleep, tempProfile, findChrome } = require('./lib');

const CHROME = findChrome();
const BASE = process.argv[2] || process.env.BASE || 'https://6.xn--fiqs8s';
const HEADLESS = process.env.HEADED !== '1';
const PORT_A = Number(process.env.PORT_A || 9761);
const PORT_B = Number(process.env.PORT_B || 9762);

const log = (...a) => console.log(...a);

(async () => {
  const instances = [];
  try {
    log('===== 改名同步 实测 =====');
    log('  目标：' + BASE);
    log('');

    for (const [i, label] of ['RA', 'RB'].entries()) {
      instances.push(await launch({
        label,
        url: BASE,
        port: i === 0 ? PORT_A : PORT_B,
        profileDir: tempProfile('fd-rename-'),
        headless: HEADLESS,
      }));
    }
    const [A, B] = instances;

    log('[1] 等两端互相可见');
    await waitFor('互相可见', async () => {
      const a = await A.cdp.eval('(__fd && __fd.signaling) ? __fd.signaling.peerList().length : -1');
      const b = await B.cdp.eval('(__fd && __fd.signaling) ? __fd.signaling.peerList().length : -1');
      return a >= 1 && b >= 1;
    });
    log('    完成');

    // 挂钩子：B 记录收到的所有事件；A 记录发出的所有信令
    await B.cdp.eval(`
      window.__events = [];
      const s = __fd.signaling;
      const orig = s.emit.bind(s);
      s.emit = (ev, p) => {
        let cp = null; try { cp = p ? JSON.parse(JSON.stringify(p)) : null; } catch (e) {}
        window.__events.push({ ev, p: cp });
        return orig(ev, p);
      };
      window.__raw = [];
      if (s.onMessage) {} // noop
      'ok'
    `);
    await A.cdp.eval(`
      window.__sent = [];
      const s = __fd.signaling;
      const orig = s.send.bind(s);
      s.send = (m) => { try { window.__sent.push(m); } catch (e) {} return orig(m); };
      'ok'
    `);

    const beforeA = await A.cdp.eval('__fd.signaling.peerList().map(p => p.name)');
    const beforeB = await B.cdp.eval('__fd.signaling.peerList().map(p => p.name)');
    log('[2] 改名之前');
    log('    A 看到的：' + JSON.stringify(beforeA));
    log('    B 看到的：' + JSON.stringify(beforeB));

    const NEW = 'BOSS-LAPTOP';
    log('[3] A 点「修改设备名」按钮改名 → ' + NEW + '（走真实 UI 路径，会写 localStorage）');
    await A.cdp.eval(`
      window.prompt = () => ${JSON.stringify(NEW)};
      document.getElementById('btn-name').click();
      'ok'
    `);
    await sleep(2500);
    const lsName = await A.cdp.eval(`localStorage.getItem('flashdrop.name')`);
    log('    A 的 localStorage：' + JSON.stringify(lsName));
    log('    A 自己 UI 上的名字：' + JSON.stringify(await A.cdp.eval(`(document.getElementById('my-name')||{}).textContent || ''`)));

    const sent = await A.cdp.eval('window.__sent');
    const events = await B.cdp.eval('window.__events');
    const afterB = await B.cdp.eval('__fd.signaling.peerList().map(p => p.name)');
    const bDom = await B.cdp.eval(`(document.getElementById('peer-list')||{}).textContent || ''`);
    const aSelf = await A.cdp.eval(`(document.getElementById('my-name')||{}).textContent || ''`);

    log('');
    log('[4] 诊断');
    log('    A 发出的信令      ：' + JSON.stringify(sent));
    log('    B 收到的事件名    ：' + JSON.stringify(events.map((e) => e.ev)));
    log('    B 收到的 peer-renamed 载荷：' + JSON.stringify(events.filter((e) => e.ev === 'peer-renamed').map((e) => e.p)));
    log('    A 自己 UI 上的名字：' + JSON.stringify(aSelf));
    log('    B 看到的设备名    ：' + JSON.stringify(afterB));
    log('    B 的设备列表 DOM  ：' + JSON.stringify(bDom));

    log('');
    if (Array.isArray(afterB) && afterB.includes(NEW)) log('✅ [阶段1] B 已实时显示新名字');
    else log('❌ [阶段1] B 未显示新名字');

    /* ---- 阶段 2：刷新页面后，自定义名字还在不在？ ---- */
    log('');
    log('[5] A 刷新页面（模拟「改完名后重新打开 / 断线重连」）');
    await A.cdp.eval('location.reload(); "ok"');
    await waitFor('A 重新加载完成', async () => {
      try { return await A.cdp.eval('document.readyState === "complete" && typeof window.FlashDrop === "object"'); }
      catch { return false; }
    }, 30000, 300);
    await sleep(3500);   // 等重新入房、B 侧收到新的 peer-joined

    const aDom = await A.cdp.eval(`(document.getElementById('my-name')||{}).textContent || ''`);
    const afterReloadB = await B.cdp.eval('__fd.signaling.peerList().map(p => ({name: p.name}))');
    log('    A 刷新后，自己 UI 上的名字：' + JSON.stringify(aDom));
    log('    A 刷新后，B 看到的设备名  ：' + JSON.stringify(afterReloadB.map((p) => p.name)));

    log('');
    const selfOk = aDom === NEW;
    const peerOk = Array.isArray(afterReloadB) && afterReloadB.some((p) => p.name === NEW);
    if (selfOk && peerOk) log('✅ [阶段2] 刷新后自定义名字仍然同步');
    else if (selfOk && !peerOk) log('❌ [阶段2] 复现成功 —— A 自己显示自定义名，但 B 看到的是默认名（服务端丢了自定义名）');
    else log('❌ [阶段2] 异常：A 自己也没保住名字');
  } catch (e) {
    log('❗测试异常：' + e.message);
    process.exitCode = 1;
  } finally {
    for (const inst of instances) { try { await inst.close(); } catch { /* noop */ } }
  }
})();
