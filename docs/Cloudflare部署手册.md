# FlashDrop 上线手册 · Cloudflare + 6.中国

从零到能用，照着做即可。预计 30–45 分钟，其中大部分时间在等 DNS 生效。

---

## 0. 你的域名现在是什么状态（先读这段）

我实际查了 `6.中国` 的 DNS，现状如下：

```
NS   →  h.dns.cn / i.dns.cn / j.dns.cn / k.dns.cn / l.dns.cn   （CNNIC 的权威 DNS）
A    →  216.198.79.1
HTTP →  Server: Vercel，308 跳转到 www.6.xn--fiqs8s
www  →  200 OK，是一个「请使用手机浏览器访问 + 自动拨号」的页面
```

三件事需要你确认，因为它们决定接下来怎么做：

1. **`6.中国` 当前跑在 Vercel 上**，而且当前有个"自动拨号页"在上面。
   把域名迁到 Cloudflare 后，**这个页面会消失**（除非在 Cloudflare 里重建一条
   指向 Vercel 的解析记录）。
2. **域名目前的 DNS 不在 Cloudflare**，在 CNNIC 的 `dns.cn` 上。
3. **要让 `6.中国`（根域名）指向 Cloudflare Workers，必须把整站 NS 改到
   Cloudflare** —— 这是 Cloudflare 的硬性要求，没有绕过的办法：
   - 根域名（`6.中国`）绑 Workers/Pages，官方要求该域名的 zone 必须在你
     自己的 Cloudflare 账号下；
   - 子域名（`www.6.中国`）虽然可以只加一条 CNAME，但**证书会对不上**
     （浏览器请求的是 `www.6.中国`，Cloudflare 那侧只有 `*.workers.dev` 的证书），
     结果就是 HTTPS 直接报错。

   > 中文域名 `.中国`（punycode 写作 `xn--fiqs8s`）能不能改 NS，取决于你当初
   > 在哪家注册。国内大部分注册商是允许改的（域名控制台里找「DNS 修改」
   > 或「修改 DNS 服务器」）。如果找不到这个入口，见文末第 8 节。

**所以在动手之前，先想清楚：Vercel 上那个自动拨号页，是要保留、迁走、还是直接不要了？**

---

## 1. 准备清单

| 需要 | 说明 |
|---|---|
| Cloudflare 账号 | 免费版即可。Workers / Durable Objects / 静态资源全在免费额度内 |
| 域名注册商后台权限 | 最后一步改 NS 要用 |
| Node.js ≥ 18 | 你机器上有（`C:\Users\201\.workbuddy\binaries\node\...`）|
| 项目目录 | `D:\workbuddy\flashdrop\` |

---

## 2. 先在本机跑起来看一眼（可选，2 分钟）

这一步不联网、不花钱，纯本地验证代码没被改坏：

```bash
cd D:/workbuddy/flashdrop/cloudflare
npm test
```

应该看到 **`通过 45 项，失败 0 项`**。这跑的是 Durable Object 的信令逻辑
（分房、转发、配对、休眠重建、越权防护），不需要 Cloudflare 账号。

---

## 3. 登录 Cloudflare

推荐用 **API Token** 而不是浏览器登录 —— 你本机的代理环境对 OAuth 回调
不太友好，Token 方式更稳，出错信息也更清楚。

### 3.1 建一个 Token

1. 打开 <https://dash.cloudflare.com/profile/api-tokens>
2. 点 **Create Token** → 找到模板 **Edit Cloudflare Workers** → **Use template**
3. 权限里确认包含这几项（模板默认就够）：
   - `Account` → `Workers Scripts` → `Edit`
   - `Account` → `Account Settings` → `Read`
   - `Zone` → `Workers Routes` → `Edit`
   - `User` → `User Details` → `Read`
4. **Account Resources** 选你自己的账号，**Zone Resources** 选 `All zones`
   （或先留空，等第 5 步把域名加进来后再补）
5. Create → **把生成的 token 复制下来，只显示一次**

### 3.2 在项目里配好

```bash
cd D:/workbuddy/flashdrop/cloudflare
cp .dev.vars.example .dev.vars      # 本地开发用，别提交
```

然后**不要**把 token 写进任何文件，用环境变量传：

```bash
export CLOUDFLARE_API_TOKEN="你刚才复制的 token"
```

> 如果 wrangler 报网络错误（你本机有代理），补一句：
> `export HTTPS_PROXY=http://127.0.0.1:31181`
> （dev-sidecar 的常驻端口；如果不对，去 dev-sidecar 界面看当前端口）

### 3.3 先来一次"部署彩排"（不用登录、不会真的上线）

**这一步强烈建议做**，几秒钟，能把配置错误挡在真正部署之前：

```bash
cd D:/workbuddy/flashdrop/cloudflare
npx wrangler deploy --dry-run --outdir=/tmp/wbuild
```

**我已经在本机跑过，预期输出是这样的**：

