// Both bridge legs end to end: the Cauldron half (one pool, the SDK's own math, as in the checkout) and
// the THORChain half (thor.ts). Quotes only; sending comes later and re-quotes right before signing.

import { decodeCashAddress, encodeCashAddress } from '@bitauth/libauth';
import { calcBuyFromPool, calcSellToPool } from '@mr-zwets/cauldron-swap-sdk';
import type { Pool } from './pools';
import { toSdkPool } from './quote.ts'; // explicit extension: the unit tests load this file in Node
import { BCH_ASSET, chainStatus, quoteSwap, type QuoteResult, type Stable, type ThorState } from './thor.ts';

// Our own BCH transactions. The swap pays 1 sat/byte (the product tx shape, 445 B measured 06.11); the
// send to the THORChain vault pays THORChain's recommended BCH rate (gas_rate, 3 sat/byte on 16.11).
export const SWAP_TX_BYTES = 445n;
export const VAULT_SEND_BYTES = 300n; // 1 P2PKH input; vault, change and OP_RETURN (memo <= 80 B) outputs
export const DEFAULT_BCH_GAS_RATE = 3n;

export interface Sell { pool: Pool; sats: bigint; lpFee: bigint }
export interface Buy { pool: Pool; units: bigint; poolSats: bigint; lpFee: bigint }

// OUT, Cauldron half: the single pool that pays the most BCH for `units` tokens.
export function bestSell(pools: Pool[], units: bigint): Sell | null {
  let best: Sell | null = null;
  for (const p of pools) {
    const { supplyAmount, feeAmount } = calcSellToPool(toSdkPool(p), units);
    if (supplyAmount > 0n && (!best || supplyAmount > best.sats)) best = { pool: p, sats: supplyAmount, lpFee: feeAmount };
  }
  return best;
}

// IN, Cauldron half: the most tokens one pool sells for at most `sats` (pool input incl. its 0.3% fee).
export function maxBuyWithSats(pools: Pool[], sats: bigint): Buy | null {
  let best: Buy | null = null;
  if (sats <= 0n) return null;
  for (const p of pools) {
    const sp = toSdkPool(p);
    let lo = 0n, hi = BigInt(p.tokens) - 1n; // a pool keeps at least one token
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      if (calcBuyFromPool(sp, mid).supplyAmount <= sats) lo = mid; else hi = mid - 1n;
    }
    if (lo === 0n) continue;
    const c = calcBuyFromPool(sp, lo);
    if (!best || lo > best.units || (lo === best.units && c.supplyAmount < best.poolSats)) {
      best = { pool: p, units: lo, poolSats: c.supplyAmount, lpFee: c.feeAmount };
    }
  }
  return best;
}

// THORChain wants a plain P2PKH cashaddr WITHOUT the "bitcoincash:" prefix (the memo splits on ':'; a
// prefixed one fails "cannot parse 'bitcoincash' as an Address", measured 07.11 and 16.11). The PUSD then
// goes to the token-aware form of the same key, so the user may paste either form.
export function bchDestination(input: string): { thor: string; token: string } | string {
  const s = input.trim();
  const d = decodeCashAddress(s.includes(':') ? s : `bitcoincash:${s}`);
  if (typeof d === 'string') return 'That is not a valid Bitcoin Cash address.';
  if (d.prefix !== 'bitcoincash') return 'The bridge runs on mainnet: use a bitcoincash: address.';
  if (d.type !== 'p2pkh' && d.type !== 'p2pkhWithTokens') return 'Use a normal wallet address (P2PKH), not a script address.';
  const q = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: d.payload }).address;
  const z = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkhWithTokens', payload: d.payload }).address;
  return { thor: q.slice('bitcoincash:'.length), token: z };
}

export function evmDestination(input: string): string | null {
  const s = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return null;
  if (/^0x0{40}$/i.test(s)) return null;
  return s;
}

export interface OutQuote {
  sell: Sell; swapFee: bigint; sendFee: bigint; toThor: bigint; thor: QuoteResult;
}
export async function quoteOut(pools: Pool[], pusdUnits: bigint, stable: Stable, evmDest: string, state: ThorState): Promise<OutQuote | string> {
  const sell = bestSell(pools, pusdUnits);
  if (!sell) return 'No PUSD pool can buy that amount right now.';
  const rate = chainStatus(state.inbound, 'BCH').gasRate ?? DEFAULT_BCH_GAS_RATE;
  const swapFee = SWAP_TX_BYTES;
  const sendFee = VAULT_SEND_BYTES * rate;
  const toThor = sell.sats - swapFee - sendFee;
  if (toThor <= 0n) return 'The amount does not cover the two BCH network fees.';
  const thor = await quoteSwap({ from: BCH_ASSET, to: stable.asset, amountIn: toThor, destination: evmDest }, state);
  return { sell, swapFee, sendFee, toThor, thor };
}

export interface InQuote { thor: QuoteResult; swapFee: bigint; buy: Buy | null }
export async function quoteIn(pools: Pool[], amountIn: bigint, stable: Stable, bchThorDest: string, state: ThorState): Promise<InQuote> {
  const thor = await quoteSwap({ from: stable.asset, to: BCH_ASSET, amountIn, destination: bchThorDest }, state);
  const swapFee = SWAP_TX_BYTES;
  // BCH.BCH in 1e8 units == satoshis.
  const buy = thor.ok ? maxBuyWithSats(pools, thor.q.expectedOut - swapFee) : null;
  return { thor, swapFee, buy };
}
