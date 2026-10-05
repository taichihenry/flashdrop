# 公网部署 & TURN 额度控制

本文回答两件事：**公网发布时为什么不用 `start-flashdrop.bat`**，以及**怎么保证 Cloudflare TURN 不产生费用**。

---

## 一、`.bat` 是"局域网模式"的入口，不是发布方式

`start-flashdrop.bat` 干的事只有一件：在你本机把 `node run.js` 跑起来，顺便探测局域网 IP、打印访问地址、生成自签证书。

**它和"公网发布"是两条不同的路**，区别在于**谁来扮演"服务器"这个角色**：

| 模式 | 服务器是谁 | 怎么起 | HTTPS | 适合 |
|---|---|---|---|---|
| **局域网自用** | 你自己的电脑 | 双击 `.bat` | 自签（浏览器要手动信任一次） | 自己 / 同事，同一 Wi-Fi |
| **公网（自己跑 Node）** | 一台 24 小时开机的云主机 | `systemd` / `pm2` 常驻 | 真证书（Caddy / Let's Encrypt） | 给全网用户 |
| **公网（全 Cloudflare）** | Cloudflare Workers + Durable Objects | `wrangler deploy` | Pages 自带 | 免费、无冷启动 |

关键点：**第二种模式用的还是同一个 `server.js`**，只是不该由你双击启动，而应该部署到常驻主机上由进程管理器拉起。

**为什么不能没有服务器？** 因为信令绕不过去——两台设备在知道对方地址之前，必须先有个双方都能访问的中转点帮它们交换 SDP / ICE。这就是后端，纯静态做不到。

**为什么不能"用户打开网页就自动跑起来"？** 浏览器里的 JS 只能连服务器，没法凭空造一个服务器出来。`pairdrop.net` 之所以看起来"什么都不用管"，是因为作者自费在一台机器上常年跑着那个 Node 进程。

---

## 二、公网部署必做清单

缺哪一条都会出问题，按严重程度排：

### 1. 反代必须透传真实客户端 IP ⚠️ 最容易出安全事故

本服务靠"客户端 IP"自动分房（私网按 `/24`、公网按整段）。挂在反代后面时，`socket.remoteAddress` 全是 `127.0.0.1`，**所有访客会被塞进同一间房，互相可见**。

```bash
# 部署时打开（代码会优先读 CF-Connecting-IP，其次 X-Forwarded-For）
TRUST_PROXY=1
```

Nginx 侧：
```nginx
location / {
    proxy_pass http://127.0.0.1:8686;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

> 验证方法已实测：伪造 `CF-Connecting-IP` 连三台，同 IP 的两台落进 `wan:198.51.100.10` 能互相看见，不同 IP 的那台落进 `wan:203.0.113.99` 完全隔离。

### 2. HTTPS 用真证书

自签证书在局域网模式下可以（用户点一次"继续访问"），**公网绝对不行**。用 Caddy 最省事，它自动申请并续期：

```
yourdomain.com {
    reverse_proxy 127.0.0.1:8686
}
```

同时设 `NO_TLS=1`，让 Node 只跑 HTTP，TLS 交给 Caddy —— 这也是 PaaS 平台的通用做法。

### 3. 挂 TURN

不挂也能上线，但**约 10–20% 的用户（公司网络、严格 NAT、部分 4G）会永远卡在"正在连接"**。

设置方式（本次已补进 `run.js`）：

```bash
# 自建 coturn 这类静态账号，直接填
TURN_URL=turn:your-turn.example.com:3478?transport=udp
TURN_USERNAME=youruser
TURN_CREDENTIAL=yourpass

