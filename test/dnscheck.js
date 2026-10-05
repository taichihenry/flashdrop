'use strict';
/* 临时工具：查 6.中国 的 DNS 现状 */
const dns = require('dns').promises;

const NAME = '6.xn--fiqs8s';
const TLDS = 'xn--fiqs8s';

async function q(label, fn, name) {
  try {
    const v = await fn(name);
    console.log(`${label} (${name}) => ${JSON.stringify(v)}`);
  } catch (e) {
    console.log(`${label} (${name}) => [${e.code}]`);
  }
}

(async () => {
  await q('NS    ', dns.resolveNs, TLDS);
  await q('SOA   ', dns.resolveSoa, TLDS);
  await q('CNAME ', dns.resolveCname, NAME);
  await q('A     ', dns.resolve4, NAME);
  await q('AAAA  ', dns.resolve6, NAME);
  await q('TXT   ', dns.resolveTxt, NAME);
  await q('CAA   ', dns.resolveCaa, NAME);
})();