```
✨ Read 10 files from the assets directory D:\workbuddy\flashdrop\public
Total Upload: 17.63 KiB / gzip: 5.92 KiB
Your Worker has access to the following bindings:
Binding                                      Resource
env.SIGNAL (SignalRoom)                      Durable Object
env.BUDGET (TurnBudget)                      Durable Object
env.ASSETS                                   Assets
env.WS_RELAY ("on")                          Environment Variable
env.WAN_ROOM_MODE ("ip")                     Environment Variable
env.TURN_MONTHLY_BUDGET_GB ("900")           Environment Variable
```

这行输出说明三件事都对上了：静态资源目录找得到、两个 Durable Object 类导出正常、
环境变量读到了。**如果这一关过了，真正的 `wrangler deploy` 基本不会出意外。**

---

## 4. 首次部署

```bash
cd D:/workbuddy/flashdrop/cloudflare
npx wrangler deploy
```

第一次会问你是否创建 Durable Object 的迁移，输入 `y` 回车。

成功后终端会打印一个地址，形如：

```
https://flashdrop.<你的子域>.workers.dev
```

**先别急着绑域名，用这个地址验一遍**：

1. 浏览器打开它 → 应该看到 FlashDrop 首页，页脚有联系方式
2. 再用另一台设备（手机也行）打开同一地址
3. 两台设备应该互相「看见」——同一网络下会自动发现；
   不在同一网络就点顶部「配对」，输 6 位码

如果这一步就通了，后面的域名和 TURN 只是锦上添花。

> **想看实时日志**：另开一个终端跑 `npx wrangler tail`。

---

## 5. 把 `6.中国` 接过来

### 5.1 在 Cloudflare 添加站点

1. <https://dash.cloudflare.com> → **Add a domain**
2. 输入域名。中文域名直接输 `6.中国` 即可，如果输入框不接受，
   就输 punycode 形式：**`6.xn--fiqs8s`**
3. 套餐选 **Free** → Continue
4. Cloudflare 会扫描现有 DNS 记录。这里**先看一眼有没有那个拨号页相关的记录**，
   需要保留的话记住它（后面要手动重建）
5. 继续 → Cloudflare 给你两条 NS，形如：
   ```
   xxx.ns.cloudflare.com
   yyy.ns.cloudflare.com
   ```
   **把这两条记下来。**

### 5.2 去注册商改 NS

登录你注册 `6.中国` 的地方 → 找到该域名的管理页 → **DNS 修改 / 修改 DNS 服务器**
→ 删除原有的（`*.dns.cn`）→ 填入 Cloudflare 给的两条 → 保存。

> `.中国` 中文域名的 NS 修改入口，阿里云在「域名控制台 → DNS 修改」，
> 腾讯云在「我的域名 → DNS 服务器」。部分注册商对中文域名会在页面上
> 标注「需实名认证完成后才可修改」，先确认域名已实名。

改完回 Cloudflare 点 **Check nameservers**。生效通常几分钟到几小时
（`.中国` 有时会慢一些）。可以自己查：

```bash
nslookup -type=NS 6.xn--fiqs8s 8.8.8.8
```

看到 `*.ns.cloudflare.com` 就说明通了。

### 5.3 在 Worker 上绑定域名

等 zone 变成 **Active** 之后：

1. Cloudflare 后台 → **Workers & Pages** → 点进 `flashdrop` 这个 Worker
2. **Settings** → **Domains & Routes** → **Add** → **Custom domain**
3. 输入 `6.中国`（或 `6.xn--fiqs8s`）
4. 保存。Cloudflare 会自动建好解析记录并签证书，1–5 分钟

**验证**：

```bash
curl -sI "https://6.xn--fiqs8s/" | head -5
```

拿到 `HTTP/2 200` 就成功了。浏览器直接访问 `6.中国` 也应该正常。

> **这时候别忘了那个拨号页**：如果它还要保留，在 Cloudflare 的 DNS 里
> 加一条 `www` 的 A/CNAME 记录指回原地址。

---

## 6. 开 TURN（跨网络传输的关键一步）

不做这一步网站也能用，但**大约 10–20% 的用户**（公司网络、严格 NAT、
部分 4G）会永远卡在「正在连接」。要做"跨地域、跨网络都能稳定传"，
这一步必须做。

### 6.1 建 TURN Key

1. Cloudflare 后台 → **Realtime** → **TURN Server**（有的界面叫
   **Calls / Realtime**，在左侧边栏里找）
2. 首次使用需要绑定支付方式 —— **放心，1000 GB/月以内不扣费**
   （$0.05/GB，前 1000 GB 免费）
3. Create a TURN key → 拿到 **Key ID** 和 **API Token**（只显示一次，记好）

### 6.2 注入到 Worker

```bash
cd D:/workbuddy/flashdrop/cloudflare

npx wrangler secret put TURN_KEY_ID
# 粘贴 Key ID，回车

npx wrangler secret put TURN_KEY_SECRET
# 粘贴 API Token，回车

npx wrangler deploy     # 让 secret 生效
```

### 6.3 额度闸门（已经在代码里了）

`cloudflare/src/turn.js` 里的 `TurnBudget` 会：

- 签发 **600 秒**有效期的凭证（单张最坏用量 7.5 GB，出厂即封顶）
- 记账：本月已签发张数 × 7.5 GB
- 超过 **900 GB** 就停止签发，只回 STUN

