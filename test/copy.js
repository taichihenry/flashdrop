/**
 * 落地页文案回归：守住「任意终端 · 任意网络」这个定位
 * ---------------------------------------------------------------------------
 * 老板指出过两处文案问题：
 *   1) 首页写着「手机连上同一个 Wi-Fi」—— 跨网络的用户会以为用不了；
 *   2) README 只提「手机 ⇄ 电脑」—— 看起来手机之间不能传。
 *
 * 功能其实早就支持任意终端 / 任意网络（见 mobile.js、mobile-crossnet.js），
 * 问题出在**文案没跟上功能**。这个测试把「文案不能退回局域网时代」固化成断言。
 *
 * 覆盖三块：
 *   A. 静态 HTML 的默认文案 —— 首屏就生效，不依赖 JS，最容易被漏掉
 *   B. 本地版（Node）—— 应该额外补一条「自签证书不受信任」的提示
 *   C. 公网版（模拟 Cloudflare）—— 不该出现证书提示，且跨网络说明要在
 *
 * 跑法：
 *   node run.js --port 18766 --no-tls
 *   BASE=http://127.0.0.1:18766 node test/copy.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, waitFor, tempProfile, findChrome } = require('./lib');

const BASE = process.env.BASE || 'http://127.0.0.1:18766';
const CHROME = findChrome();
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log(`  ✅ ${name}${extra ? '   ' + extra : ''}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? '   → ' + extra : ''}`); }
}

/**
 * 公网版仿真：把 /api/info 换成 Cloudflare 那套返回（mode='public'）。
 * 必须在页面脚本执行前注入，否则 app.js 已经拿真实响应渲染完了。
 */
const MOCK_PUBLIC = `
  (() => {
    const raw = window.fetch;
    window.fetch = function (input) {
      const url = typeof input === 'string' ? input : ((input && input.url) || '');
      if (url.indexOf('/api/info') >= 0) {
        return Promise.resolve(new Response(
          JSON.stringify({ mode: 'public', lanUrls: [], wsPath: '/ws' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ));
      }
      return raw.apply(this, arguments);
    };
  })();
`;

const text = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const strip = (s) => String(s || '').replace(/<[^>]+>/g, '');

(async () => {
  console.log('\n落地页文案回归（任意终端 · 任意网络）\n');

  // ============ A. 静态 HTML 的默认文案 ============
  console.log('[A] 静态 HTML 默认文案（首屏生效，不依赖 JS）');
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const lead = (/<p class="lead" id="connect-lead">([\s\S]*?)<\/p>/.exec(html) || [])[1] || '';
  const steps = (/<ol class="steps" id="connect-steps">([\s\S]*?)<\/ol>/.exec(html) || [])[1] || '';

  check('默认文案不再要求「连上同一个 Wi-Fi」',
    !/同一个\s*Wi-?Fi/i.test(lead) && !/连上\s*同一个/.test(lead),
    strip(lead).slice(0, 44));

  check('默认文案点名「手机、电脑、平板都行」',
    /手机/.test(lead) && /电脑/.test(lead) && /平板/.test(lead));

  check('默认引导写明「不同网络」用配对码',
    /配对/.test(steps) && /不同.{0,4}网络|跨网络/.test(steps));

  check('引导标题不再只提「手机」扫这个码',
    !/用手机扫/.test(html));

  check('页面标题不再自称「局域网互传」',
    !/局域网互传/.test(html));

  const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8'));
  check('PWA 描述不再限定「同一 Wi-Fi」',
    !/同一个?\s*Wi-?Fi/i.test(mf.description), text(mf.description).slice(0, 46));
  check('PWA 名称不再自称「局域网互传」',
    !/局域网互传/.test(mf.name), mf.name);

  // ============ B. 本地版（Node） ============
  console.log('\n[B] 本地版（Node 自签证书）');
  const local = await launch({
    label: '本地版', url: BASE + '/', port: 18901,
    profileDir: tempProfile('fd-copy-local'), chrome: CHROME, headless: true,
  });
  try {
    const stepText = text(await local.cdp.eval(`document.getElementById('connect-steps').textContent`));
    const leadText = text(await local.cdp.eval(`document.getElementById('connect-lead').textContent`));

    check('补上「证书不受信任」这一步（自签证书特有）',
      /证书不受信任/.test(stepText));
    check('跨网络配对说明仍在',
      /配对/.test(stepText) && /跨网络/.test(stepText));
    check('首屏文案对本地版同样成立（不要求同一 Wi-Fi）',
      !/同一个\s*Wi-?Fi/i.test(leadText), leadText.slice(0, 44));
    check('证书提示只插了一条（幂等保护生效）',
      (stepText.match(/证书不受信任/g) || []).length === 1);

    const n = await local.cdp.eval(`document.getElementById('connect-steps').children.length`);
    check('本地版共 4 步（1 步证书 + 3 步通用）', n === 4, `实际 ${n} 步`);
  } finally {
    await local.close();
  }

  // ============ C. 公网版（模拟 Cloudflare） ============
  console.log('\n[C] 公网版（模拟 mode=public）');
  const pub = await launch({
    label: '公网版', url: BASE + '/', port: 18902,
    profileDir: tempProfile('fd-copy-public'), chrome: CHROME, headless: true,
  });
  try {
    await pub.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_PUBLIC });
    await pub.cdp.send('Page.reload');
    await waitFor('公网版识别到 mode=public', async () => {
      try {
        return await pub.cdp.eval(
          `!!(window.__fd && window.__fd.state.serverInfo && window.__fd.state.serverInfo.mode === 'public')`
        );
      } catch { return false; }
    }, 25000, 250);

    const stepText = text(await pub.cdp.eval(`document.getElementById('connect-steps').textContent`));
    const n = await pub.cdp.eval(`document.getElementById('connect-steps').children.length`);

    check('公网版不出现「证书不受信任」（云上没这回事）',
      !/证书不受信任/.test(stepText));
    check('公网版仍写明跨网络用配对码',
      /配对/.test(stepText) && /跨网络/.test(stepText));
    check('公网版共 3 步（无证书提示）', n === 3, `实际 ${n} 步`);
  } finally {
    await pub.close();
  }

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试异常终止：', e && e.message);
  process.exit(1);
});
