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
| GitHub 仓库 | ✅ **已完成** —— `taichihenry/flashdrop`，代码已推送 |
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
env.WAN_ROOM_MODE ("off")                    Environment Variable
env.TURN_MONTHLY_BUDGET_GB ("900")           Environment Variable
```

这行输出说明三件事都对上了：静态资源目录找得到、两个 Durable Object 类导出正常、
环境变量读到了。**如果这一关过了，真正的 `wrangler deploy` 基本不会出意外。**

---

## 4. 部署到 Cloudflare

代码**已经推上 GitHub 了**：[`github.com/taichihenry/flashdrop`](https://github.com/taichihenry/flashdrop)
（公开仓库，分支 `main`）。所以有两条路，**推荐路线 A** —— 配一次，以后 `git push` 就自动上线。

### 4.1 路线 A：让 Cloudflare 从 GitHub 自动部署（推荐）

全程在网页后台点，不用敲命令。

1. 打开 <https://dash.cloudflare.com> → 左侧 **Workers & Pages** → **Create**
2. 选 **Workers** 标签 → 找到 **Import a repository**（部分界面写作 *Connect to Git*）
3. 首次会要求授权 GitHub：选账号 **taichihenry** → 只勾选 **flashdrop** 这一个仓库
   → Install & Authorize
   （Cloudflare 只能看到你授权的仓库，权限也可随时在 GitHub Settings → Applications 撤销）
4. 回到配置页，填这几项 —— **关键是第 2 项，填错必失败**：

   | 字段 | 填什么 |
   |---|---|
   | Repository | `taichihenry/flashdrop` |
   | **Root directory（根目录）** | **`cloudflare`** ← 千万别留空 |
   | Build command | 留空（默认的 `npm ci` 就够） |
   | Deploy command | `npx wrangler deploy` |

   > **为什么根目录必须是 `cloudflare`**：`wrangler.toml` 在这个子目录里。
   > 留空的话 Cloudflare 在仓库根目录找不到配置，构建会直接报错。
   > 配置里 `[assets] directory = "../public"` 会正确指回仓库根的 `public/`，
   > **前端和 Worker 仍然共用同一份代码**，不会分叉。

5. 点 **Deploy**，等 1～3 分钟（页面会实时滚构建日志）。
6. 成功后给你一个地址：`https://flashdrop.<你的子域>.workers.dev`

**以后再改代码，只要推送就行**：

```bash
cd D:/workbuddy/flashdrop
git add -A && git commit -m "改了什么"
git push
```

推上去 Cloudflare 就自动重新构建 —— 这就是你要的「从 GitHub 获取推送」。
（本机 `git push` 要带代理参数，**照抄第 10 节**，直接敲 `git push` 会卡死。）

**额度**：Workers Builds 免费计划 **3,000 构建分钟/月**（合 50 小时）。
这项目一次构建约 1～2 分钟，**一个月能推上千次**。
用完之后只是"构建排队不动了"，**不会自动扣费**，等下个周期重置。

### 4.2 路线 B：本机命令行部署（想第一次快速验证就用它）

```bash
cd D:/workbuddy/flashdrop/cloudflare
npx wrangler deploy
```

第一次会问是否创建 Durable Object 迁移，输入 `y` 回车。成功后终端打印地址：

```
https://flashdrop.<你的子域>.workers.dev
```

> 两条路不冲突，但**建议只固定用一条**。它们部署出的 Worker 同名（都叫 `flashdrop`），
> 谁后部署谁生效，混用容易搞不清线上跑的是哪个版本。

### 4.3 先用 workers.dev 地址验一遍

**先别急着绑域名**：

1. 浏览器打开它 → 应该看到 FlashDrop 首页，页脚有联系方式
2. 再用另一台设备（手机也行）打开同一地址
3. 两台设备应该互相「看见」——同一网络下会自动发现；
   不在同一网络就点顶部「配对」，输 6 位码

如果这一步就通了，后面的域名和 TURN 只是锦上添花。

> **想看实时日志**：`cd D:/workbuddy/flashdrop/cloudflare && npx wrangler tail`
> （路线 A 的构建日志则在后台的部署记录里看）。

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

