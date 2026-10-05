'use strict';
/**
 * www 归一测试
 * ===========================================================================
 * 验证：用 `www.` 开头的地址打开后，会**原地跳到主域名**，并且 hash 不丢。
 *
 * 为什么必须归一（这是个真踩过的坑）：
 *   `6.中国` 和 `www.6.中国` 在浏览器眼里是**两个不同的 origin**，
 *   localStorage / IndexedDB 按 origin 隔离，也就是各存一份。
 *   于是「在 6.中国 改的设备名、配过的设备」，到 www.6.中国 上全读不到 ——
 *   用户看到的现象就是「改名没生效 / 配对丢了」，而且怎么刷新都不好。
 *
 *   修法不是在两个域名间同步状态（同步不干净、还会漏），而是统一到一个入口。
 *   `public/index.html` 的 <head> 最前面那段脚本干这个。
 *
 * 用法：
 *   node test/www-redirect.js                          # 默认打线上 https://6.中国
 *   node test/www-redirect.js http://6.xn--fiqs8s:8986 # 本地（自动加 host-resolver-rules）
 *
 * 本地跑的前提：`run.js --port 8986 --no-tls` 已经在跑。
 * 本地路径会额外加 `--host-resolver-rules`，让 Chrome 把
 * `6.xn--fiqs8s` / `www.6.xn--fiqs8s` 都解析到本机，不碰真实 DNS。
 *
 * ⚠️ 关于 hash 断言方式（这里有个测试本身的坑）：
 *   页面里的 FlashDrop 在启动时会消费 `#pair=<6位码>`，处理完顺手
 *   `history.replaceState` 把 hash 抹掉（见 app.js 的 initHashPair）。
 *   所以**事后读 location.hash 必然是空的**，那是正常行为，不是 bug。
 *   要验证「跳转时 hash 有没有带过去」，只能在**文档创建的那一刻**打快照 ——
 *   用 CDP 的 Page.addScriptToEvaluateOnNewDocument 注入，它会早于任何页面脚本执行。
 */

const { launch, waitFor, sleep, tempProfile, closeBrowser } = require('./lib');

const DEBUG_PORT = 9821;
const PROFILE = tempProfile('fd-www-');

const HASH = '#pair=123456';

/** 由 base 推出它带 www 的形态：http://a.b:123/ → http://www.a.b:123/ */
function withWww(base) {
  const u = new URL(base);
  u.hostname = 'www.' + u.hostname;
  return u;
}

