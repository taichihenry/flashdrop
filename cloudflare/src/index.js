'use strict';
/**
 * FlashDrop · Cloudflare Workers 入口
 * ===========================================================================
 * 路由分工（这个划分是刻意的，直接决定账单）：
 *
 *   /            静态资源  → 交给 Assets 处理，**不进 Worker**，不计费
 *   /app.js 等   静态资源  → 同上
 *   /ws          WebSocket → SignalRoom（Durable Object，全局单实例）
 *   /api/info    环境探测  → Worker 直接答
 *   /turn-credentials      → TurnBudget（Durable Object，额度闸门）
 *
 * 静态资源不经过 Worker 是 Workers Static Assets 的默认行为（assets 优先匹配），
 * 所以只有信令和 TURN 这两条真正需要动态逻辑的路径才会消耗 Workers 请求额度。
 *
 * 部署：cloudflare/ 目录下 `npx wrangler deploy`
 */

import { SignalRoom } from './room.js';
import { TurnBudget } from './turn.js';

export { SignalRoom, TurnBudget };

/**
 * 把域名的各种写法收归到一个规范形式（返回 null 表示本来就是规范的）。
 *
 * 为什么要做：本站的状态（设备名、配对记忆）存在浏览器里，而 localStorage /
 * IndexedDB **按 origin 隔离** —— 在 `www.6.中国` 改好设备名，换成 `6.中国`
 * 打开就变回默认值；简体 / 繁体同理。
 * （前端 public/www-redirect.js 里有一份等价的浏览器版，那是给本地 Node 版
 *   用的：Node 版没有 Worker 这层，只能靠页面自己跳。两边规则必须保持一致。）
 *
 * ⚠ 国际化域名在这里有坑：`new URL(...).hostname` 返回 punycode 还是 Unicode
 *   属于实现细节（Workers 与浏览器不一定一致）。所以两个后缀**都要判** ——
 *   只写 punycode 的话，一旦运行时给的是 `6.中國` 就会静默不跳转：
 *   不报错、看着也正常，只是繁体用户被分到了另一个 origin。
 *
 * @returns {string|null} 需要跳转时返回目标主机名，否则 null
 */
function normalizeHost(host) {
  const lower = host.toLowerCase();
  let h = lower;
  if (h.startsWith('www.')) h = h.slice(4);
  h = h
    .replace(/\.xn--fiqz9s$/, '.xn--fiqs8s')   // 繁體 .中國 → 简体 .中国
    .replace(/\.中國$/, '.中国');
  return h === lower ? null : h;
}

/**
 * 这个请求是不是**真的经过了 Cloudflare 边缘**？
 *
 * ⚠ 判别「本地」不能用 `url.hostname` / `Host` 头 —— 这里真踩过：
 *   `wrangler dev` 会把请求**伪装成生产域名**（因为 wrangler.toml 的 routes
 *   绑了 `6.xn--fiqs8s`）。本地访问 127.0.0.1:8787 时，`request.url` 是
 *   `http://6.xn--fiqs8s/`、`Host` 头也是它，**端口还被抹掉了** ——
 *   单看 URL 根本分不出本地还是线上。
 *
 * ⚠ 也**不能用 `cf-connecting-ip`** —— 本地 dev 会把它设成 `127.0.0.1`
 *   （RoomTalk 那边第一版就栽在这上面，本地请求全被 301 走、e2e 直接跑不了）。
 *
 * 可用的判别：下面这三个头**只有边缘才会注入**。本地实测的完整头列表是
 *   accept / accept-encoding / cf-connecting-ip / host /
 *   mf-original-hostname / user-agent
 * —— 三个都不在其中。多列两个是留冗余：将来某个头被改掉时，不至于整条规则
 * 静默失效（那是这类需求最不想遇到的一类 bug）。
 */
function cameFromEdge(request) {
  const h = request.headers;
  return !!(h.get('cf-ray') || h.get('cf-visitor') || h.get('x-forwarded-proto'));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* ---------------------- 协议与域名一次性归一 ----------------------
     * 目标：把「协议」和「域名写法」一起收归到唯一形式 —— https + 简体裸域。
     *
     * 为什么 http 必须 301 走，而不能照常返回页面：
     *
     *   ① 本站最核心的两个能力都**只存在于安全上下文**（https 或 localhost）：
     *        · P2P 直传的加密握手 → crypto.subtle（见 public/net.js 的派生密钥）
     *        · 点对点数据通道     → RTCPeerConnection
     *      停在 http 时浏览器会把 P2P 整体禁掉，只能退化走服务器中继（慢很多），
     *      页面上会弹出「浏览器已禁用 P2P 直传」那条提示 —— 也就是说 http 下
     *      这个站点是**残废的**，不是「凑合能用」。对传文件的站点来说，
     *      慢一档就是不能用。
     *
     *   ② 手机浏览器手输裸域名时默认补 `http://`，而 HSTS 只在 **https 响应**
     *      上生效（规范要求浏览器忽略 http 响应里的 HSTS —— Cloudflare 即使
     *      在 http 响应里带了那个头也没用）。所以用户的「第一次」永远落在 http，
     *      HSTS 只能管「来过一次之后」。服务端 301 才能管「第一次」——
     *      这正是「每次都得手动把 http 改成 https」的根因。
     *
     * 只在**经过边缘**的请求上做（见 cameFromEdge）：本地 `wrangler dev` 会把
     * 请求伪装成 `http://6.xn--fiqs8s/`，不加这道闸本地开发会被全线跳走。
     *
     * 覆盖范围：wrangler.toml 里 `run_worker_first = ["/", "/index.html"]`，
     * 所以这条规则对**页面请求**必然生效（就是用户在地址栏敲的那个）；静态资源
     * 本身直连 Assets 不走 Worker（省计费），但页面被跳到 https 后，子资源自然
     * 也是 https。想在边缘把**所有路径**（含静态资源）都兜住，可另开 Cloudflare
     * Zone 的「Always Use HTTPS」—— 那是边缘动作，在 Worker 之前执行、零代码、
     * 也不额外计费，推荐和这层一起开（互为保险）。
     */
    const insecure = cameFromEdge(request) && url.protocol === 'http:';
    const canonical = normalizeHost(url.hostname.toLowerCase());
    if (insecure || canonical) {
      return Response.redirect('https://' + (canonical || url.hostname) + url.pathname + url.search, 301);
    }

    /* ----------------------- 信令（WebSocket） ----------------------- */
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('需要 WebSocket 升级请求', {
          status: 426,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
      // 全局单一实例：房间表在它内存里，与 Node 版协议完全一致
      const id = env.SIGNAL.idFromName('global');
      return env.SIGNAL.get(id).fetch(request);
    }

    /* -------------------------- 环境探测 -------------------------- */
    if (url.pathname === '/api/info') {
      return json({
        // 公网部署：没有"局域网地址"这回事，二维码直接指向当前站点
        mode: 'public',
        lanUrls: [],
        publicUrl: '',   // 留空即代表"用当前站点"，前端会退回 location.origin
        wsPath: '/ws',
        wsRelay: env.WS_RELAY !== 'off',
        turn: !!(env.TURN_KEY_ID && env.TURN_KEY_SECRET),
      });
    }

    /* ------------------------ TURN 凭证（带闸门） ------------------------ */
    if (url.pathname === '/turn-credentials') {
      const id = env.BUDGET.idFromName('global');
      return env.BUDGET.get(id).fetch(request);
    }

    /* ---------------------------- 静态资源 ---------------------------- */
    return env.ASSETS.fetch(request);
  },
};
