'use strict';
/* ===========================================================================
   FlashDrop · Worker 入口「协议 + 域名归一」离线测试
   ---------------------------------------------------------------------------
   只测 src/index.js 里 fetch() 最前面那段路由决策，不碰 DO、不碰网络。
   把 env.ASSETS.fetch 换成替身 —— 它一旦被调用，就说明这个请求
   **没有被重定向**，而是直落静态资源。

   这条规则修的是真实痛点（和 RoomTalk 那边是同一个病）：
     手机浏览器手输裸域名时默认补 `http://`，桌面浏览器走 HTTPS-First 所以
     没这问题。而 http 下 crypto.subtle 与 RTCPeerConnection 都被浏览器禁掉
     （不是安全上下文）—— FlashDrop 只能退化走服务器中继，传文件慢一档。
     HSTS 救不了第一次（规范要求浏览器忽略 http 响应里的 HSTS），服务端 301 才能。

   ⚠ 为什么要分「边缘 / 本地」两组：
     `wrangler dev` 会把请求伪装成 `http://6.xn--fiqs8s/`（routes 里绑了它），
     所以 Worker 看不到 127.0.0.1，也没法靠 hostname 分辨本地还是线上。
     判别依据是**只有边缘才注入的请求头**（cf-ray 等）。
     这里用注入头来分别模拟两种环境 —— 第 4 节锁的就是「本地别被跳走」，
     那是这套逻辑最容易翻车的地方（RoomTalk 那边真翻过一次）。

   运行：node cloudflare/test/redirect.js   （在 cloudflare/ 目录下：node test/redirect.js）
   =========================================================================== */

