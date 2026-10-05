// 线上双端信令实测：建房 → 加入 → 定向转发
// 用法：node test/live-ws.mjs [host]
// 默认打正式域名 6.中国（punycode：6.xn--fiqs8s）
const HOST = process.argv[2] || '6.xn--fiqs8s';
const URL_WS = `wss://${HOST}/ws`;

const log = (...a) => console.log(...a);
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1; };

function open(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_WS);
    ws.inbox = [];
    ws.self = null;
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'self') { ws.self = m; }
      ws.inbox.push(m);
    };
    ws.onerror = (e) => reject(new Error(`${name} ws error`));
    ws.onopen = () => resolve(ws);
    setTimeout(() => reject(new Error(`${name} open timeout`)), 15000);
  });
}

const waitFor = (ws, type, ms = 15000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    const hit = ws.inbox.find((m) => m.type === type);
    if (hit) return resolve(hit);
    if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting ${type}`));
    setTimeout(tick, 120);
  };
  tick();
});

(async () => {
  const A = await open('A');
  await waitFor(A, 'self');
  log(`✔ A 连接成功  peerId=${A.self.peerId}  turn=${A.self.config.turnAvailable}  wsRelay=${A.self.config.wsRelay}`);

  A.send(JSON.stringify({ type: 'create-room' }));
  const created = await waitFor(A, 'room-created');
  const code = created.roomId;
  log(`✔ A 建房成功  房间码=${code}`);

  const B = await open('B');
  await waitFor(B, 'self');
  log(`✔ B 连接成功  peerId=${B.self.peerId}`);

  B.send(JSON.stringify({ type: 'join-room', code }));
  const joined = await waitFor(B, 'room-joined');
  log(`✔ B 加入房间成功  roomId=${joined.roomId}`);

  const seen = await waitFor(A, 'peer-joined');
  log(`✔ A 收到 peer-joined  peers=${(await waitFor(A, 'peers')).peers.length}`);

  // A 定向发给 B
  B.inbox.length = 0;
  A.send(JSON.stringify({
    type: 'signal',
    roomId: 'pub:' + code,
    to: B.self.peerId,
    data: { kind: 'offer', sdp: 'TEST-SDP-PAYLOAD' },
  }));
  const got = await waitFor(B, 'signal', 15000);
  const ok = got.data && got.data.sdp === 'TEST-SDP-PAYLOAD' && got.senderId === A.self.peerId;
  if (ok) log(`✔ B 收到 A 的定向信令   senderId=${got.senderId}  sdp=${got.data.sdp}`);
  else fail(`转发内容不符: ${JSON.stringify(got)}`);

  // 越权测试：第三方 C 试图往房间里插信令，应被静默丢弃
  const C = await open('C');
  await waitFor(C, 'self');
  B.inbox.length = 0;
  C.send(JSON.stringify({ type: 'signal', roomId: 'pub:' + code, to: B.self.peerId, data: { sdp: 'INTRUDER' } }));
  await new Promise((r) => setTimeout(r, 2500));
  const leaked = B.inbox.some((m) => m.type === 'signal' && m.data && m.data.sdp === 'INTRUDER');
  if (leaked) fail('越权防护失效：房间外的连接成功插入了信令');
  else log('✔ 越权防护有效：房间外的连接无法插入信令');

  // WS 中继兜底
  B.inbox.length = 0;
  A.send(JSON.stringify({
    type: 'relay',
    roomId: 'pub:' + code,
    to: B.self.peerId,
    data: { kind: 'relay-text', text: 'RELAY-PAYLOAD' },
  }));
  const rel = await waitFor(B, 'relay', 15000);
  if (rel.data && rel.data.text === 'RELAY-PAYLOAD') log('✔ WS 中继兜底通道可用');
  else fail(`中继内容不符: ${JSON.stringify(rel)}`);

  [A, B, C].forEach((w) => w.close());
  log(process.exitCode ? '\n结果：有失败项' : '\n结果：全部通过 ✅');
  setTimeout(() => process.exit(process.exitCode || 0), 300);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
