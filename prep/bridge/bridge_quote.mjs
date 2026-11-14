// bridge_quote.mjs - READ-ONLY end-to-end quote for a PUSD <-> other-chain stablecoin bridge
// (BCH BLAZE "Stablecoin Bridge" bounty, preparation measured 10.11.2026 before the fork; nothing is signed or sent).
//
// Route measured:
//   OUT  PUSD (BCH) --Cauldron sell--> BCH --THORChain--> USDC on Base / USDT on BSC
//   IN   USDC on Base / USDT on BSC --THORChain--> BCH --Cauldron buy--> PUSD (BCH)
// Two BCH transactions on the OUT leg (the Cauldron swap, then a plain P2PKH send to the THORChain
// vault): THORChain's own quote notes say "Do not use exotic spend scripts", and a Cauldron pool input
// is a covenant spend, so the two legs are NOT merged into one tx here.
//
// Usage: node bridge_quote.mjs <node_modules dir> <evm 0x address> <bch cashaddr without prefix> [--json out.json]
// The addresses are quote destinations only: a THORChain quote moves no funds, but it needs a valid destination.
// rc 0 = every leg quoted · 3 = blind (an API failed or returned something unexpected; never a fake 0)
import fs from 'node:fs';

const [nm, evmDest, bchDest, flag, outPath] = process.argv.slice(2);
if (!nm || !/^0x[0-9a-fA-F]{40}$/.test(evmDest || '') || !/^[qp][0-9a-z]{41}$/.test(bchDest || '')) {
  console.error('usage: node bridge_quote.mjs <node_modules> <evm 0x address> <bch cashaddr without the bitcoincash: prefix> [--json out.json]');
  process.exit(3);
}
const sdk = await import(`${nm}/@mr-zwets/cauldron-swap-sdk/dist/index.js`);

const PUSD = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const PUSD_DECIMALS = 2;                       // BCMR, measured 04.11
const THOR = 'https://gateway.liquify.com/chain/thorchain_api/thorchain';
const DEST = {                                  // quote destinations only (a quote moves no funds)
  'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913': evmDest,
  'BSC.USDT-0X55D398326F99059FF775485246999027B3197955': evmDest,
};
const BCH_DEST = bchDest; // THORChain wants the cashaddr WITHOUT the bitcoincash: prefix (the memo splits on ':')
const SIZES_USD = [5, 20, 100];
const FEE_RATE = 1n;                            // sat/byte for our own BCH txs (BCH relay minimum)
const SEND_TX_BYTES = 300n;                     // 1 P2PKH in, vault + change + OP_RETURN(<=80 B) out

function blind(msg) { console.error('BLIND:', msg); process.exit(3); }
async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!r.ok) blind(`${url} -> HTTP ${r.status}`);
  return r.json();
}
async function thorQuote(from, to, amount1e8, dest) {
  const q = await getJson(`${THOR}/quote/swap?from_asset=${from}&to_asset=${to}&amount=${amount1e8}&destination=${dest}`);
  if (!q.expected_amount_out) blind(`thor quote ${from}->${to}: ${JSON.stringify(q).slice(0, 200)}`);
  return q;
}

const kraken = await getJson('https://api.kraken.com/0/public/Ticker?pair=BCHUSD');
const bchUsd = Number(Object.values(kraken.result || {})[0]?.c?.[0]);
if (!(bchUsd > 0)) blind('kraken BCHUSD');
const pools = await sdk.getCauldronPools(PUSD, 'mainnet');
if (!Array.isArray(pools) || pools.length === 0) blind('no PUSD pools from the indexer');

const unit = 10 ** PUSD_DECIMALS;
const rows = [];
for (const usd of SIZES_USD) {
  for (const asset of Object.keys(DEST)) {
    // OUT: sell N PUSD, send the BCH to THORChain
    const sellTokens = BigInt(usd * unit);
    const sell = sdk.computeOptimalSell(pools, sellTokens, FEE_RATE);
    const soldTokens = sell.reduce((a, x) => a + x.demandAmount, 0n);
    if (soldTokens !== sellTokens) blind(`sell split ${soldTokens} != ${sellTokens}`);
    const satsOut = sell.reduce((a, x) => a + x.supplyAmount, 0n);
    const swapBytes = 300n + 200n * BigInt(sell.length) + 141n * 2n;  // token input + fee input
    const satsToThor = satsOut - (swapBytes + SEND_TX_BYTES) * FEE_RATE;
    const qo = await thorQuote('BCH.BCH', asset, satsToThor.toString(), DEST[asset]);
    const outStable = Number(qo.expected_amount_out) / 1e8;

    // IN: send N stable to THORChain for BCH, then buy as many PUSD as that BCH affords
    const qi = await thorQuote(asset, 'BCH.BCH', String(usd * 1e8), BCH_DEST);
    const satsIn = BigInt(qi.expected_amount_out);
    let lo = 0n, hi = BigInt(Math.ceil(usd * 1.2 * unit));
    const cost = (t) => {
      const a = sdk.computeOptimalBuy(pools, t, FEE_RATE);
      return a.reduce((s, x) => s + x.supplyAmount, 0n) + (300n + 200n * BigInt(a.length) + 141n) * FEE_RATE;
    };
    while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (cost(mid) <= satsIn) lo = mid; else hi = mid - 1n; }
    const pusdIn = Number(lo) / unit;

    rows.push({
      usd, asset,
      out: { pusd_sold: usd, cauldron_pools: sell.length, bch_from_cauldron_sats: Number(satsOut),
             to_thor_sats: Number(satsToThor), thor_bps: qo.fees?.total_bps, thor_outbound_fee: Number(qo.fees?.outbound || 0) / 1e8,
             stable_received: outStable, end_to_end_cost_pct: +(100 * (1 - outStable / usd)).toFixed(3),
             thor_min_in_sats: Number(qo.recommended_min_amount_in), thor_seconds: qo.total_swap_seconds, memo: qo.memo },
      in: { stable_sent: usd, thor_bps: qi.fees?.total_bps, bch_received_sats: Number(satsIn), pusd_bought: pusdIn,
            end_to_end_cost_pct: +(100 * (1 - pusdIn / usd)).toFixed(3), thor_min_in: Number(qi.recommended_min_amount_in) / 1e8,
            thor_seconds: qi.total_swap_seconds, router: qi.router, memo: qi.memo },
    });
  }
}
const out = { measured_at: new Date().toISOString(), bch_usd_kraken: bchUsd, pusd_pools: pools.length,
              thor_notes_bch_inbound: (await thorQuote('BCH.BCH', Object.keys(DEST)[0], '8000000', DEST[Object.keys(DEST)[0]])).notes,
              rows };
for (const r of rows) {
  console.log(`$${String(r.usd).padStart(3)} ${r.asset.split('-')[0].padEnd(9)} OUT: ${r.usd} PUSD -> ${r.out.stable_received.toFixed(4)} (${r.out.end_to_end_cost_pct}% cost, thor ${r.out.thor_bps} bps, ~${r.out.thor_seconds}s) | IN: ${r.usd} -> ${r.in.pusd_bought.toFixed(2)} PUSD (${r.in.end_to_end_cost_pct}% cost, ~${r.in.thor_seconds}s)`);
}
if (flag === '--json' && outPath) fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
process.exit(0);
