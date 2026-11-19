// The checkout's product transaction: built here, signed by the buyer's wallet over WizardConnect.
//   input 0      the Cauldron pool (this page unlocks it with the contract's swap path; build rule 4)
//   inputs 1..n  the buyer's coins, each with its own wallet path (build rule 8: coins sit on many addresses)
//   outputs      pool (tokens - units, sats + cost), merchant (units of the token on 1000 sat), buyer change
// Pool math mirrors the Cauldron SDK's own buy builder. Nothing here holds a key.

import {
  binToHex, cashAddressToLockingBytecode, decodeCashAddress, decodeTransaction, encodeTransaction,
  encodeTransactionOutputs, hash256, hexToBin, type Transaction,
} from '@bitauth/libauth';
import { Contract, TransactionBuilder, placeholderP2PKHUnlocker, type NetworkProvider } from 'cashscript';
import { calcBuyFromPool } from '@mr-zwets/cauldron-swap-sdk';
import { cauldronArtifactWithPkh, convertPoolToUtxo } from '@mr-zwets/cauldron-swap-sdk/dist/utils.js';
import type { Pool } from './pools';
import type { FoundUtxo } from './utxos';
import { toSdkPool } from './quote.ts'; // explicit extension: the unit tests load this file in Node

export const MERCHANT_DUST = 1000n;   // sats carried by the merchant's token output (the SDK uses the same)
export const CHANGE_DUST = 546n;      // change below this is left to the miner instead
export const MAX_BUYER_INPUTS = 10;
const P2PKH_UNLOCK_MAX = 107;         // push(73-byte ECDSA sig + type) + push(33-byte key)

export interface PayParams {
  pool: Pool;
  units: bigint;                 // token units the merchant receives
  merchant: string;              // token-aware address of the merchant
  coins: FoundUtxo[];            // the buyer's spendable coins from the scan
  changeAddress: string;         // plain P2PKH address of the buyer (change/0 or receive/0)
  provider: NetworkProvider;     // only for cashscript's builder; nothing is broadcast from here
  feePerByte?: bigint;
  label: string;                 // e.g. "12.50 PUSD", for the wallet's prompt
}

export interface PayTx {
  hex: string;                   // unsigned tx, wire form for WizardConnect (build rule 7)
  transaction: Transaction;
  sourceOutputs: { lockingBytecode: Uint8Array; valueSatoshis: bigint; token?: unknown }[];
  inputPaths: [number, 'receive' | 'change', number][];
  poolCost: bigint;              // sats into the pool incl. its 0.3% fee
  networkFee: bigint;
  buyerPays: bigint;             // pool + merchant dust + network fee
  change: bigint;
  userPrompt: string;            // build rule 9: the cost is in the prompt (Paytaca shows no net line)
}

export function selectCoins(coins: FoundUtxo[], need: (n: number) => bigint): FoundUtxo[] | null {
  const sorted = [...coins].filter((c) => !c.token).sort((a, b) => (b.satoshis > a.satoshis ? 1 : b.satoshis < a.satoshis ? -1 : 0));
  const picked: FoundUtxo[] = [];
  let total = 0n;
  for (const c of sorted) {
    picked.push(c);
    total += c.satoshis;
    if (total >= need(picked.length)) return picked;
    if (picked.length >= MAX_BUYER_INPUTS) break;
  }
  return null;
}

export function buildPayment(p: PayParams): PayTx | string {
  // cashscript throws on a bad build (e.g. fee per byte too low); the page shows a sentence, not a stack.
  try { return buildPaymentUnsafe(p); } catch (e) { return `Could not build the payment: ${String(e).slice(0, 160)}`; }
}