> ### ⚠️ 扫描结果里那几条「缺少 DNS 记录」的警告，对本项目全部可以忽略
>
> zone 建好后，DNS 页面会提示你补 `A` / `AAAA` / `CNAME` / `MX` 记录。
> 对一个**纯 Worker 站点**，这些提示都是通用体检的误报：
>
> | 提示 | 为什么不适用 |
> |---|---|
> | 缺少 apex `A` / `AAAA` / `CNAME` | Worker 自定义域由 Cloudflare 在 deploy 时**自动建 `type=Worker` 记录**，不需要你填 IP |
> | 缺少 `www` 子域记录 | 同上，`custom_domain = true` 会连带把 `www` 一起建出来 |
> | 缺少 `MX`（邮件） | 本项目不收邮件。**补了反而多开一个可被投递的入口**，纯增攻击面 |
>
> 「配没配对」要看**三件事**，不是看这几条提示：
> ① zone 是否 `active`；② NS 是否与注册商处一致；③ 实测能否解析 + 访问。
>
> API 查 zone 状态最准（面板渲染可能是缓存）：
> ```bash
> curl -s "https://api.cloudflare.com/client/v4/zones?per_page=50" \
>   -H "Authorization: Bearer <你的 token>" | grep -o '"name":"[^"]*"\|"status":"[^"]*"'
> ```

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

### 5.4 四个入口都要绑（`www` 和繁体 `6.中國`）

`wrangler.toml` 里维护的是四条自定义域，**不是两条**：

```toml
routes = [
  { pattern = "6.xn--fiqs8s",     custom_domain = true },  # 6.中国
  { pattern = "www.6.xn--fiqs8s", custom_domain = true },  # www.6.中国
  { pattern = "6.xn--fiqz9s",     custom_domain = true },  # 6.中國（繁体）
  { pattern = "www.6.xn--fiqz9s", custom_domain = true }   # www.6.中國（繁体）
]
```

两条容易忽略的：

- **`www` 不是自动的。** DNS 里没有「自动补 www」这回事，`www.6.中国` 是**三级域名**，
  和 `6.中国` 是两个完全不同的名字，不显式绑定就是 `ENOTFOUND`。
- **`.中國` 是另一个顶级域。** `.中国`( `xn--fiqs8s` ) 和 `.中國`( `xn--fiqz9s` )
  punycode 不同 —— 别记成 `xn--kpry57d`。注册局（CNNIC）把两者当成同一份注册数据
  （所以改一个的 NS，另一个跟着变），但 **Cloudflare 侧必须各自建 zone、各自绑定**。

  > 规范写法：用 Node 现算最稳
  > `node -e "console.log(new URL('https://6.中國').hostname)"` → `6.xn--fiqz9s`

繁体 zone 的建法和简体完全一样（§5.1 → §5.3），**但不用再去改 NS** ——
CNNIC 那边一直就是 `odin` / `tricia`，所以 zone 通常建完直接就是 `active`。

**归一逻辑不用你写**：Worker 入口（`cloudflare/src/index.js` 的 `fetch()` 最前面）
已经用 301 把 www / 繁体两种写法都收到 `6.中国`；前端 `public/www-redirect.js` 里还有
一份等价的浏览器版（白名单 `FAMILY = ['6.xn--fiqs8s', '6.xn--fiqz9s']`），那是给**本地
Node 版**用的 —— Node 版没有 Worker 这层，只能靠页面自己跳。
这是必须的 —— 浏览器不认「简繁等效」和「www 等价」，四个域名是四个 origin，
`localStorage` 各自独立，不归一就会出「在一个地址改的设备名，换个地址打开变默认名」。

### 5.5 顺手打开 Always Use HTTPS（两个 zone 各点一次）

手机浏览器在地址栏手输裸域名时会**自动补 `http://`**（桌面浏览器走 HTTPS-First 所以
没这问题）。而 http 不是安全上下文 —— `crypto.subtle` 与 `RTCPeerConnection` 都被浏览器
禁掉，P2P 直接退化成服务器中继，传文件慢一档。

Worker 里已经有一层**代码级 301**（把 http 和域名写法一次性归一到
`https://6.中国`），但静态资源是直落 Assets、不进 Worker 的，所以还建议在边缘再兜一层：

**SSL/TLS → Edge Certificates → 向下滚 → Always Use HTTPS → 打开**

`6.中国` 和 `6.中國` 两个 zone 各做一次。它零代码、不额外计费、在 Worker 之前执行，
能把**所有路径**的 http 请求都跳到 https。

> **为什么不能只靠 HSTS**：规范要求浏览器**忽略 http 响应里的 HSTS 头**，所以 HSTS
> 只管「来过一次之后」。用户的第一次永远落在 http —— 只有服务端 301 能管第一次。

