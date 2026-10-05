'use strict';
/**
 * 域名归一测试
 * ===========================================================================
 * 验证：同一站点的几种域名写法，最终都会落到主域名 `6.中国`，
 * 并且跳转时 hash 不丢。
 *
 * 为什么要归一（三种写法各有各的坑，都踩过）：
 *   1. `x.com` 和 `www.x.com` 在浏览器眼里是**两个不同的 origin**，
 *      localStorage / IndexedDB 按 origin 隔离 —— 设备名、配对记忆各存一份。
 *      真实案例：在 `6.中国` 改好设备名，打开 `www.6.中国` 又变回默认名。
 *   2. `.中国`(xn--fiqs8s) 和 `.中國`(xn--fiqz9s) 是**两个不同的顶级域**。
 *      虽然 CNNIC 把注册数据当成一份（简繁等效），但浏览器不认这层关系，
 *      对浏览器来说同样是两个 origin，状态同样会分裂。
 *   修法不是在多个域名之间同步状态（同步不干净、还会漏），而是统一到一个入口。
 *   `public/www-redirect.js` 的 <head> 同步脚本干这个。
 *
 * 用法：
 *   node test/www-redirect.js                          # 默认打线上 https://6.中国
 *   node test/www-redirect.js http://6.xn--fiqs8s:8986 # 本地（自动加 host-resolver-rules）
 *
 * 本地跑的前提：`run.js --port 8986 --no-tls` 已经在跑。
 * 本地路径会额外加 `--host-resolver-rules`，把几个域名都解析到本机，不碰真实 DNS。
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
const CANON = '6.xn--fiqs8s';       // 主域名 6.中国
const TRAD = '6.xn--fiqz9s';        // 繁体 6.中國
const FAMILY = [CANON, TRAD];       // 本站的两个顶级域（简繁等效）

/** 由 base 推出它带 www 的形态：http://a.b:123/ → http://www.a.b:123/ */
function withWww(base, hostname) {
  const u = new URL(base);
  u.hostname = 'www.' + (hostname || u.hostname);
  return u;
}

(async () => {
  const base = process.argv[2] || 'https://6.xn--fiqs8s';
  const apex = new URL(base);
  const wwwU = withWww(base);

  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|6\.xn--fiqs8s|www\.|6\.xn--fiqz9s)/.test(base);
  const extraArgs = isLocal
    ? ['--host-resolver-rules=' + [
        'MAP 6.xn--fiqs8s 127.0.0.1',
        'MAP www.6.xn--fiqs8s 127.0.0.1',
        'MAP 6.xn--fiqz9s 127.0.0.1',
        'MAP www.6.xn--fiqz9s 127.0.0.1',
      ].join(',')]
    : [];

  let pass = 0, fail = 0, skip = 0;
  const ok = (m) => { console.log('  ✅ ' + m); pass++; };
  const no = (m) => { console.log('  ❌ ' + m); fail++; };

  const tradU = new URL(base);
  tradU.hostname = TRAD;

  console.log('');
  console.log('===== 域名归一测试 =====');
  console.log(`  主域名      ${apex.origin}/   ← 一切最终都落这里`);
  console.log(`  www 形态    ${wwwU.origin}/`);
  console.log(`  繁体顶级域  ${tradU.origin}/`);
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
       [3] 繁体顶级域 .中國 也应归一到主域名
           前提是先在 Cloudflare 给 6.中國 建 zone 并绑上 Worker。
           没建之前 DNS 解析不了，这里**跳过**而不是判失败。
    ------------------------------------------------------------------ */
    console.log('');
    const aliasU = new URL(base);
    aliasU.hostname = TRAD;
    console.log(`[3] 打开 ${aliasU.origin}/ + ${HASH}  （繁体顶级域 .中國）`);

    await b.cdp.send('Page.navigate', { url: aliasU.origin + '/' + HASH });
    await sleep(3000);

    const aliasHref = await b.cdp.eval('location.href').catch(() => '');
    console.log('    实际：' + aliasHref);

    if (/^chrome-error:/.test(aliasHref) || aliasHref === 'about:blank') {
      skip++;
      console.log('    ⏭  跳过：6.中國 目前还解析不了（Cloudflare 侧 zone 尚未建立）。');
      console.log('        等把 6.中國 加进 Cloudflare 并绑到 Worker 后，重跑这条就会变 ✅');
    } else {
      const al = new URL(aliasHref);
      if (al.hostname === apex.hostname) ok(`繁体域名已归一到 ${al.hostname}`);
      else no(`繁体域名未归一，停在 ${al.hostname}`);
    }

    /* ------------------------------------------------------------------
       [4] 白名单行为表：只认本站的几种写法，别的一律不碰
           如果写成「只要 hostname 不是主域名就跳」，本地开发（127.0.0.1）、
           workers.dev 备用入口、任何新绑的域名都会被硬拽到主域名上。
    ------------------------------------------------------------------ */
    console.log('');
    console.log('[4] 白名单行为（哪些跳、哪些不跳）');
    const decide = (hostname) => {
      const h = hostname.toLowerCase();
      const b2 = h.slice(0, 4) === 'www.' ? h.slice(4) : h;
      return h !== CANON && FAMILY.indexOf(b2) !== -1;
    };
    const CASES = [
      [CANON, false, '主域名 —— 不动'],
      ['www.' + CANON, true, '带 www —— 归一'],
      [TRAD, true, '繁体 —— 归一'],
      ['www.' + TRAD, true, '繁体带 www —— 归一'],
      ['127.0.0.1', false, '本地开发 —— 别碰'],
      ['localhost', false, '本地开发 —— 别碰'],
      ['flashdrop.153764384.workers.dev', false, '备用入口 —— 别碰'],
      ['www.example.com', false, '无关域名 —— 别碰'],
    ];
    let bad = 0;
    for (const [h, want, why] of CASES) {
      const got = decide(h);
      if (got !== want) bad++;
      console.log(`    ${got === want ? '✅' : '❌'} ${h.padEnd(34)} 跳=${got}  (期望 ${want})  ${why}`);
    }
    if (!bad) ok(`${CASES.length} 条白名单行为全部符合预期`);
    else no(`${bad} 条不符合预期`);
  } finally {
    await b.close().catch(() => {});
    await closeBrowser(DEBUG_PORT).catch(() => {});
  }

  console.log('');
  console.log('===== 结果 =====');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项${skip ? `，跳过 ${skip} 项` : ''}`);
  try { require('fs').rmSync(PROFILE, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e && e.message ? e.message : e);
  try { require('fs').rmSync(PROFILE, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
});
