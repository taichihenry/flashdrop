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
 * ⚠️ 这个开关在**系统配了代理的机器上会完全失效**：走代理时 Chrome 不自己解析域名，
 *   而是把主机名交给代理，于是 host-resolver-rules 被绕开
 *   （表现：参数传了、但请求照样打到真实 DNS，本地测试会超时 30 秒后失败）。
 *   实测踩过一次：`http_proxy` 指向 127.0.0.1:53126，于是 `6.xn--fiqs8s:8986`
 *   被代理解析成 Cloudflare 的真实 IP，连 8986 端口等到超时。
 *   **所以本地模式必须同时传 `--no-proxy-server`**，本地请求本来就不需要代理。
 *   失效本身不危险（等于多传几个无害参数），但反过来要小心：
 *   在无代理的机器上跑**线上**目标时若误传了它，会把所有域名指到 127.0.0.1，
 *   得到一堆 ERR_CONNECTION_REFUSED，而且看不出来是参数导致的。
 *   所以下面 isLocal 的判断必须严格，不能写成一个宽松正则。
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

  // 只有「指向本机的写法」才算是本地跑：127.0.0.1 / localhost，或带自定义端口。
  // 别写成宽松正则 —— 之前写成 /^(...|6\.xn--fiqs8s|...)/ 会把**线上**目标也判成本地，
  // 于是给线上测试挂上 host-resolver-rules，在无代理的机器上会把域名全指到 127.0.0.1。
  const u0 = new URL(base);
  const isLocal = /^(127\.0\.0\.1|localhost)$/.test(u0.hostname) || u0.port !== '';
  const extraArgs = isLocal
    ? ['--no-proxy-server', '--host-resolver-rules=' + [
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
       [1.5] 真实浏览器里跑一遍 http → https
             这就是用户报的原始场景：手机浏览器手输裸域名时默认补 `http://`
             （桌面浏览器走 HTTPS-First，所以只有手机会中招）。
             单纯靠 HSTS 救不了「第一次」—— 规范要求浏览器忽略 http 响应里的
             HSTS，只有服务端 301 才能管第一次。所以这里必须用**显式的 http
             URL** 才能复现，不能靠浏览器自动补全。
             本地自建服务本身就是 http，不该有这一跳 → 本地跑时跳过。
    ------------------------------------------------------------------ */
    console.log('');
    if (isLocal) {
      skip++;
      console.log('[1.5] ⏭  跳过 http → https（本地自建服务本来就是 http，不该跳）');
    } else {
      const httpUrl = 'http://' + apex.hostname + '/' + HASH;
      console.log(`[1.5] 打开 ${httpUrl}`);
      console.log(`      期望：自动落到 ${apex.origin}/ 且已是安全上下文`);

      await b.cdp.send('Page.navigate', { url: httpUrl });

      // 轮询等落定：IDN 域名首次要 DNS + TLS 握手，固定 sleep 会误判
      await waitFor('http 被顶到 https', async () => {
        try { return /^https:/.test(await b.cdp.eval('location.href')); }
        catch { return false; }
      }, 25000, 250).catch(() => {});

      const gotHref = await b.cdp.eval('location.href').catch(() => '');
      console.log('      实际：' + gotHref);

      if (/^https:/.test(gotHref)) ok('http 被 301 到 https（不用用户手改地址）');
      else no(`仍停在非 https：${gotHref}`);

      const secureContext = await b.cdp.eval('window.isSecureContext').catch(() => false);
      if (secureContext === true) ok('isSecureContext = true（crypto.subtle / WebRTC 可用）');
      else no(`isSecureContext = ${secureContext}（P2P 会被浏览器禁掉）`);
    }

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
       [3] 繁体顶级域 .中國 也应归一到主域名（apex 和 www 两种写法都要测）
           前提是先在 Cloudflare 给 6.中國 建 zone 并绑上 Worker。
           没建之前 DNS 解析不了，这里**跳过**而不是判失败。
    ------------------------------------------------------------------ */
    console.log('');
    console.log(`[3] 繁体顶级域 .中國 归一（${HASH}）`);

    // 两种写法都要过：只测 apex 会漏掉「www 形态在繁体 zone 下没绑」的情况
    for (const host of [TRAD, 'www.' + TRAD]) {
      const u = new URL(base);
      u.hostname = host;
      console.log(`    → ${u.origin}/`);

      await b.cdp.send('Page.navigate', { url: u.origin + '/' + HASH });

      // ⚠️ 不能用固定 sleep(3000)：第一次接触一个新 IDN 顶级域时，
      //    DNS + TLS 握手 + 跳转实测要 1~2 秒，偶尔超过 3 秒，
      //    于是「其实跳成功了、只是还没跳完」被误判成失败（真出现过）。
      //    这里必须轮询，等到落定或超时。
      let href = '';
      try {
        await waitFor(`${host} 落定`, async () => {
          href = await b.cdp.eval('location.href');
          // 两种终局：① 已是主域名 ② 明确是个错误页（域名解析不了）
          return (
            (href.indexOf(apex.hostname) !== -1 && href.indexOf(host) === -1) ||
            /^chrome-error/.test(href)
          );
        }, 25000, 200);
      } catch {
        href = await b.cdp.eval('location.href').catch(() => '');
      }
      console.log(`      实际：${href}`);

      if (/^chrome-error:/.test(href) || href === 'about:blank') {
        skip++;
        console.log('      ⏭  跳过：该域名目前还解析不了（Cloudflare 侧 zone / 自定义域尚未建立）。');
        console.log('         等把 6.中國 加进 Cloudflare 并绑到 Worker 后，重跑这条就会变 ✅');
      } else {
        const got = new URL(href);
        if (got.hostname === apex.hostname) ok(`${host} 已归一到 ${got.hostname}`);
        else no(`${host} 未归一，停在 ${got.hostname}`);
      }
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
