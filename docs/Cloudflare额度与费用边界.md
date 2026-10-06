# Cloudflare 免费额度与费用边界（FlashDrop 上线版）

**一句话结论：这个项目跑在 Cloudflare 免费计划上，超额的后果是「当天的请求失败」，
不是「自动扣费」。唯一会产生真实费用的只有 TURN —— 而项目当前**默认不启用 TURN**，
所以账单在结构上为零。**

> 📌 **本文档的现状标注（2026-10-06）**：`TURN_KEY_ID` / `TURN_KEY_SECRET`
> **未注入**，`/turn-credentials` 返回「未配置」，前端全程走 P2P + WebSocket 中继。
> Realtime 那 1,000 GB/月 的额度**一个字节都没动用**。详见第五节的「默认选择」。

---

## 一、先回答最关心的那句：超了会收费吗？

**不会自动收费。** 免费计划**没有绑定任何付款方式**，Cloudflare 不可能向你收钱。
想花钱必须**你主动去订阅 Workers Paid（$5/月）**，这是一个显式动作，不会自己发生。

超额的真实后果是**服务不可用**，官方原文（Workers Limits）：

> Accounts using the Workers Free plan are subject to a daily request limit of
> 100,000 requests. Free plan daily requests counts reset at midnight UTC.
> A Worker that fails as a result of daily request limit errors can be configured
> by toggling its corresponding route in two modes: **Fail open** and **Fail closed**.
> - **Fail open** — 绕过这个 Worker，请求表现得像没有配置 Worker
> - **Fail closed** — 给访客显示 **Cloudflare 1027 错误页**（Worker 被临时停用）

超额的表现形式就是 **Error 1027**，而不是账单。

---

## 二、这个项目会用到哪些免费额度

| 项目 | 免费额度 | 超了会怎样 |
|---|---|---|
| **Worker 请求** | 100,000 / 天（UTC 0 点重置） | Error 1027 |
| **Worker 突发限流** | 1,000 请求 / 分钟 | Error 1015（限流页） |
| **Worker CPU** | 10 ms / 请求 | 该请求被终止 |
| **Durable Object 请求** | 100,000 / 天 | 调用失败，直到重置 |
| **Durable Object 时长** | 13,000 GB-s / 天 | 同上 |
| **静态资源请求** | **免费且不限量** | —— |
| **Workers Builds**（GitHub 自动构建） | 3,000 构建分钟 / 月 | 构建排队等待，**不扣费** |
| **Realtime STUN** | **免费且不限量** | —— 不计入任何计费额度 |

> 最后一行是关键：**Cloudflare 官方明确写了静态资源的请求在主区和付费区都是免费且无限的**
> （"On both free and paid plans, requests to static assets are free and unlimited"）。
> 这个项目的配置就是冲着这条去的 —— 见下一节。

---

## 三、为什么实际上几乎烧不到 10 万次

这个项目的路由是**刻意分流**的：

```
GET  /                     → Workers Assets 直接返回      ← 不计费
GET  /app.css /app.js      → Assets 直接返回               ← 不计费
GET  /net.js /vendor/*     → Assets 直接返回               ← 不计费
GET  /api/info             → Worker            ← 计 1 次
WS   /ws                   → Worker + DO       ← 计 1 次 Worker + 1 次 DO
POST /turn-credentials     → Worker + DO       ← 只在 P2P 打不通时才发生
```

**打开一次页面 ≈ 2 次 Worker 请求**（`/api/info` + `/ws` 建连）。
页面加载的 CSS / JS / 二维码库全部走静态资源，**一次都不算**。

于是：

```
100,000 请求/天 ÷ 2 ≈ 每天 50,000 次页面打开
```

后续的信号交互（SDP/ICE、文件传输控制）才是 WS 消息，而且
**入站 WebSocket 消息按 20:1 折算成请求**（官方计费口径），一百条消息才折算 5 次。

**结论：10 万次/天对应大约 5 万人次打开页面，初期完全够用。**

DO 的时长额度也不是问题：用了 WebSocket Hibernation 之后，空闲连接**不产生时长费用**，
只有真正收发消息时才计。粗算 10 万次消息处理 ≈ 125 GB-s，而额度是 13,000 GB-s/天。

---

## 四、唯一的例外：Cloudflare TURN（这里是真的要花钱的地方）

TURN 和上面那些不一样，它是**按量计费服务**：

