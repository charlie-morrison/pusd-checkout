// Unit test of the THORChain half of the quote engine (app/src/thor.ts), the bridge legs
// (app/src/bridge.ts) and the rule-5 re-quote (app/src/quote.ts freshQuote).
// Fixtures: LIVE THORChain answers saved 16.11.2026 16:05Z (test/fixtures/thor-20261116/), plus
// tampered copies of them. No network: fetch is stubbed.
// Usage: node test/thor_unit.mjs [app/src dir]   (Node >= 23)   Exit 0 = all pass, 1 = a case failed.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { calcBuyFromPool, calcSellToPool } from '@mr-zwets/cauldron-swap-sdk';
import * as la from '@bitauth/libauth';

const src = process.argv[2] ?? new URL('../app/src', import.meta.url).pathname;
const thor = await import(pathToFileURL(`${src}/thor.ts`).href);
const bridge = await import(pathToFileURL(`${src}/bridge.ts`).href);
const quote = await import(pathToFileURL(`${src}/quote.ts`).href);

const fx = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/thor-20261116/${n}.json`, import.meta.url)));
const inbound = fx('inbound');
const vaults = thor.activeVaults(fx('asgard_trimmed'));
const outBsc = fx('out_bsc'), inBsc = fx('in_bsc');
const USDT = thor.STABLES.find((s) => s.chain === 'BSC');
const USDC = thor.STABLES.find((s) => s.chain === 'BASE');
const DEAD = '0x000000000000000000000000000000000000dEaD';
const BCHQ = 'qzmsqp8y48crckhv63y5mz9fek066xrufuzkks6ryj';
const NOW = outBsc.expiry - 879; // the moment the fixtures were read
const outReq = { from: 'BCH.BCH', to: USDT.asset, amountIn: 2000000n, destination: DEAD };
const inReq = { from: USDT.asset, to: 'BCH.BCH', amountIn: 400000000n, destination: BCHQ };
const tweak = (o, f) => { const c = structuredClone(o); f(c); return c; };

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

// chain status (live inbound_addresses 16.11: BASE halted, BCH and BSC open)
t('live: BCH open, gas rate 3', () => { const s = thor.chainStatus(inbound, 'BCH'); return s.open && s.gasRate === 3n; });
t('live: BSC open', () => thor.chainStatus(inbound, 'BSC').open);
t('live: BASE halted -> closed with a reason', () => { const s = thor.chainStatus(inbound, 'BASE'); return !s.open && /halted the BASE/.test(s.reason); });
t('global pause closes an open chain', () => !thor.chainStatus(tweak(inbound, (c) => c.forEach((x) => { x.global_trading_paused = true; })), 'BSC').open);
t('chain_trading_paused alone closes it', () => !thor.chainStatus(tweak(inbound, (c) => { const b = c.find((x) => x.chain === 'BSC'); b.chain_trading_paused = true; }), 'BSC').open);
t('unlisted chain is closed', () => { const s = thor.chainStatus(inbound, 'NOPE'); return !s.open && /does not list/.test(s.reason); });

// vaults
t('6 active BCH vaults, quote vault among them', () => vaults.get('BCH').addresses.size === 6 && vaults.get('BCH').addresses.has(outBsc.inbound_address));
t('retiring vault excluded', () => {
  const a = fx('asgard_trimmed'); a[0].status = 'RetiringVault';
  return !thor.activeVaults(a).get('BCH').addresses.has(a[0].addresses.find((x) => x.chain === 'BCH').address.toLowerCase());
});

// quotes: live answers
t('live OUT BCH->BSC.USDT parses', () => {
  const r = thor.parseQuote(outBsc, outReq, vaults, NOW);
  return r.ok && r.q.expectedOut === 385834558n && r.q.fees.totalBps === 591 && r.q.minIn === 394740n && r.q.router === null && r.q.seconds === 606;
});
t('live IN BSC.USDT->BCH parses, router active', () => {
  const r = thor.parseQuote(inBsc, inReq, vaults, NOW);
  return r.ok && r.q.expectedOut === 1817540n && r.q.router === inBsc.router && r.q.memo === `=:c:${BCHQ}`;
});
t('live Base halt error -> kind halted', () => { const r = thor.parseQuote(fx('out_base'), { ...outReq, to: USDC.asset }, vaults, NOW); return !r.ok && r.kind === 'halted'; });
t('live dust error -> kind minimum', () => { const r = thor.parseQuote(fx('err_small'), { ...outReq, amountIn: 1000n }, vaults, NOW); return !r.ok && r.kind === 'minimum'; });
t('live prefixed-address error -> kind refused, message kept', () => { const r = thor.parseQuote(fx('err_prefix'), inReq, vaults, NOW); return !r.ok && r.kind === 'refused' && /bitcoincash/.test(r.error); });

// quotes: tampered answers must all be refused
const refused = (raw, req = outReq, now = NOW) => { const r = thor.parseQuote(raw, req, vaults, now); return !r.ok && r.kind === 'invalid'; };
t('memo pays someone else -> invalid', () => refused(tweak(outBsc, (q) => { q.memo = '=:BSC.USDT:0x1111111111111111111111111111111111111111'; })));
t('memo names another asset -> invalid', () => refused(tweak(outBsc, (q) => { q.memo = `=:BSC.BNB:${DEAD}`; })));
t('IN memo to another BCH address -> invalid', () => refused(tweak(inBsc, (q) => { q.memo = '=:c:qqvq099cf3dj3uwjyk70mn03xg74rdgcc53rdqreag'; }), inReq));
t('vault not active -> invalid', () => refused(tweak(outBsc, (q) => { q.inbound_address = 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'; })));
t('router not active -> invalid', () => refused(tweak(inBsc, (q) => { q.router = '0x2222222222222222222222222222222222222222'; }), inReq));
t('IN quote without a router -> invalid', () => refused(tweak(inBsc, (q) => { delete q.router; }), inReq));
t('expires in 30 s -> invalid', () => refused(outBsc, outReq, outBsc.expiry - 30));
t('already expired -> invalid', () => refused(outBsc, outReq, outBsc.expiry + 5));
t('fees in another asset -> invalid', () => refused(tweak(outBsc, (q) => { q.fees.asset = 'BSC.BNB'; })));
t('zero output -> invalid', () => refused(tweak(outBsc, (q) => { q.expected_amount_out = '0'; })));
t('memo over 80 bytes on a BCH inbound -> invalid', () => refused(tweak(outBsc, (q) => { q.memo = `=:BSC.USDT:${DEAD}:0/1/0:${'x'.repeat(40)}`; })));
t('amount below recommended_min_amount_in -> minimum', () => { const r = thor.parseQuote(outBsc, { ...outReq, amountIn: 394739n }, vaults, NOW); return !r.ok && r.kind === 'minimum' && /0\.00394740 BCH/.test(r.error); });

// quoteSwap does not even call THORChain for a halted chain
t('quoteSwap: halted BASE answered without a fetch', async () => {
  const saved = globalThis.fetch; let called = 0;
  globalThis.fetch = async () => { called++; throw new Error('no network in this test'); };
  try {
    const r = await thor.quoteSwap({ ...outReq, to: USDC.asset }, { inbound, vaults, readAt: NOW });
    return !r.ok && r.kind === 'halted' && called === 0;
  } finally { globalThis.fetch = saved; }
});
t('quoteSwap: open pair reads the 400 body of a refusal', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(fx('err_small')), { status: 400 });
  try { const r = await thor.quoteSwap({ ...outReq, amountIn: 1000n }, { inbound, vaults, readAt: NOW }); return !r.ok && r.kind === 'minimum'; }
  finally { globalThis.fetch = saved; }
});

// amounts
t('thorUnits 4 / 3.70 / 4.555 / abc', () => thor.thorUnits('4') === 400000000n && thor.thorUnits('3.70') === 370000000n && thor.thorUnits('4.555') === null && thor.thorUnits('abc') === null);
t('formatThor rounds', () => thor.formatThor(385834558n) === '3.86' && thor.formatThor(394740n, 8) === '0.00394740');

// addresses
const PRIZE_Z = 'bitcoincash:zzmsqp8y48crckhv63y5mz9fek066xrufu9u9w59mp';
t('z-address -> THORChain q without prefix + token form', () => { const d = bridge.bchDestination(PRIZE_Z); return typeof d === 'object' && d.thor === BCHQ && d.token === PRIZE_Z; });
t('bare q accepted', () => { const d = bridge.bchDestination(BCHQ); return typeof d === 'object' && d.thor === BCHQ; });
const PAY = la.decodeCashAddress(PRIZE_Z).payload;
const CHIP_Q = la.encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: PAY }).address;
const P2SH = la.encodeCashAddress({ prefix: 'bitcoincash', type: 'p2sh', payload: PAY }).address;
t('chipnet address refused (for the network)', () => /mainnet/.test(bridge.bchDestination(CHIP_Q)));
t('p2sh refused (for the type)', () => /script address/.test(bridge.bchDestination(P2SH)));
t('bad checksum refused', () => /not a valid/.test(bridge.bchDestination(BCHQ.slice(0, -1) + 'x')));
t('EVM: valid / zero / short', () => bridge.evmDestination(DEAD) === DEAD && bridge.evmDestination('0x' + '0'.repeat(40)) === null && bridge.evmDestination('0x1234') === null);

// Cauldron halves on fake pools
const pool = (id, sats, tokens) => ({ pool_id: id, txid: id.padEnd(64, '0'), tx_pos: 0, sats, tokens, token_id: 'aa'.repeat(32), owner_pkh: '00'.repeat(20) });
const pools = [pool('a', 50_000_000, 100_000), pool('b', 40_000_000, 100_000), pool('c', 1_000, 10)];
t('bestSell picks the pool paying the most BCH', () => {
  const s = bridge.bestSell(pools, 500n);
  const all = pools.map((p) => calcSellToPool(quote.toSdkPool(p), 500n).supplyAmount);
  return s && s.pool.pool_id === 'a' && s.sats === all.reduce((m, x) => (x > m ? x : m), 0n);
});
t('maxBuyWithSats: exact boundary on every pool', () => {
  for (const sats of [1_000n, 123_456n, 2_500_000n]) {
    const b = bridge.maxBuyWithSats(pools, sats);
    if (!b) return false;
    const sp = quote.toSdkPool(b.pool);
    if (calcBuyFromPool(sp, b.units).supplyAmount > sats) return false;
    if (b.units + 1n < BigInt(b.pool.tokens) && calcBuyFromPool(sp, b.units + 1n).supplyAmount <= sats) return false;
    for (const p of pools) { // no other pool sells more
      const q = quote.toSdkPool(p); const n = b.units + 1n;
      if (n < BigInt(p.tokens) && calcBuyFromPool(q, n).supplyAmount <= sats) return false;
    }
  }
  return true;
});
t('maxBuyWithSats: 0 sats -> null', () => bridge.maxBuyWithSats(pools, 0n) === null);

// rule 5: re-quote right before signing
const shown = quote.bestQuote(pools, 500n);
t('fresh: same pools -> ok, not moved', () => { const f = quote.freshQuote(shown, pools); return f.ok && !f.moved; });
t('fresh: pool traded at the same price -> ok, moved, new UTXO', () => {
  const p2 = pools.map((p) => (p.pool_id === shown.pool.pool_id ? { ...p, txid: 'ff'.repeat(32) } : p));
  const f = quote.freshQuote(shown, p2); return f.ok && f.moved && f.quote.pool.txid === 'ff'.repeat(32);
});
t('fresh: price +0.3% (inside 0.5%) -> ok', () => {
  const p2 = pools.map((p) => ({ ...p, sats: Math.round(p.sats * 1.003) }));
  return quote.freshQuote(shown, p2).ok;
});
t('fresh: price +2% -> price-up with the new quote', () => {
  const p2 = pools.map((p) => ({ ...p, sats: Math.round(p.sats * 1.02) }));
  const f = quote.freshQuote(shown, p2); return !f.ok && f.reason === 'price-up' && f.quote && f.quote.poolSats > shown.poolSats;
});
t('fresh: liquidity gone -> gone', () => { const f = quote.freshQuote(shown, [pool('z', 1000, 10)]); return !f.ok && f.reason === 'gone'; });

let fail = 0;
for (const [name, fn] of cases) {
  let ok = false, err = '';
  try { ok = await fn(); } catch (e) { err = String(e).slice(0, 160); }
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${err ? `  (${err})` : ''}`);
}
console.log(`${cases.length - fail}/${cases.length} passed`);
process.exit(fail ? 1 : 0);
