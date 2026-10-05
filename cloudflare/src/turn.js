'use strict';
/**
 * Cloudflare TURN 凭证签发 + 额度闸门（Durable Object）
 * ===========================================================================
 * 为什么需要一个闸门：Cloudflare TURN 没有硬性封顶，超了就是超了，只会给你发
 * 邮件提醒（官方原话：Budget alerts are informational only. They do not pause
 * or cap usage）。想做到「绝不付费」，唯一靠得住的办法是**自己攥住签发权** ——
 * 凭证是你用自己的 TURN key 换出来的，发不发由你决定。
 *
 * 计量口径（不需要真的去读用量报表）：
 *   Cloudflare 对单条 allocation 有硬带宽上限（约 50–100 Mbps），所以
 *   单张凭证的理论最坏用量 = TTL × 100 Mbps。
 *   TTL 600s → 600 × 100e6 / 8 / 1e9 = 7.5 GB。悲观到底也就这么多，超不了。
 *   于是「本月已签发张数 × 7.5GB」就是一个月用量的上界，够用了。
 *
 * 另一条铁律：**TTL 绝不能给长**。给 48 小时的话单张最坏 2.16 TB，
 * 一张就能把 1000 GB 免费额度冲穿。
 *
 * 额度用尽时的行为：返回 budgetExhausted + 只给 STUN。
 * 前端拿到这个会退回 WebSocket 中继（方案 A），功能不中断，只是速度慢些。
 */

/** 免费额度 1000 GB，留 100 GB 余量，别贴着上限跑。 */
const DEFAULT_BUDGET_GB = 900;

/** 凭证 TTL（秒）。10 分钟 —— 单张最坏 7.5 GB，且足够覆盖一次大文件传输。 */
const CRED_TTL_SECONDS = 600;

const WORST_GB_PER_CRED = (CRED_TTL_SECONDS * 100 * 1e6) / 8 / 1e9;   // = 7.5

const CF_TURN_ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys';

/**
 * 补上 443 端口的 TLS 候选。
 *
 * 为什么必须做：跨地域、跨网络最难过的一关不是距离，而是**严格防火墙**——
 * 酒店、企业、校园网、部分运营商的移动网络只放行 443/80，3478(UDP/TCP) 和
 * 5349(TLS) 一律丢包。这时候如果只给默认端口，用户会一直卡在"正在连接"。
 * `turns:...:443?transport=tcp` 走的是标准 TLS，和浏览器访问网页用的是同一个
 * 端口，几乎不会被拦 —— 这是跨网络场景下最值钱的一条候选。
 *
 * 只补 443，不动其它；已有的不重复添加。
 */
function withFallbackPorts(urls) {
  const out = urls.slice();
  const hosts = new Set();
  for (const u of urls) {
    const m = /^(turns?):([^:?]+)/.exec(u);
    if (m && !out.some((x) => x.includes(':' + 443))) hosts.add(m[2]);
  }
  for (const h of hosts) {
    const candidate = `turns:${h}:443?transport=tcp`;
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
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

export class TurnBudget {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch() {
    const keyId = this.env.TURN_KEY_ID;
    const keySecret = this.env.TURN_KEY_SECRET;

    // 没配 TURN：直接告诉前端「只有 STUN」，前端会走 WS 中继兜底
    if (!keyId || !keySecret) {
      return json({ ok: false, configured: false, budgetExhausted: true, iceServers: [] });
    }

    const budgetGb = Number(this.env.TURN_MONTHLY_BUDGET_GB) || DEFAULT_BUDGET_GB;
    const month = new Date().toISOString().slice(0, 7);   // YYYY-MM
    const storageKey = `used:${month}`;

    const used = Number(await this.ctx.storage.get(storageKey)) || 0;

    // 先记账再签发：宁可偶尔少发一张，也不要并发下超发
    if (used + WORST_GB_PER_CRED > budgetGb) {
      return json({
        ok: true,
        budgetExhausted: true,
        usedGb: Number(used.toFixed(1)),
        budgetGb,
        iceServers: [],
      });
    }

    let data;
    try {
      const r = await fetch(`${CF_TURN_ENDPOINT}/${keyId}/credentials/generate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keySecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: CRED_TTL_SECONDS }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        return json({ ok: false, error: `TURN 签发失败 (${r.status})`, detail: text.slice(0, 200) }, 502);
      }
      data = await r.json();
    } catch (e) {
      return json({ ok: false, error: 'TURN 签发请求异常: ' + e.message }, 502);
    }

    await this.ctx.storage.put(storageKey, used + WORST_GB_PER_CRED);

    // 每月 1 号把上个月的计数器回收掉（顺手清，不额外起 alarm）
    const prevMonth = new Date(Date.now() - 32 * 24 * 3600 * 1000).toISOString().slice(0, 7);
    if (prevMonth !== month) {
      try { await this.ctx.storage.delete(`used:${prevMonth}`); } catch { /* noop */ }
    }

    const s = data && data.iceServers;
    if (!s) return json({ ok: false, error: 'TURN 返回格式异常', iceServers: [] }, 502);

    // 端口 53 在 Chrome / Firefox 里是被封的，留着只会拖慢 ICE
    let urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => u && !u.includes(':53'));

    urls = withFallbackPorts(urls);

    return json({
      ok: true,
      budgetExhausted: false,
      ttlSeconds: CRED_TTL_SECONDS,
      iceServers: {
        urls,
        username: s.username,
        credential: s.credential,
      },
    });
  }
}