const { default: worker } = await import('../src/index.js');

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('   \u2713 ' + name); }
  else { fail++; console.log('   \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/** 模拟「经过 Cloudflare 边缘」的请求头：只有边缘才注入，线上必带。 */
const EDGE_HEADERS = { 'cf-ray': 'a46d49bc3824868e-SEA', 'cf-visitor': '{"scheme":"http"}' };

/**
 * 模拟本地 `wrangler dev` 实测到的**完整**头集合。
 * ⚠ 里面**有 `cf-connecting-ip`（值为 127.0.0.1）** —— 把它当成边缘标记
 *   是这套判别的头号陷阱（RoomTalk 第一版就栽在这，本地全被 301 走、
 *   e2e 直接跑不了）。这一组存在的意义就是把这个坑钉死。
 */
const LOCAL_HEADERS = {
  'cf-connecting-ip': '127.0.0.1',
  'mf-original-hostname': '6.xn--fiqs8s',
};

const ASSETS_STUB = { ASSETS: { fetch: async () => new Response('ASSET', { status: 200 }) } };

/**
 * 跑一次 Worker，返回 { status, location, served, body }。
 *   served=true 表示请求直落 Assets（即「没有被重定向」）。
 * @param {string} rawUrl
 * @param {{edge?: boolean}} [opts] edge=true 模拟线上，否则模拟本地 wrangler dev
 */
async function probe(rawUrl, opts = {}) {
  const init = { headers: opts.edge ? EDGE_HEADERS : LOCAL_HEADERS };
  const res = await worker.fetch(new Request(rawUrl, init), ASSETS_STUB);
  const location = res.headers.get('location');
  let served = false;
  if (res.status === 200) served = (await res.text()) === 'ASSET';
  return { status: res.status, location, served };
}

const CANON = 'https://6.xn--fiqs8s';   // 6.中国 的 punycode 写法

/* ------------------ 1. 核心：线上收到裸 http → 301 到 https ------------------ */
section('1. 线上 http 请求 → 301 到 https（修「每次要手改地址」）');
{
  const r = await probe('http://6.中国/', { edge: true });
  check('http 首页被 301', r.status === 301, r);
  check('跳转目标是 https', (r.location || '').startsWith('https://'), r.location);
  check('落到规范域名 + 保留路径', r.location === CANON + '/', r.location);
  check('没有被当作静态资源直接送出', r.served === false, r);

  // 301（而不是 302）很关键：浏览器会把它记下来，下次连试都不试 http
  const r2 = await probe('http://6.中国/app.js', { edge: true });
  check('静态资源路径同样 301 且保留路径', r2.status === 301 && r2.location === CANON + '/app.js', r2);
  const r3 = await probe('http://6.中国/?a=1&b=2', { edge: true });
  check('query string 不丢', r3.location === CANON + '/?a=1&b=2', r3);
  // 配对链接是 https://6.中国/#pair=123456 这种形式，但 hash 不上行（服务端看不到），
  // 所以这里只需保证 path + query 原样带过去，hash 由浏览器自己保留。
  const r4 = await probe('http://flashdrop.153764384.workers.dev/', { edge: true });
  check('workers.dev 备用入口在 http 下也要跳（否则用户停在残废页）',
    r4.status === 301 && r4.location === 'https://flashdrop.153764384.workers.dev/', r4);
}

/* ------------- 2. 线上：www / 繁体 → 一步到位（https + 裸域） ------------- */
section('2. 线上 www / 繁体域名 → 一步跳到 https 简体裸域（不出现两跳）');
{
  const cases = [
    ['http://www.6.中国/', 'http + www'],
    ['https://www.6.中国/', 'https + www'],
    ['http://6.中國/', 'http + 繁体'],
    ['https://6.中國/', 'https + 繁体'],
    ['http://www.6.中國/', 'http + www + 繁体'],
  ];
  for (const [u, label] of cases) {
    const r = await probe(u, { edge: true });
    check(`${label} → ${CANON}/`, r.status === 301 && r.location === CANON + '/', r);
  }
}

/* ------------------ 3. 线上：已规范就不该被干扰 ------------------ */
section('3. 线上已是 https 规范域名 → 原样放行');
{
  const r = await probe('https://6.中国/', { edge: true });
  check('https 首页不跳转，直落 Assets', r.status === 200 && r.served === true, r);
  const w = await probe('https://6.中国/ws', { edge: true });
  check('/ws 仍走信令分支（无 Upgrade 头应得 426，而不是 301）', w.status === 426, w);
  const i = await probe('https://6.中国/api/info', { edge: true });
  check('/api/info 仍是 200 JSON（不被误跳）', i.status === 200, i);
  const d = await probe('https://flashdrop.153764384.workers.dev/', { edge: true });
  check('workers.dev 在 https 下不跳转', d.status === 200 && d.served === true, d);
}

/* -------- 4. 本地 wrangler dev 必须豁免（最易翻车的一节） -------- */
section('4. 本地 wrangler dev（无边缘头）不被跳走 —— 否则本地开发全断');
{
  // 关键：wrangler dev 会把 URL 伪装成生产域名，所以这里就用生产域名来测
  for (const u of [
    'http://6.xn--fiqs8s/',
    'http://6.xn--fiqs8s/app.js',
    'http://127.0.0.1:8787/',
    'http://localhost:8787/',
  ]) {
    const r = await probe(u);   // 带的是本地那套头
    check(`${u} 不被强制跳 https`, r.status !== 301, r);
  }

  // 但要分清两件事：**协议**归一要避开本地，**域名**归一不该避开 ——
  // 后者和边缘无关（本地 dev 不会请求 www，但规则必须一致，否则两边行为漂移）。
  const w = await probe('http://www.6.xn--fiqs8s/', { edge: false });
  check('本地请求 www 形态仍然归一（协议不跳、域名照跳）',
    w.status === 301 && w.location === 'https://6.xn--fiqs8s/', w);

  // 单独钉死那个坑：只有 cf-connecting-ip 绝不能被当成「在边缘」
  const onlyCip = new Request('http://6.xn--fiqs8s/', { headers: { 'cf-connecting-ip': '127.0.0.1' } });
  const r = await worker.fetch(onlyCip, ASSETS_STUB);
  check('只带 cf-connecting-ip 时不得判定为边缘（wrangler dev 会设它）', r.status !== 301, r.status);
}

/* ------------------------------ 结果 ------------------------------ */
console.log('\n' + '-'.repeat(56));
console.log(`  ${pass} 通过 / ${fail} 失败`);
console.log('-'.repeat(56) + '\n');
process.exit(fail ? 1 : 0);
