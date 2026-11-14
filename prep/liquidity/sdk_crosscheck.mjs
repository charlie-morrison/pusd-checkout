// Cross-check of measure.py with the SDK's own optimal split (computeOptimalBuy + calcBuyFromPool).
// Usage: node sdk_crosscheck.mjs <sdk dist/index.js path> <pools.json> <bch_usd>
// Read-only: pure math on the indexer snapshot, no provider, no keys, no broadcast.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [sdkPath, poolsPath, bchUsdArg] = process.argv.slice(2);
const sdk = await import(pathToFileURL(sdkPath).href);
const PUSD = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const pools = JSON.parse(readFileSync(poolsPath, 'utf8')).active.filter(p => p.token_id === PUSD);
const bchUsd = Number(bchUsdArg);
const unit = 100n; // 2 decimals (BCMR)
const out = [];
for (const usd of [1, 5, 10, 20, 50, 100, 500, 1000]) {
  const target = BigInt(usd) * unit;
  const alloc = sdk.computeOptimalBuy(pools, target, 1n);
  let sats = 0n, fee = 0n, got = 0n;
  for (const a of alloc) {
    // the SDK already returns the per-pool cost; recompute it from calcBuyFromPool as a self-check
    const r = sdk.calcBuyFromPool(a.pool, a.demandAmount);
    if (r.supplyAmount !== a.supplyAmount || r.feeAmount !== a.feeAmount) throw new Error('SDK self-check mismatch');
    sats += a.supplyAmount; fee += a.feeAmount; got += a.demandAmount;
  }
  const minerSats = Math.ceil((300 + 200 * alloc.length + 141) * 1.2);
  const payUsd = (Number(sats) + minerSats) * bchUsd / 1e8;
  out.push({ usd, pools_used: alloc.length, tokens: Number(got), pool_sats: Number(sats), lp_fee_sats: Number(fee),
             miner_fee_sats: minerSats, buyer_pays_usd: +payUsd.toFixed(4), overpay_vs_peg_pct: +((payUsd / usd - 1) * 100).toFixed(3) });
}
console.log(JSON.stringify(out, null, 1));