# 或者直接给完整 JSON
ICE_SERVERS='[{"urls":"stun:stun.cloudflare.com:3478"},{"urls":"turn:...","username":"u","credential":"c"}]'
```

> ⚠️ **Cloudflare TURN 不能用静态 env**：它的凭证是临时签发的（最长 48 小时），需要动态接口。见下一节。

### 4. 用进程管理器常驻

```bash
# pm2
pm2 start run.js --name flashdrop -- --port 8686
pm2 save && pm2 startup
```

---

## 三、TURN 额度：怎么做到"绝不付费"

### 先看 Cloudflare 的现状（已核对官方文档）

- **价格**：$0.05/GB，每月前 **1000 GB 免费**（SFU 和 TURN 共用这个额度，不是各 1000）
- **计费口径**：**从 Cloudflare 边缘发给 TURN 客户端**的流量（含 TURN 封装开销）；上行入站免费
- **原生封顶**：❌ **没有**。Cloudflare 只有两类提醒，且官方明确写了 "**Budget alerts are informational only. They do not pause or cap usage.**"
  - Budget alerts：账户级美元阈值（Billing → Billable Usage → Create budget alert）
  - Usage notifications：按产品（如 TURN / R2）设指标阈值
- **可用杠杆**：✅ **签发权在你手上**。TURN 凭证由你用 TURN key 调 `POST https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate` 生成，所以"发不发给用户"完全由你决定
- **吊销 API**：`POST .../credentials/revoke` → **计费立即停止**，连接数秒后断开
- **单分配限额**（超出是**静默丢包**，不报错）：50–100 Mbps、5–10k pps、每 5 个新 IP/秒
- **凭证最长 TTL**：48 小时（172800 秒），超过直接被 API 拒绝
- **用量可见延迟**：约 30 秒

### 关键认知：你可以不精确计量，就能给出数学上限

因为**单条 allocation 的带宽被硬限在 100 Mbps**，所以：

> **单张凭证的理论最坏用量 = TTL × 100 Mbps**

| 凭证 TTL | 单张凭证最坏用量 | 1000 GB 最多能发多少张 |
|---|---|---|
| 48 小时 | 2.16 TB（远超额度，危险） | 打不住，**绝对不能这么用** |
| 1 小时 | 45 GB | ~22 张 |
| 10 分钟 | 7.5 GB | ~133 张 |
| 2 分钟 | 1.5 GB | ~680 张 |

**所以第一条铁律：TURN 凭证 TTL 一定要短。** 签发时按"这次会话大概要多久"给，比如 10 分钟，别图省事给 48 小时。

### 三条方案，按"能不能保证零费用"排序

**方案 A · 不接 Cloudflare TURN（保证 $0，推荐先这样上线）**

FlashDrop 自带 WS 中继兜底：P2P 6 秒打不通就退回你自己的服务器转发。这条路**不碰 Cloudflare 计费**，成本变成你自己的服务器出网带宽。

- 优点：账单永远 $0，而且功能是完整的
- 缺点：中继走 TCP over WebSocket，大文件慢；吃你服务器带宽
- 适合：上线初期、用户量不大、或者主要传中小文件

**方案 B · 接 Cloudflare TURN + 自建额度闸门**

用一个接口签发短 TTL 凭证，并在 Durable Object / KV 里记一个"本月已签发凭证数 × 单张最坏用量"，超标就不发 TURN 候选（只给 STUN），前端自动退回方案 A 的中继。

**方案 C · 兜底告警（无论选 A 还是 B 都要做）**

Cloudflare 后台 → Billing → Billable Usage → Create budget alert，阈值填 **$1**，填上你的邮箱。这不是封顶，是"越界报警器"。

### 参考实现：额度闸门（Cloudflare Worker）

```js
// wrangler.toml 里配：TURN_KEY_ID / TURN_KEY_SECRET（secret）/ BUDGET_KV
const MONTHLY_BUDGET_GB = 900;      // 留 100GB 余量，别卡着 1000 用
const CRED_TTL_SECONDS = 600;       // 10 分钟 → 单张最坏 7.5GB
const WORST_GB_PER_CRED = (CRED_TTL_SECONDS * 100 * 1e6) / 8 / 1e9;

export default {
  async fetch(req, env) {
    if (new URL(req.url).pathname !== '/turn-credentials') {
      return new Response('not found', { status: 404 });
    }

    const month = new Date().toISOString().slice(0, 7);
    const used = Number(await env.BUDGET_KV.get(`used:${month}`)) || 0;

    // 额度用尽 → 只给 STUN，客户端会自动退回 WS 中继
    if (used + WORST_GB_PER_CRED > MONTHLY_BUDGET_GB) {
      return Response.json({
        budgetExhausted: true,
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
      });
    }

    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: CRED_TTL_SECONDS }),
      }
    );
    if (!r.ok) return Response.json({ iceServers: [] }, { status: 502 });
    const data = await r.json();

    await env.BUDGET_KV.put(`used:${month}`, String(used + WORST_GB_PER_CRED), {
      expirationTtl: 60 * 60 * 24 * 40,
    });

    // 端口 53 在 Chrome/Firefox 里是被封的，必须过滤掉
    const urls = (data.iceServers.urls || []).filter((u) => !u.includes(':53'));
    return Response.json({ iceServers: { ...data.iceServers, urls } });
  },
};
```

**接入 FlashDrop 的位置**：`server.js` 的 `_onConnection()` 现在是同步下发 `conf.iceServers`。要接动态凭证，把它改成"连上后异步取一次凭证再下发 `self` 消息"，或在客户端 P2P 失败降级前临时向 `/turn-credentials` 要一次。前者改动更小。

### 额度够不够用？大概的账

按方案 B 的 10 分钟 TTL 算，最坏情况能撑 ~133 次中继会话/月；但这是"每次都跑满 100 Mbps 满 10 分钟"的极端值，实际远低于此。

更贴近现实的估算：只要**中继会话占比低**（P2P 直连成功率通常 80–90%），且平均单次中继传几十 MB，1000 GB 大致对应**上万次中继会话**。

> 计费口径只明确"边缘→客户端"方向收费。一次两端都走中继的传输，保守按**文件大小 × 2** 估。上线一周后去 Billable Usage 面板对一次账，把系数校准。

---

## 四、一句话总结

- `.bat` = 局域网自用入口；公网发布要把**同一个 `server.js` 部署到常驻主机**，配 `TRUST_PROXY=1` + 真证书 + TURN
- Cloudflare TURN **没有硬性封顶**，只有告警 → 想保证零费用，要么**先不接 TURN**（走自带 WS 中继），要么**自己签发 + 短 TTL + 计数器**
- 无论哪种方案，都去设一条 **$1 的 Budget alert** 当兜底
