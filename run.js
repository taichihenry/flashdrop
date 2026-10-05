'use strict';
/**
 * FlashDrop 启动器
 * ---------------------------------------------------------------------------
 * 干三件事：
 *   1. 探测本机局域网 IP（手机要连的那一个）
 *   2. 用这些 IP 生成/复用一张自签名证书 —— 这步不能省。
 *      现代浏览器把 WebRTC 归为高权限 API，只有「安全上下文」才放行：
 *        · https://...        → ✅ 安全上下文
 *        · http://127.0.0.1   → ✅ 安全上下文（白名单特例）
 *        · http://192.168.x.x → ❌ 不是安全上下文，RTCPeerConnection 直接不可用
 *      所以手机必须走 HTTPS，否则连不上（页面会自己提示）。
 *   3. 起 HTTP + HTTPS 双服务，打印访问地址
 *
 * 用法：
 *   node run.js              默认
 *   node run.js --no-tls     只起 HTTP（仅本机浏览器可用）
 *   node run.js --port 9000  改端口（HTTPS 为 端口+1）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('./server');

const CERT_DIR = path.join(__dirname, 'certs');

/* ---------------------- 命令行 / 环境变量 ---------------------- */

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** 环境变量当布尔用：设了且不是 0/false/no/off 就算 true */
function envFlag(name) {
  const v = process.env[name];
  return !!v && !/^(0|false|no|off)$/i.test(v.trim());
}

/**
 * ICE 配置（公网部署要挂 TURN 时用）。两种写法：
 *   A) ICE_SERVERS='[{"urls":"stun:stun.cloudflare.com:3478"}, {...}]'
 *   B) TURN_URL / TURN_USERNAME / TURN_CREDENTIAL（更省事，推荐）
 *      TURN_URL 支持逗号分隔多个 URL
 * 都不设则用内置的 Google STUN（局域网自用足够了）。
 */
function parseIceServers() {
  const raw = (process.env.ICE_SERVERS || '').trim();
  if (raw) {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v) && v.length) return v;
      console.error('  ⚠ ICE_SERVERS 不是非空 JSON 数组，已忽略');
    } catch (e) {
      console.error('  ⚠ ICE_SERVERS JSON 解析失败，已忽略：' + e.message);
    }
  }
  const turnUrl = (process.env.TURN_URL || '').trim();
  if (turnUrl) {
    const server = {
      urls: turnUrl.split(',').map((s) => s.trim()).filter(Boolean),
    };
    if (process.env.TURN_USERNAME) server.username = process.env.TURN_USERNAME;
    if (process.env.TURN_CREDENTIAL) server.credential = process.env.TURN_CREDENTIAL;
    return [server];
  }
  return null;
}

const CONF = {
  httpPort: parseInt(argValue('--port', process.env.PORT || '8686'), 10),
  httpsPort: 0,
  noTls: process.argv.includes('--no-tls') || envFlag('NO_TLS'),
  // 反代后面必须开，否则所有客户端 IP 都是 127.0.0.1，全部挤进同一间房
  trustProxy: process.argv.includes('--trust-proxy') || envFlag('TRUST_PROXY'),
  // 只按连接地址分房，忽略浏览器上报的出口地址。
  // 默认关：双栈网络下必须靠上报值才能让同一张网的两台设备落进同一间房。
  ignoreReportedAddr: process.argv.includes('--ignore-reported-addr') || envFlag('IGNORE_REPORTED_ADDR'),
  wsRelay: !process.argv.includes('--no-relay'),
  iceServers: parseIceServers(),
};
CONF.httpsPort = CONF.httpPort + 1;

/* ---------------------------- 局域网 IP ---------------------------- */

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      out.push({ ip: info.address, iface: name });
    }
  }
  // 优先真实局域网网段，把 169.254 之类的排后面
  out.sort((a, b) => score(a.ip) - score(b.ip));
  return out;
}
function score(ip) {
  if (/^192\.168\./.test(ip)) return 0;
  if (/^10\./.test(ip)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 9;
}

/* ---------------------------- 自签名证书 ---------------------------- */

function ensureCertificate(ips) {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  const metaPath = path.join(CERT_DIR, 'meta.json');

  const want = {
    altNames: ['localhost', '127.0.0.1', '::1', ...ips].sort(),
  };

  let need = true;
  if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(metaPath)) {
    try {
      const have = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (JSON.stringify(have.altNames) === JSON.stringify(want.altNames)) need = false;
    } catch { /* 缓存坏了就重生成 */ }
  }

  if (need) {
    const selfsigned = require('selfsigned');
    // type 2 = DNS，type 7 = IP —— 必须把局域网 IP 放进 SAN，
    // 否则 Chrome 会直接拒绝（只报 ERR_CERT_COMMON_NAME_INVALID，很难查）
    const altNames = want.altNames.map((v) => {
      if (v === 'localhost') return { type: 2, value: 'localhost' };
      return { type: 7, ip: v };
    });
    const pems = selfsigned.generate(
      [{ name: 'commonName', value: 'FlashDrop Local' }],
      {
        keySize: 2048,
        days: 3650,
        algorithm: 'sha256',
        extensions: [
          { name: 'basicConstraints', cA: true },
          { name: 'subjectAltName', altNames },
        ],
      }
    );
    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);
    fs.writeFileSync(metaPath, JSON.stringify(want, null, 2));
    console.log('  · 已生成自签名证书（含本机所有局域网 IP）');
  } else {
    console.log('  · 复用已有证书');
  }

  return { key: fs.readFileSync(keyPath, 'utf8'), cert: fs.readFileSync(certPath, 'utf8') };
}