function buildPaymentUnsafe(p: PayParams): PayTx | string {
  const rate = p.feePerByte ?? 1n;
  const tokens = BigInt(p.pool.tokens);
  if (p.units <= 0n || p.units >= tokens) return 'The pool cannot sell that many tokens.';
  const m = decodeCashAddress(p.merchant);
  if (typeof m === 'string' || (m.type !== 'p2pkhWithTokens' && m.type !== 'p2shWithTokens')) return 'The merchant address cannot receive tokens.';
  const ch = decodeCashAddress(p.changeAddress);
  if (typeof ch === 'string' || ch.type !== 'p2pkh') return 'The change address must be a plain P2PKH address.';
  if (!p.pool.owner_pkh) return 'The pool record has no owner key hash.';

  const { supplyAmount: poolCost } = calcBuyFromPool(toSdkPool(p.pool), p.units);
  const contract = new Contract(cauldronArtifactWithPkh(p.pool.owner_pkh), [], { provider: p.provider, addressType: 'p2sh32' });
  const poolUtxo = { ...convertPoolToUtxo(p.pool), lockingBytecode: binToHex((cashAddressToLockingBytecode(contract.address) as { bytecode: Uint8Array }).bytecode) };
  const category = p.pool.token_id;

  const estimate = (n: number) => BigInt(445 + 148 * Math.max(0, n - 1)) * rate;
  const coins = selectCoins(p.coins, (n) => poolCost + MERCHANT_DUST + estimate(n));
  if (!coins) return 'The wallet does not hold enough BCH for this payment.';
  const total = coins.reduce((s, c) => s + c.satoshis, 0n);

  const build = (fee: bigint) => {
    const tb = new TransactionBuilder({ provider: p.provider, maximumFeeSatsPerByte: 10 });
    tb.addInput(poolUtxo, contract.unlock.swap());
    for (const c of coins) {
      const lock = cashAddressToLockingBytecode(c.address) as { bytecode: Uint8Array };
      tb.addInput({ txid: c.txid, vout: c.vout, satoshis: c.satoshis, lockingBytecode: binToHex(lock.bytecode) } as never,
        placeholderP2PKHUnlocker(c.address));
    }
    tb.addOutput({ to: contract.tokenAddress, amount: BigInt(p.pool.sats) + poolCost, token: { category, amount: tokens - p.units } });
    tb.addOutput({ to: p.merchant, amount: MERCHANT_DUST, token: { category, amount: p.units } });
    const change = total - poolCost - MERCHANT_DUST - fee;
    if (change >= CHANGE_DUST) tb.addOutput({ to: p.changeAddress, amount: change });
    return { o: tb.generateWcTransactionObject({ broadcast: true, userPrompt: '' }), change: change >= CHANGE_DUST ? change : 0n };
  };
  // Size the fee on the SIGNED tx: a buyer input's unlock in the request may be empty, and the wallet's
  // P2PKH unlock is at most 107 bytes (ECDSA; Schnorr is 100). Repeat until the fee stops moving.
  const signedSize = (tx: Transaction) => BigInt(encodeTransaction(tx).length)
    + tx.inputs.slice(1).reduce((s, i) => s + BigInt(Math.max(0, P2PKH_UNLOCK_MAX - i.unlockingBytecode.length)), 0n);
  // The first trial build needs a fee cashscript accepts (>= 1 sat/B of ITS size). 445 B was measured on chipnet; a
  // mainnet PUSD pool with millions of units makes the tx a few bytes longer (19.11: "fee per byte of 0.99" on the
  // live page). So the trial carries 100 B of headroom, capped at what the coins can pay; the loop below then sets
  // the exact fee from the signed size. Coin selection keeps the plain estimate: the final check decides "enough".
  const spare = total - poolCost - MERCHANT_DUST;
  let fee = estimate(coins.length) + 100n * rate;
  if (fee > spare) fee = spare;
  let b: ReturnType<typeof build>;
  try { b = build(fee); } catch (e) {
    if (fee === spare && /fee per byte/i.test(String(e))) return 'The wallet does not hold enough BCH for this payment.';
    throw e;
  }
  for (let pass = 0; pass < 3; pass++) {
    const need = signedSize(b.o.transaction as Transaction) * rate;
    if (need === fee) break;
    fee = need;
    b = build(fee);
  }
  const minFee = signedSize(b.o.transaction as Transaction) * rate;
  if (b.change === 0n) fee = total - poolCost - MERCHANT_DUST; // dust change goes to the miner
  if (fee < minFee) return 'The wallet does not hold enough BCH for this payment.';

  const tx = b.o.transaction as Transaction;
  const buyerPays = poolCost + MERCHANT_DUST + fee;
  const inputPaths = coins.map((c, k) => [k + 1, c.chain, c.index] as [number, 'receive' | 'change', number]);
  const bch = (Number(buyerPays) / 1e8).toFixed(8);
  return {
    hex: binToHex(encodeTransaction(tx)), transaction: tx,
    sourceOutputs: b.o.sourceOutputs as PayTx['sourceOutputs'], inputPaths,
    poolCost, networkFee: fee, buyerPays, change: b.change,
    userPrompt: `Pay ${buyerPays.toLocaleString('en-US')} sat (${bch} BCH) for ${p.label} to ${p.merchant}`,
  };
}

