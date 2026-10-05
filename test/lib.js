/**
 * 测试用的公共件：极简 CDP 客户端 + 浏览器启动。
 * e2e.js 和 screenshot.js 都用它。
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const DEFAULT_CHROME = 'E:/softs/Chrome153_AllNew_2026.9.12/App/chrome.exe';

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = [
    DEFAULT_CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return DEFAULT_CHROME;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, fn, timeoutMs = 25000, interval = 300) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(interval);
  }
  throw new Error(`等待超时（${timeoutMs}ms）: ${desc}` + (lastErr ? ` / 最后一次错误: ${lastErr.message}` : ''));
}

/* ============================== 极简 CDP 客户端 ============================== */

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    this.id = 0;
    this.pending = new Map();
    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  ready() {
    return new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
  }

  send(method, params, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, timeoutMs);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面内报错: ' + (d.exception ? d.exception.description : d.text));
    }
    return r.result.value;
  }

  /** 截图，返回 PNG 字节 */
  async screenshot() {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    return Buffer.from(r.data, 'base64');
  }

  close() { try { this.ws.close(); } catch { /* noop */ } }
}

/* ============================== 启动浏览器 ============================== */

function fetchJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function waitJson(port, tries = 60) {
  let n = 0;
  for (;;) {
    try { return await fetchJson(port, '/json/list'); }
    catch {
      if (++n > tries) throw new Error('浏览器调试端口没起来: ' + port);
      await sleep(350);
    }
  }
}

/**
 * 让浏览器自己退出。
 *
 * ⚠ 不要试图杀 spawn 出来的那个进程：**Chrome 是"启动器即退"**——
 * 它把手头的活交给真正的浏览器进程后就退出了，所以我们手里的 proc.pid
 * 早就不存在了（tasklist 查不到、taskkill 报"没有找到进程"），
 * 而真正那个浏览器进程还活得好好的。这是"杀不掉残留 Chrome"的根因。
 *
 * 正解是连到 browser 级调试端点发 `Browser.close`，浏览器会连带所有
 * 渲染/GPU/网络子进程一起优雅退出。
 */
async function closeBrowser(port) {
  try {
    const v = await fetchJson(port, '/json/version');
    if (!v || !v.webSocketDebuggerUrl) return false;
    const c = new Cdp(v.webSocketDebuggerUrl);
    await c.ready();
    await c.send('Browser.close', {}, 8000).catch(() => { /* 进程退出时连接会断，正常 */ });
    c.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} o
 * @param {string} o.label
 * @param {string} o.url
 * @param {number} o.port   远程调试端口
 * @param {string} o.profileDir 用户数据目录（不同实例必须不同，才是真正隔离的两个浏览器）
 * @param {boolean} [o.headless]
 * @param {number} [o.width]
 * @param {number} [o.height]
 */
async function launch(o) {
  const chrome = o.chrome || findChrome();
  if (!fs.existsSync(chrome)) throw new Error('找不到浏览器：' + chrome);

  const args = [
    `--remote-debugging-port=${o.port}`,
    `--user-data-dir=${o.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-features=Translate,MediaRouter',
    '--autoplay-policy=no-user-gesture-required',
    // 自签证书一律放行（真实手机上需要用户手动点一次"继续访问"）
    '--ignore-certificate-errors',
    `--window-size=${o.width || 1000},${o.height || 800}`,
  ];
  if (o.headless !== false) args.push('--headless=new', '--disable-gpu');
  // 额外参数，用于复现特定网络环境（例如 --disable-ipv6 强制走 IPv4）
  if (Array.isArray(o.extraArgs)) args.push(...o.extraArgs);
  args.push(o.url);

  const proc = spawn(chrome, args, { stdio: 'ignore', detached: false });
  const targets = await waitJson(o.port);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error(o.label + ': 找不到 page target');

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // 命令行传的 URL 是异步导航的，不等加载完就 evaluate 会拿到空白文档
  await waitFor(`${o.label} 页面加载完成`, async () => {
    try {
      return await cdp.eval(`document.readyState === 'complete' && typeof window.FlashDrop === 'object'`);
    } catch { return false; }
  }, 30000, 250);

  return {
    label: o.label,
    proc,
    cdp,
    port: o.port,
    chrome,
    /** 让这台浏览器自己退出（连带所有子进程） */
    close: () => closeBrowser(o.port),
  };
}

function tempProfile(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 结束浏览器进程。
 * 只调 proc.kill() 是不够的：Windows 上 Chrome 会另起一堆子进程，父进程死了它们还在，
 * 而且是带着原来的 profile 继续连着信令服务器 —— 下一轮测试就会看到"幽灵设备"，
 * 表现为"对端明明在线却收不到东西"，非常难查。必须连整棵树一起杀。
 */
function killTree(proc) {
  if (!proc || !proc.pid) return Promise.resolve();
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const k = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      k.on('close', () => resolve());
      k.on('error', () => { try { proc.kill('SIGKILL'); } catch { /* noop */ } resolve(); });
    } else {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
      resolve();
    }
  });
}

module.exports = {
  Cdp, launch, waitFor, sleep, findChrome, tempProfile, killTree, closeBrowser, DEFAULT_CHROME,
};