/* ---------------------------- 启动 ---------------------------- */

async function main() {
  const ips = lanAddresses();
  const primary = ips.length ? ips[0].ip : null;

  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │   FlashDrop · 局域网互传（手机 ⇄ 电脑）       │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log('');

  let tls = null;
  if (!CONF.noTls) {
    console.log('  [1/2] 准备 HTTPS 证书');
    try {
      tls = ensureCertificate(ips.map((i) => i.ip));
    } catch (e) {
      console.error('  ! 证书生成失败，降级为仅 HTTP（手机将无法使用）:', e.message);
      console.error('    要修的话：在项目目录执行 npm install selfsigned');
      tls = null;
    }
  } else {
    console.log('  [1/2] 已关闭 TLS（--no-tls 或 NO_TLS=1）：跳过 HTTPS');
  }

  const lanUrls = [];
  if (primary) {
    if (tls) lanUrls.push(`https://${primary}:${CONF.httpsPort}`);
    lanUrls.push(`http://${primary}:${CONF.httpPort}`);
  }

  console.log('  [2/2] 启动服务');
  const { servers } = await start({
    httpPort: CONF.httpPort,
    httpsPort: tls ? CONF.httpsPort : 0,
    tls,
    lanUrls,
    trustProxy: CONF.trustProxy,
    ignoreReportedAddr: CONF.ignoreReportedAddr,
    wsRelay: CONF.wsRelay,
    iceServers: CONF.iceServers,
  });

  console.log('');
  console.log('  ┌─ 本机（这台电脑的浏览器）────────────────────');
  console.log(`  │  http://127.0.0.1:${CONF.httpPort}`);
  if (tls) {
    console.log(`  │  https://127.0.0.1:${CONF.httpsPort}`);
  }
  const publicMode = CONF.trustProxy || CONF.noTls;

  if (publicMode) {
    console.log('  │');
    console.log('  ├─ 公网模式 ──────────────────────────────────');
    console.log(`  │  监听端口：${CONF.httpPort}（HOST 默认 0.0.0.0）`);
    console.log(`  │  信任反代头：${CONF.trustProxy ? '已开启（读 CF-Connecting-IP / X-Forwarded-For）' : '未开启 ⚠'}`);
    console.log(`  │  TLS：${tls ? '本进程自签（公网请关掉，交给反代/平台）' : '交由外部（推荐）'}`);
    console.log('  │');
    console.log('  │  上线前自查这 4 条，缺一条就会出问题：');
    console.log('  │   1. 反代必须透传真实客户端 IP，且开 TRUST_PROXY=1');
    console.log('  │      否则所有人 IP 都是 127.0.0.1 → 挤进同一间房 → 陌生人互相可见');
    console.log('  │   2. 域名 + 真证书（Let\'s Encrypt / 平台自带），别用自签');
    console.log('  │   3. 挂 TURN（TURN_URL/TURN_USERNAME/TURN_CREDENTIAL），否则 10-20% 用户连不上');
    console.log('  │   4. 去 Cloudflare 后台设一条 Budget alert（$1 即可），当作超额兜底告警');
    console.log('  │');
  } else {
    console.log('  │');
    console.log('  ├─ 手机 / 其他设备（必须同一 Wi-Fi）───────────');
    if (!tls) {
      console.log('  │  ⚠ 未启用 HTTPS，手机浏览器拿不到 WebRTC 权限，无法使用');
    } else if (!primary) {
      console.log('  │  ⚠ 没检测到局域网 IP，请确认已连上 Wi-Fi 或网线');
    } else {
      for (const u of lanUrls) console.log(`  │  ${u}`);
      if (ips.length > 1) {
        const others = ips.slice(1).map((i) => `${i.ip} (${i.iface})`).join('、');
        console.log(`  │  （另有其他网卡地址：${others}，一般用第一个就行）`);
      }
    }
    console.log('  │');
    console.log('  ├─ 使用步骤 ──────────────────────────────────');
    console.log('  │  1. 手机连上同一个 Wi-Fi');
    console.log('  │  2. 手机浏览器打开上面的地址');
    console.log('  │     首次会提示"证书不受信任" → 点【高级】→【继续访问】');
    console.log('  │     这是自签名证书的正常提示，因为服务只跑在你自己电脑上');
    console.log('  │  3. 两端页面会自动互相"看见"，点设备图标即可发送');
    console.log('  │');
    console.log('  ├─ 提示 ─────────────────────────────────────');
    console.log('  │  · 首次运行若弹防火墙对话框，必须勾选【专用网络】允许');
    console.log('  │  · 页面里的二维码直接扫，手机就能打开');
    console.log(`  │  · 文件不走任何第三方服务器，只在两台设备之间直传`);
    console.log('  │');
  }
  console.log('  └─ 按 Ctrl+C 停止服务 ────────────────────────');
  console.log('');

  const shutdown = () => {
    console.log('\n  正在停止...');
    for (const s of servers) { try { s.close(); } catch { /* noop */ } }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('\n  启动失败：', e && e.message ? e.message : e);
  if (e && e.code === 'EADDRINUSE') {
    console.error(`  端口被占用了。换一个：node run.js --port 9000`);
  }
  process.exit(1);
});
