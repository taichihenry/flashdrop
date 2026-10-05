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
