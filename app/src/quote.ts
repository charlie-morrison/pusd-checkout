// Merchant payment link + live quote for the checkout.
//
// A link carries `to` (the merchant's token-aware CashAddress), `usd` (the price, in the merchant
// token's display units: PUSD on mainnet, where 1 PUSD ≈ $1; whole TEST units on chipnet) and an
// optional `memo`. The quote buys exactly that many token units from ONE Cauldron pool (build rule 4
// puts the pool input at index 0 and the product tx has one covenant input), picking the pool that
// costs the buyer the fewest satoshis. Pool math is the SDK's own `calcBuyFromPool`.

import { decodeCashAddress } from '@bitauth/libauth';
import { calcBuyFromPool, type CauldronActivePool } from '@mr-zwets/cauldron-swap-sdk';
import type { Pool } from './pools';

export const MAX_DISPLAY_AMOUNT = 1000; // demo cap: a checkout, not an OTC desk
export const MEMO_MAX = 64;

export interface PayRequest { to: string; units: bigint; display: string; memo: string }
export type ParseResult = { ok: true; req: PayRequest } | { ok: false; error: string } | { ok: false; error: null };

// `error: null` = the URL has no payment request at all (show the link generator instead).
export function parsePayRequest(search: string, prefix: 'bitcoincash' | 'bchtest', decimals: number): ParseResult {
  const q = new URLSearchParams(search);
  const to = (q.get('to') ?? '').trim();
  const amount = (q.get('usd') ?? '').trim();
  const memo = (q.get('memo') ?? '').trim();
  if (!to && !amount) return { ok: false, error: null };
  const addr = checkMerchantAddress(to, prefix);
  if (addr) return { ok: false, error: addr };
  const units = parseAmount(amount, decimals);
  if (typeof units === 'string') return { ok: false, error: units };
  if (memo.length > MEMO_MAX) return { ok: false, error: `The memo is longer than ${MEMO_MAX} characters.` };
  return { ok: true, req: { to, units, display: amount, memo } };
}

// The merchant receives CashTokens, so the address must be a token-aware one of this network.
export function checkMerchantAddress(to: string, prefix: 'bitcoincash' | 'bchtest'): string | null {
  if (!to) return 'The link has no merchant address (to=).';
  const withPrefix = to.includes(':') ? to : `${prefix}:${to}`;
  const d = decodeCashAddress(withPrefix);
  if (typeof d === 'string') return 'The merchant address is not a valid CashAddress.';
  if (d.prefix !== prefix) return `The merchant address is for another network (${d.prefix}), this page runs on ${prefix}.`;
  if (d.type !== 'p2pkhWithTokens' && d.type !== 'p2shWithTokens') {
    return 'The merchant address cannot receive tokens. Use a token-aware address (it starts with "z" after the prefix).';
  }
  return null;
}

export function parseAmount(amount: string, decimals: number): bigint | string {
  const re = decimals > 0 ? new RegExp(`^\\d{1,7}(\\.\\d{1,${decimals}})?$`) : /^\d{1,7}$/;
  if (!re.test(amount)) {
    return decimals > 0 ? `The amount must be a number with at most ${decimals} decimals.`
      : 'The amount must be a whole number on this network.';
  }
  const [whole, frac = ''] = amount.split('.');
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (units <= 0n) return 'The amount must be above zero.';
  if (units > BigInt(MAX_DISPLAY_AMOUNT) * 10n ** BigInt(decimals)) return `The amount is above the demo limit of ${MAX_DISPLAY_AMOUNT}.`;
  return units;
}

export interface Quote {
  pool: Pool;
  units: bigint;          // token units the merchant gets
  poolSats: bigint;       // sats the buyer puts into the pool (trade + 0.3% pool fee)
  lpFeeSats: bigint;
  networkFeeSats: bigint; // estimate for a one-input buyer; the real fee is set when the tx is built
}

// Measured 06.11 / 11.11: the product tx with one buyer input is 445 bytes; each extra P2PKH input adds ~148.
export function estimateNetworkFee(buyerInputs = 1, satsPerByte = 1n): bigint {
  return BigInt(445 + 148 * Math.max(0, buyerInputs - 1)) * satsPerByte;
}

export function toSdkPool(p: Pool): CauldronActivePool {
  return { owner_p2pkh_addr: p.owner_p2pkh_addr ?? '', owner_pkh: p.owner_pkh ?? '',
    sats: p.sats, token_id: p.token_id, tokens: p.tokens, tx_pos: p.tx_pos, txid: p.txid };
}

export function bestQuote(pools: Pool[], units: bigint, buyerInputs = 1): Quote | null {
  let best: Quote | null = null;
  for (const p of pools) {
    if (BigInt(p.tokens) <= units) continue;
    const { supplyAmount, feeAmount } = calcBuyFromPool(toSdkPool(p), units);
    if (!best || supplyAmount < best.poolSats) {
      best = { pool: p, units, poolSats: supplyAmount, lpFeeSats: feeAmount, networkFeeSats: estimateNetworkFee(buyerInputs) };
    }
  }
  return best;
}

// Build rule 5: re-quote right before the sign request. Every trade replaces a pool's UTXO, so a tx built
// on the pool the buyer saw can be invalid by the time the wallet signs. Use the fresh pool; if the price
// rose by more than `toleranceBps`, the buyer has to see and accept the new price first.
export type Fresh =
  | { ok: true; quote: Quote; moved: boolean }
  | { ok: false; reason: 'gone' | 'price-up'; quote: Quote | null; error: string };

export function freshQuote(shown: Quote, pools: Pool[], toleranceBps = 50n, buyerInputs = 1): Fresh {
  const q = bestQuote(pools, shown.units, buyerInputs);
  if (!q) return { ok: false, reason: 'gone', quote: null, error: 'No single pool can fill this payment any more.' };
  const moved = q.pool.txid !== shown.pool.txid || q.pool.tx_pos !== shown.pool.tx_pos;
  if (q.poolSats * 10000n > shown.poolSats * (10000n + toleranceBps)) {
    return { ok: false, reason: 'price-up', quote: q,
      error: `The price moved from ${shown.poolSats} to ${q.poolSats} sat since you saw it. Check the new price before paying.` };
  }
  return { ok: true, quote: q, moved };
}

export function payLink(base: string, to: string, amount: string, memo: string): string {
  const u = new URL(base);
  u.searchParams.set('to', to);
  u.searchParams.set('usd', amount);
  if (memo) u.searchParams.set('memo', memo); else u.searchParams.delete('memo');
  return u.toString();
}