验证（离线 + 真实浏览器两条）：

```bash
node cloudflare/test/redirect.js        # 22 项，含"本地 dev 不被误跳"的反例
node test/www-redirect.js               # 默认打线上，含 http→https 与 isSecureContext 断言
```

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

1. **先看「附近设备」区域有没有一段说明**：「本站已关闭设备自动发现…」——
   有的话说明本站的自动发现是关的（`WAN_ROOM_MODE = "off"`，防 CGNAT 串房），
   **属于正常设计，不是故障**。请改用二维码 / 房间码 / 配对码。
2. 如果是「应该有设备却看不见」，先确认对方打开的是不是**同一条链接**
   —— 地址栏末尾应当有 `#room=xxxxxx`
3. 还不行就走顶栏「**配对**」的 6 位码：这条路与 IP 无关，也最稳
4. 想恢复"同一个路由器下自动发现"体验：把 `wrangler.toml` 的 `WAN_ROOM_MODE`
   改回 `"ip"` 重新部署（**但要先接受 CGNAT 串房风险**，见 §1.1 与检查报告第九节）

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
| 改代码后重新上线 | 路线 A：`git push`（自动构建）· 路线 B：`npx wrangler deploy` |
| 看实时日志 | `npx wrangler tail` |
| 看构建记录（成功/失败原因） | 后台 → Workers & Pages → flashdrop → Deployments |
| 看请求量 / 错误率 | 后台 → Workers & Pages → flashdrop → Metrics |
| 看 TURN 用量 | 后台 → Billing → Billable Usage |
| 看构建分钟余量 | 后台 → Workers & Pages → flashdrop → Builds |
| 开 / 关自动发现 | `wrangler.toml` 的 `WAN_ROOM_MODE`（当前 `"off"`）→ 重新部署 |
| 关掉 WS 中继兜底 | `wrangler.toml` 的 `WS_RELAY = "off"` |
| 回滚 | 后台 → Worker → Deployments → 选旧版本 Rollback |

本地 Node 版（局域网自用）**没有被改动影响**，双击 `start-flashdrop.bat`
照样能用，两条路互不干扰。

---

## 10. 本机 `git push` 的正确姿势（重要）

这台机器上有两个坑，直接敲 `git push` 会**卡死**或报证书错。照抄下面这段：

```bash
cd D:/workbuddy/flashdrop

# 1) 先确认 dev-sidecar 开着（它就是代理，端口 31181）
#    任务栏能看到 dev-sidecar 图标即可

# 2) 提交
git add -A
git commit -m "改了什么"

# 3) 推送（必须指定 Git 路径和代理，否则会卡住）
GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never \
  "E:/Git/cmd/git.exe" -C "D:/workbuddy/flashdrop" \
  -c http.proxy=http://127.0.0.1:31181 \
  -c http.schannelCheckRevoke=false \
  push origin main
```

**三个坑分别是什么**：

| 现象 | 原因 | 解法 |
|---|---|---|
| 卡住不动，桌面弹出「Select a credential helper」 | 默认的 `git` 是 WorkBuddy 自带的 PortableGit，它的凭据助手是弹框式的，非交互环境下直接死等 | 改用 `E:/Git/cmd/git.exe`（系统安装版），并带上 `GIT_TERMINAL_PROMPT=0` |
| `CRYPT_E_NO_REVOCATION_CHECK` | dev-sidecar 做中间人，走它的流量查不了证书吊销状态 | 加 `-c http.schannelCheckRevoke=false` —— **只关吊销检查，证书链照常校验**，比 `sslVerify=false` 安全 |
| `github.com` 连接超时 / `Empty reply` | 国内网络对 GitHub 主站的干扰（`api.github.com` 反而正常） | 开 dev-sidecar，走 `http.proxy=127.0.0.1:31181` |

> 代理端口如果不是 31181：在 dev-sidecar 界面看「系统代理设置」里的端口，替换即可。
> 偶发报 `CONNECT tunnel failed, response 502` 是它的老毛病，**隔几秒重试一次就好**，不是你的操作问题。

**首次推送时若提示远端有内容**（比如 GitHub 建仓时勾了 "Add README"）：
先用 `git fetch origin` 看清远端有什么，再决定合并或覆盖。本仓库首次推送时
远端只有一个自动生成的占位 README，已用 `--force-with-lease` 覆盖，之后正常推送即可。