额度用尽时，前端会自动退回 WebSocket 中继（服务器转发）——
**功能不中断，只是慢**，而且账单永远是 $0。

改额度上限：编辑 `wrangler.toml` 里的 `TURN_MONTHLY_BUDGET_GB` 重新部署。

### 6.4 最后一道保险

Cloudflare 后台 → **Billing** → **Billable Usage** → **Create budget alert**，
阈值填 **$1**，填写你的邮箱。

这不是封顶（官方明确说了告警不会停用服务），是"越界报警器" ——
万一真有异常流量，你能第一时间知道。

---

## 7. 上线验收清单

逐条打勾，全过才算上线完成：

- [ ] `https://6.中国` 能打开，地址栏是锁 + 中文域名显示正常
- [ ] 页脚显示 `Contact：Email: 153764384@qq.com, Mobile: 00 86 13810632766`
- [ ] 手机扫码打开，页面正常
- [ ] 同一个 Wi-Fi：手机和电脑能互相看见（**不**需要输任何码）
- [ ] 不同网络：一端点「配对」拿 6 位码，另一端输码，能互相看见
- [ ] 传一个文件，进度条走完，文件能打开
- [ ] 传一段文字，对方能收到并复制
- [ ] F12 → Console 没有红色报错
- [ ] F12 → Network → 有 `wss://6.中国/ws` 且状态 101
- [ ] Cloudflare 后台 → Workers 的 Metrics 里能看到请求

---

## 8. 排错

### 页面能打开，但一直「连接中…」

信令没通。按这个顺序查：

1. F12 → Network → 找 `ws` 请求：
   - **状态 404/200** → 路径不对，检查 `wrangler.toml` 里 `not_found_handling`
     是否为 `"none"`，且 Worker 里 `/ws` 分支没被静态资源截胡
   - **状态 101 但马上断开** → 看 `npx wrangler tail` 的实时日志
2. 检查 Durable Object 迁移有没有成功：`wrangler.toml` 里
   `new_sqlite_classes` 写成了 `new_classes` 的话，免费计划会部署失败

### 两台设备互相看不见

1. 先确认它们是不是在同一个网络 —— 如果不在，**必须用配对码**，这是设计如此
2. 如果 `wrangler.toml` 里把 `WAN_ROOM_MODE` 改成了 `"off"`，那公网下就
   完全不会自动发现，只能配对
3. 同一 Wi-Fi 下还是看不见：多半是**两个人都走了 CGNAT**，
   各自的公网 IP 不同（虽然连的是同一个路由器 —— 这在双频路由器
   "2.4G 走宽带、5G 走流量"之类的情况下真的会发生）

### 卡在「正在连接」，最后退回中继

说明 P2P 和 TURN 都没打通：

1. 确认 TURN secret 注入成功：`npx wrangler secret list`
2. 确认 `TurnBudget` 没把额度耗尽：访问 `https://6.中国/turn-credentials`
   看返回 `budgetExhausted` 是不是 `true`
3. 公司网络的话，TURN 的 443 候选（`turns:...:443`）是最后的希望 ——
   代码里会自动补，确认返回的 `urls` 里有它

### 改 NS 时发现注册商不给改

`.中国` 属于 CN 类域名，个别注册商对 NS 修改有限制。两条路：

- 打注册商客服，说明要改 NS 到 `*.ns.cloudflare.com`，要求协助
- 如果确实不给改，只能换域名 —— 因为这没有技术绕路：
  Cloudflare 的自定义域名必须有 zone 归属，而 zone 的成立前提就是 NS 指过来

### wrangler 报网络错误

你本机的代理是主要嫌疑人：

```bash
export HTTPS_PROXY=http://127.0.0.1:31181     # dev-sidecar 常驻端口
npx wrangler deploy
```

不行就换 npm 镜像重装 wrangler：

```bash
npm install -D wrangler --registry=https://registry.npmmirror.com
```

### 页面白屏 / 按钮全失效

十有八九是 `_headers` 里的 CSP 太紧。F12 → Console 会有
`Refused to ... because it violates the following Content Security Policy directive`。
把 `public/_headers` 里 `Content-Security-Policy` 那一行前面加 `#` 注释掉，
重新 `npx wrangler deploy` 即可。

---

## 9. 日常运维

| 要做什么 | 命令 / 位置 |
|---|---|
| 改代码后重新上线 | `npx wrangler deploy` |
| 看实时日志 | `npx wrangler tail` |
| 看请求量 / 错误率 | 后台 → Workers & Pages → flashdrop → Metrics |
| 看 TURN 用量 | 后台 → Billing → Billable Usage |
| 改公开房间类型 | `wrangler.toml` 的 `WAN_ROOM_MODE` → 重新部署 |
| 关掉 WS 中继兜底 | `wrangler.toml` 的 `WS_RELAY = "off"` |
| 回滚 | 后台 → Worker → Deployments → 选旧版本 Rollback |

本地 Node 版（局域网自用）**没有被改动影响**，双击 `start-flashdrop.bat`
照样能用，两条路互不干扰。