(async () => {
  const base = process.argv[2] || 'https://6.xn--fiqs8s';
  const apex = new URL(base);
  const wwwU = withWww(base);

  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|6\.xn--fiqs8s|www\.)/.test(base);
  const extraArgs = isLocal
    ? ['--host-resolver-rules=MAP www.6.xn--fiqs8s 127.0.0.1,MAP 6.xn--fiqs8s 127.0.0.1']
    : [];

  let pass = 0, fail = 0;
  const ok = (m) => { console.log('  ✅ ' + m); pass++; };
  const no = (m) => { console.log('  ❌ ' + m); fail++; };

  console.log('');
  console.log('===== www 归一测试 =====');
  console.log(`  主域名    ${apex.origin}/`);
  console.log(`  www 形态  ${wwwU.origin}/`);
  console.log('');

  const b = await launch({
    label: 'www',
    url: apex.origin + '/',          // 先落在主域名，下面靠 Page.navigate 触发跳转
    port: DEBUG_PORT,
    profileDir: PROFILE,
    extraArgs,
  });

  try {
    /* ------------------------------------------------------------------
       [1] 注入 boot 快照器 → 导航到 www#pair=123456
           addScriptToEvaluateOnNewDocument 早于页面任何脚本执行，
           所以能在 app.js 抹掉 hash **之前** 抓到真实 URL
    ------------------------------------------------------------------ */
    await b.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__bootHref = location.href;',
    });

    const startUrl = wwwU.origin + '/' + HASH;
    console.log(`[1] 打开 ${startUrl}`);
    console.log(`    期望：落在 ${apex.origin}/ 且 hash 不丢`);

    await b.cdp.send('Page.navigate', { url: startUrl });
    await sleep(600);

    let bootHref = '';
    let liveHref = '';
    try {
      await waitFor('跳到主域名', async () => {
        try {
          bootHref = await b.cdp.eval('window.__bootHref || ""');
          liveHref = await b.cdp.eval('location.href');
        } catch { return false; }
        return liveHref.indexOf(wwwU.hostname) === -1 && liveHref.indexOf(apex.hostname) !== -1;
      }, 25000, 250);
    } catch {
      bootHref = await b.cdp.eval('window.__bootHref || ""').catch(() => '');
      liveHref = await b.cdp.eval('location.href').catch(() => '');
    }

    console.log('    实际：' + liveHref);
    console.log('    boot 快照：' + bootHref);

    const live = new URL(liveHref);
    const boot = new URL(bootHref || 'about:blank');

    if (live.hostname === apex.hostname) ok(`已归一，主机名 = ${live.hostname}`);
    else no(`主机名不是主域名，得到 ${live.hostname}`);

    // hash 必须出现在「跳转后那个文档」的 boot 时刻
    if (boot.hash === HASH) ok(`hash 已随跳转保留（boot 时刻 = ${boot.hash}）`);
    else no(`hash 没带过去：boot 时刻 = ${boot.hash || '(空)'}`);

    // 跳转后必须是个能用的页面，不能白屏
    await waitFor('页面就绪', async () => {
      try { return await b.cdp.eval('document.readyState === "complete" && typeof window.FlashDrop === "object"'); }
      catch { return false; }
    }, 25000, 250).catch(() => {});
    const ready = await b.cdp.eval('document.readyState');
    const hasApp = await b.cdp.eval('typeof window.FlashDrop === "object"');
    if (ready === 'complete' && hasApp) ok('跳转后页面正常可用（FlashDrop 已就绪）');
    else no(`跳转后页面异常 readyState=${ready} FlashDrop=${hasApp}`);

    /* ------------------------------------------------------------------
       [2] 直接开主域名 → 不能被误跳（否则就是死循环了）
    ------------------------------------------------------------------ */
    console.log('');
    console.log(`[2] 直接打开 ${apex.origin}/ （不应发生任何跳转）`);
    await b.cdp.send('Page.navigate', { url: apex.origin + '/' });
    await waitFor('主域名页面就绪', async () => {
      try { return await b.cdp.eval('document.readyState === "complete" && typeof window.FlashDrop === "object"'); }
      catch { return false; }
    }, 25000, 250);

    const apexHref = await b.cdp.eval('location.href');
    console.log('    实际：' + apexHref);
    const ah = new URL(apexHref);
    if (ah.hostname === apex.hostname) ok('主域名未被误跳');
    else no(`主域名被跳走了，得到 ${ah.hostname}`);

    /* ------------------------------------------------------------------
       [3] 「只剥一层 www」的不变式：每跳一层 hostname 严格变短 → 必然终止
           生产环境上 www.www.6.中国 没有 DNS 记录、访问不到，
           所以这条用逻辑校验，不用真浏览器跑
    ------------------------------------------------------------------ */
    console.log('');
    console.log('[3] 不变式：每跳一层 www 少一层，必然终止（不会 www.www 死循环）');
    const strip = (h) => (h.slice(0, 4).toLowerCase() === 'www.' ? h.slice(4) : h);
    let cur = 'www.www.www.6.xn--fiqs8s';
    const trail = [cur];
    for (let i = 0; i < 10 && strip(cur) !== cur; i++) { cur = strip(cur); trail.push(cur); }
    console.log('    ' + trail.join('  →  '));
    if (cur === '6.xn--fiqs8s' && trail.length === 4) ok('三层 www 收敛到主域名，共 3 跳，无死循环');
    else no(`未按预期收敛，停在 ${cur}（${trail.length} 步）`);
  } finally {
    await b.close().catch(() => {});
    await closeBrowser(DEBUG_PORT).catch(() => {});
  }

  console.log('');
  console.log('===== 结果 =====');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  try { require('fs').rmSync(PROFILE, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e && e.message ? e.message : e);
  try { require('fs').rmSync(PROFILE, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
});
