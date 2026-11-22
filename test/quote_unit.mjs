// Unit test of the payment-link parser and the single-pool quote (app/src/quote.ts).
// Usage: node test/quote_unit.mjs [path to quote.ts]   (Node >= 23; the quote case reads LIVE mainnet pools)
// Exit 0 = all pass, 1 = a case failed.
import { pathToFileURL } from 'node:url';
import * as la from '@bitauth/libauth';
import { calcBuyFromPool, computeOptimalBuy } from '@mr-zwets/cauldron-swap-sdk';

const target = process.argv[2] ?? new URL('../app/src/quote.ts', import.meta.url).pathname;
const q = await import(pathToFileURL(target).href);

const PRIZE_Z = 'bitcoincash:zzmsqp8y48crckhv63y5mz9fek066xrufu9u9w59mp';
const payload = la.decodeCashAddress(PRIZE_Z).payload;
const PRIZE_Q = la.encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload }).address;
const CHIP_Z = la.encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload }).address;
const PUSD = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const s = (o) => '?' + new URLSearchParams(o).toString();

const cases = [];
const t = (name, fn) => cases.push([name, fn]);
t('no payment params -> generator (error null)', () => { const r = q.parsePayRequest('', 'bitcoincash', 2); return !r.ok && r.error === null; });
t('mainnet z-address + 12.50 -> 1250 units', () => { const r = q.parsePayRequest(s({ to: PRIZE_Z, usd: '12.50', memo: 'Order 7' }), 'bitcoincash', 2); return r.ok && r.req.units === 1250n && r.req.memo === 'Order 7'; });
t('address without prefix accepted', () => { const r = q.parsePayRequest(s({ to: PRIZE_Z.split(':')[1], usd: '1' }), 'bitcoincash', 2); return r.ok && r.req.units === 100n; });
t('non-token q-address rejected', () => { const r = q.parsePayRequest(s({ to: PRIZE_Q, usd: '1' }), 'bitcoincash', 2); return !r.ok && /cannot receive tokens/.test(r.error); });
t('chipnet address on mainnet rejected', () => { const r = q.parsePayRequest(s({ to: CHIP_Z, usd: '1' }), 'bitcoincash', 2); return !r.ok && /another network/.test(r.error); });
t('garbage address rejected', () => { const r = q.parsePayRequest(s({ to: 'bitcoincash:zzzz', usd: '1' }), 'bitcoincash', 2); return !r.ok && /not a valid/.test(r.error); });
t('link with an address but no amount -> says the amount is missing (19.11)', () => { const r = q.parsePayRequest(s({ to: PRIZE_Z }), 'bitcoincash', 2); return !r.ok && /no amount/.test(r.error); });
t('3 decimals rejected', () => typeof q.parseAmount('12.505', 2) === 'string');
t('0, 1001, 1e3, -1, empty rejected', () => ['0', '0.00', '1001', '1e3', '-1', ''].every((a) => typeof q.parseAmount(a, 2) === 'string'));
t('1000 accepted (cap), 0.01 accepted', () => q.parseAmount('1000', 2) === 100000n && q.parseAmount('0.01', 2) === 1n);
t('chipnet whole units: 40 ok, 40.5 rejected', () => q.parseAmount('40', 0) === 40n && typeof q.parseAmount('40.5', 0) === 'string');
t('memo over 64 chars rejected', () => { const r = q.parsePayRequest(s({ to: PRIZE_Z, usd: '1', memo: 'x'.repeat(65) }), 'bitcoincash', 2); return !r.ok && /memo/.test(r.error); });
t('pool too small for the amount -> skipped, none -> null', () => {
  const pools = [{ pool_id: 'a', txid: 'aa', tx_pos: 0, sats: 100000, tokens: 50, token_id: PUSD }];
  return q.bestQuote(pools, 50n) === null && q.bestQuote(pools, 49n) !== null;
});
t('payLink keeps net and sets to/usd/memo', () => {
  const l = new URL(q.payLink('https://x.example/pusd-checkout/?net=chipnet', CHIP_Z, '40', 'hi'));
  return l.searchParams.get('net') === 'chipnet' && l.searchParams.get('to') === CHIP_Z && l.searchParams.get('usd') === '40' && l.searchParams.get('memo') === 'hi';
});

// Our single-pool pick must be the cheapest pool by brute force (each pool priced on its own with the SDK's
// calcBuyFromPool), and never dearer than the SDK's optimiser capped at one pool. Not "equal to the SDK":
// computeOptimalBuy(maxPools 1) splits the buy across all pools, keeps the pool with the largest share and
// re-solves, which is a heuristic. Measured 22.11: on 20,000 random pool sets ours was cheaper 298 times and
// never dearer; the old equality check failed on live pools on 18.11 ($12.5) and 21.11 ($1) for this reason.
const bruteMin = (pools, units) => pools.filter((p) => BigInt(p.tokens) > units)
  .reduce((m, p) => { const c = calcBuyFromPool(q.toSdkPool(p), units).supplyAmount; return m === null || c < m ? c : m; }, null);
const checkPick = (pools, units, label) => {
  const ours = q.bestQuote(pools, units);
  const sdk = computeOptimalBuy(pools.map(q.toSdkPool), units, 1n, 1);
  const sdkCost = sdk.reduce((a, x) => a + x.supplyAmount, 0n);
  const min = bruteMin(pools, units);
  console.log(`   ${label}: ours ${ours?.poolSats} sat (pool ${ours?.pool.txid.slice(0, 8)}, lp fee ${ours?.lpFeeSats}) / brute min ${min} / sdk(1 pool) ${sdkCost} (${sdk[0]?.pool.txid.slice(0, 8)}) / ${pools.length} pools`);
  return { ok: !!ours && ours.poolSats === min && ours.poolSats <= sdkCost, ours, sdkCost };
};

// Fixture found by the 22.11 search (4 synthetic pools, 552 units): the SDK's one-pool pick costs 3,399 sat
// more than the cheapest pool, which is p2.
const fx = (id, sats, tokens) => ({ pool_id: id, txid: id.slice(1).repeat(64), tx_pos: 0, sats, tokens, token_id: PUSD });
const FIXTURE = [fx('p0', 125797302, 27282), fx('p1', 112346232, 23622), fx('p2', 863339268, 184238), fx('p3', 25918508, 5719)];
t('fixture 22.11: cheapest pool by brute force, cheaper than SDK computeOptimalBuy(maxPools 1)', () => {
  const r = checkPick(FIXTURE, 552n, 'fixture 552 units');
  return r.ok && r.ours.pool.pool_id === 'p2' && r.ours.poolSats === 2602253n && r.sdkCost === 2605652n;
});

const res = await fetch(`https://indexer.cauldron.quest/cauldron/pool/active?token=${PUSD}`);
const live = (await res.json()).active.filter((p) => p.token_id === PUSD);
for (const usd of [1, 12.5, 100]) {
  t(`live mainnet $${usd}: cheapest single pool by brute force, <= SDK computeOptimalBuy(maxPools 1)`, () =>
    checkPick(live, BigInt(Math.round(usd * 100)), `$${usd}`).ok);
}

let failed = 0;
for (const [name, fn] of cases) {
  let ok = false; try { ok = !!fn(); } catch (e) { console.log(`   threw: ${String(e).slice(0, 120)}`); }
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}
console.log(`${cases.length - failed}/${cases.length}`);
process.exit(failed ? 1 : 0);