// Build rule 4: the wallet may only add signatures. Same version, locktime, outpoints and sequences, the
// outputs byte for byte, and the pool's unlock untouched; only the buyer inputs' unlocks may change.
export function checkSigned(req: PayTx, signedHex: string): string | null {
  let s: Transaction;
  try {
    const d = decodeTransaction(hexToBin(signedHex));
    if (typeof d === 'string') return `The wallet returned an unreadable transaction (${d.slice(0, 80)}).`;
    s = d;
  } catch { return 'The wallet returned something that is not a transaction.'; }
  const r = req.transaction;
  if (s.version !== r.version || s.locktime !== r.locktime) return 'The wallet changed the transaction version or locktime.';
  if (s.inputs.length !== r.inputs.length) return 'The wallet changed the number of inputs.';
  for (let i = 0; i < r.inputs.length; i++) {
    const a = r.inputs[i], b = s.inputs[i];
    if (binToHex(a.outpointTransactionHash) !== binToHex(b.outpointTransactionHash) || a.outpointIndex !== b.outpointIndex
      || a.sequenceNumber !== b.sequenceNumber) return `The wallet changed input ${i}.`;
    if (b.unlockingBytecode.length === 0) return `Input ${i} is not signed.`;
  }
  if (binToHex(s.inputs[0].unlockingBytecode) !== binToHex(r.inputs[0].unlockingBytecode)) return 'The wallet changed the pool input.';
  if (binToHex(encodeTransactionOutputs(s.outputs)) !== binToHex(encodeTransactionOutputs(r.outputs))) return 'The wallet changed the outputs.';
  return null;
}

// Relay form of the source outputs (build rule 1): bytes as hex, bigints as "<bigint: Xn>".
const toRelay = (x: unknown): unknown => (x instanceof Uint8Array ? binToHex(x) : typeof x === 'bigint' ? `<bigint: ${x}n>`
  : Array.isArray(x) ? x.map(toRelay) : x && typeof x === 'object'
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, v]) => [k, toRelay(v)])) : x);

// The WizardConnect `transaction` field. Build rule 7: the tx travels as hex. broadcast:false: the wallet
// hands the signed tx back and the page sends it only after checkSigned (rule 4), so nothing the buyer did
// not see can reach the chain.
export function wcRequest(tx: PayTx) {
  return { transaction: tx.hex, sourceOutputs: toRelay(tx.sourceOutputs), broadcast: false, userPrompt: tx.userPrompt };
}

export const txidOf = (hex: string) => binToHex(hash256(hexToBin(hex)).slice().reverse());

export const poolAddress = (pool: Pool, provider: NetworkProvider) =>
  new Contract(cauldronArtifactWithPkh(pool.owner_pkh ?? ''), [], { provider, addressType: 'p2sh32' }).address;

export interface LiveUtxo { txid: string; vout: number; satoshis: bigint; token?: { category: string; amount: bigint; nft?: unknown } }

// Build rule 5 on the chain, not on the indexer. Measured 17.11 on chipnet: five minutes after our own
// payment had spent a pool, the indexer still listed the spent outpoint, so a second payment built on it
// was refused by the node. Swap the indexer's pools of this owner for the outputs the chain holds now at
// the pool contract's address (same owner key, same token, no NFT). An owner may run several pools there.
export function livePoolsOf(owner: Pool, utxos: LiveUtxo[]): Pool[] {
  return utxos.filter((u) => u.token && u.token.category === owner.token_id && !u.token.nft && u.token.amount > 0n && u.satoshis > 0n)
    .map((u) => ({ ...owner, pool_id: `${u.txid}:${u.vout}`, txid: u.txid, tx_pos: u.vout,
      sats: Number(u.satoshis), tokens: Number(u.token!.amount) }));
}