- 单价 **$0.05 / GB**（只算 Cloudflare 出口到 TURN 客户端这一个方向）
- **每月前 1,000 GB 免费**；STUN 是**完全免费且不限量**的，另算
- **没有任何硬性封顶** —— 官方原话：
  *"Budget alerts are informational only. They do not pause or cap usage."*

> ⚠️ **最关键的一条，也是"要不要开"的决策点**：
> 开通 Realtime TURN 的免费套餐**需要绑定信用卡**（自服务模式就是 "pay with your
> credit card" 的计划）。也就是说 —— **不绑卡就用不了 TURN；一旦绑了卡，
> 风险敞口就打开了**：免费额度以内的部分 Cloudflare 不会收钱，但超出部分会真实扣费。
> 所以「我担心 Cloudflare 收费」这个问题的最优解不是"开 TURN 但把闸门调小"，
> 而是**干脆不开**（见第五节）。

已经做好的三道锁（为"哪天确实要开"准备）：

1. **凭证 TTL 压到 600 秒**。因为 Cloudflare 对单条 allocation 的带宽硬限在约 100 Mbps，
   所以单张凭证的理论最坏用量 = `600 × 100 Mbps ÷ 8 = 7.5 GB`，出厂即封顶。
   （对比：给 48 小时 TTL，单张最坏 2.16 TB —— **一张就能击穿整个免费额度**。）
2. **额度闸门**：`TurnBudget` 这个 Durable Object 记账「本月已签发张数 × 7.5 GB」，
   超过 **900 GB** 就停止签发，只返回 STUN。**记账发生在签发之前**，所以并发下
   也不会超发。
3. **前端自动降级**：拿不到 TURN 凭证时，自动退回 WebSocket 中继（走你自己的 Worker），
   **功能不中断，只是慢**，而且这条路完全不碰 TURN 计费。

> 900 GB 的上限可以在 `cloudflare/wrangler.toml` 里通过
> `TURN_MONTHLY_BUDGET_GB` 调整，改完重新部署即可。真要开的话，建议直接改成 `300`
> 或更低 —— 把最坏情况压到免费额度的三成以内。

**再加上一道人工保险**：Cloudflare 后台 → Billing → Billable Usage →
Create budget alert，阈值填 **$1**，填你的邮箱。这不是封顶（官方说了告警不会停服务），
是"越界报警器"。真出异常流量你能第一时间知道。

---

## 五、默认选择：**不开 TURN**（当前状态）

**选择 A（现行方案）：干脆不开 TURN。**
不配 `TURN_KEY_ID` / `TURN_KEY_SECRET`，`/turn-credentials` 会直接返回「未配置」，
前端走 P2P + WebSocket 中继。账单**结构性为零**（因为压根没有计费服务，也不用绑卡）。

代价比想象中小得多，有两条实测依据：

1. **P2P 打洞能力已经补齐**。原来 Node 版下发给浏览器的 STUN 只有两个 google 地址，
   而 `stun.l.google.com` 在**国内不通** —— 等于国内用户的 P2P 根本没有 STUN。
   现在统一成 `cloudflare → miwifi → google` 三条（cloudflare 的 STUN 免费且不限量、
   不计入任何额度），大量跨网络场景可以直连，压根用不上中继。
2. **WS 中继实测不慢**。`test/relay-fallback.js` 里 6 MB 文件走中继跑到 **15.79 MB/s**。
   小文件、图片、文档场景用户基本感知不到差异。

**选择 B（将来要提速时）：开 TURN，但把闸门收紧。**
把 `TURN_MONTHLY_BUDGET_GB` 设成 `100`～`300`，最坏仍远在 1,000 GB 免费额度内，
只是会更早退到中继。开之前请先确认自己接受"绑卡"这个前置条件。

---

## 六、上线后真正需要盯的两件事

1. **CGNAT 串房**。这跟费用无关，但是上线后最可能被用户投诉的点 ——
   同一个出口 IP 下的陌生人会互相看见设备名。处理方式见
   `docs/上线前检查报告.md` 第 3.1 节（`WAN_ROOM_MODE` 开关）。
2. **中继占比**（只在关心性能时要看）。观察真实用户里有多少比例走了 WebSocket 中继：
   占比高、且用户反馈慢，才是"值得开 TURN"的信号。
   真要开，先回到第四节确认绑卡这条前置条件，再按第五节的「选择 B」收紧闸门。

> 万一哪天开了 TURN：上线一周后去 Billing → Billable Usage 对一次账，
> 看真实消耗是不是远低于闸门估算（大概率是 —— 闸门用的是最坏值，偏保守得多）。
