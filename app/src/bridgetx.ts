// Bridge OUT, the two BCH transactions the seller's wallet signs over WizardConnect (thor.ts explains why
// they cannot be one: THORChain wants a plain P2PKH spend with the vault first and the memo in OP_RETURN,
// and a Cauldron pool input is a covenant spend that build rule 4 puts at index 0).
//   A  sell:  input 0 the pool, then the seller's PUSD coins; outputs pool, token change, BCH proceeds
//   B  send:  input = A's BCH output; outputs THORChain vault, OP_RETURN memo (change only if >= 546 sat)
// Pool math mirrors the Cauldron SDK's own sell builder (transactions.js). Nothing here holds a key.

import {
  binToHex, cashAddressToLockingBytecode, decodeCashAddress, encodeCashAddress, encodeTransaction,
  type Transaction,
} from '@bitauth/libauth';
import { Contract, TransactionBuilder, placeholderP2PKHUnlocker, type NetworkProvider } from 'cashscript';
import { cauldronArtifactWithPkh, convertPoolToUtxo } from '@mr-zwets/cauldron-swap-sdk/dist/utils.js';
import type { Pool } from './pools';
import type { FoundUtxo } from './utxos';
import { CHANGE_DUST, MERCHANT_DUST, type PayTx } from './paytx.ts'; // explicit extension: unit tests load this in Node

const P2PKH_UNLOCK_MAX = 107;
const OP_RETURN_MAX = 80;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export interface TokenCoin extends FoundUtxo { token: { category: string; amount: bigint } }

export interface SellParams {
  pool: Pool;
  units: bigint;                 // PUSD units to sell
  tokenCoins: TokenCoin[];       // the seller's coins of this token (from the scan)
  proceedsAddress: string;       // plain P2PKH address of the seller: the BCH lands here
  proceedsPath: ['receive' | 'change', number];
  tokenChangeAddress: string;    // token-aware address of the seller, for unsold PUSD
  provider: NetworkProvider;
  label: string;
}

export interface SellTx extends PayTx {
  proceeds: bigint;              // sats of the BCH output the vault send spends
  proceedsVout: number;
  proceedsLock: Uint8Array;
  poolGives: bigint;             // sats out of the pool (after its 0.3% fee)
  deposited: bigint;             // tokens into the pool
}

// The SDK's sell arithmetic for one pool: the pool keeps K, takes its 0.3% fee on the BCH it pays out.
export function sellMath(pool: Pool, units: bigint) {
  const sats = BigInt(pool.sats), tokens = BigInt(pool.tokens);
  const k = sats * tokens;
  const newSatsExclFee = ceilDiv(k, tokens + units);
  const tradeValue = sats - newSatsExclFee;
  const fee = tradeValue * 3n / 1000n;
  const poolSats = newSatsExclFee + fee;
  const poolTokens = ceilDiv(k, newSatsExclFee); // can be a few units below tokens + units: those stay with the seller
  return { poolSats, poolTokens, poolGives: sats - poolSats, deposited: poolTokens - tokens, lpFee: fee };
}

export function buildSell(p: SellParams): SellTx | string {
  try { return buildSellUnsafe(p); } catch (e) { return `Could not build the sale: ${String(e).slice(0, 160)}`; }
}

function buildSellUnsafe(p: SellParams): SellTx | string {
  const cat = p.pool.token_id;
  if (p.units <= 0n) return 'Enter an amount above zero.';
  if (!p.pool.owner_pkh) return 'The pool record has no owner key hash.';
  const pa = decodeCashAddress(p.proceedsAddress);
  if (typeof pa === 'string' || pa.type !== 'p2pkh') return 'The proceeds address must be a plain P2PKH address.';
  const ta = decodeCashAddress(p.tokenChangeAddress);
  if (typeof ta === 'string' || ta.type !== 'p2pkhWithTokens') return 'The token change address must be token-aware.';
  const m = sellMath(p.pool, p.units);
  if (m.poolGives <= 0n || m.deposited <= 0n) return 'The pool cannot buy that amount.';

  // Fewest coins first: largest PUSD coins until they cover the units. Only this token, never NFTs.
  const mine = p.tokenCoins.filter((c) => c.token && c.token.category === cat && c.token.amount > 0n && !(c.token as { nft?: unknown }).nft)
    .sort((a, b) => (b.token.amount > a.token.amount ? 1 : b.token.amount < a.token.amount ? -1 : 0));
  const coins: TokenCoin[] = [];
  let have = 0n;
  for (const c of mine) { if (have >= p.units) break; coins.push(c); have += c.token.amount; }
  if (have < p.units) return `The wallet holds ${have} units of this token, less than ${p.units}.`;
  const tokenChange = have - m.deposited;   // includes the few units the pool's rounding leaves over
  const tokenDust = tokenChange > 0n ? MERCHANT_DUST : 0n;
  const satsIn = coins.reduce((s, c) => s + c.satoshis, 0n);

  const contract = new Contract(cauldronArtifactWithPkh(p.pool.owner_pkh), [], { provider: p.provider, addressType: 'p2sh32' });
  const poolUtxo = { ...convertPoolToUtxo(p.pool), lockingBytecode: binToHex((cashAddressToLockingBytecode(contract.address) as { bytecode: Uint8Array }).bytecode) };
  const build = (fee: bigint) => {
    const tb = new TransactionBuilder({ provider: p.provider, maximumFeeSatsPerByte: 10 });
    tb.addInput(poolUtxo, contract.unlock.swap());
    for (const c of coins) {
      const lock = cashAddressToLockingBytecode(c.address) as { bytecode: Uint8Array };
      tb.addInput({ txid: c.txid, vout: c.vout, satoshis: c.satoshis, lockingBytecode: binToHex(lock.bytecode),
        token: { category: cat, amount: c.token.amount } } as never, placeholderP2PKHUnlocker(c.address));
    }
    tb.addOutput({ to: contract.tokenAddress, amount: m.poolSats, token: { category: cat, amount: m.poolTokens } });
    if (tokenChange > 0n) tb.addOutput({ to: p.tokenChangeAddress, amount: tokenDust, token: { category: cat, amount: tokenChange } });
    tb.addOutput({ to: p.proceedsAddress, amount: satsIn + m.poolGives - tokenDust - fee });
    return tb.generateWcTransactionObject({ broadcast: true, userPrompt: '' });
  };
  const signedSize = (tx: Transaction) => BigInt(encodeTransaction(tx).length)
    + tx.inputs.slice(1).reduce((s, i) => s + BigInt(Math.max(0, P2PKH_UNLOCK_MAX - i.unlockingBytecode.length)), 0n);
  // Same trial-then-exact loop as paytx (rule 12): the trial fee must clear cashscript's 1 sat/B floor.
  let fee = BigInt(500 + 150 * coins.length);
  let o = build(fee);
  for (let pass = 0; pass < 3; pass++) {
    const need = signedSize(o.transaction as Transaction);
    if (need === fee) break;
    fee = need;
    o = build(fee);
  }
  const proceeds = satsIn + m.poolGives - tokenDust - fee;
  if (proceeds < CHANGE_DUST) return 'The sale would pay less BCH than a transaction output can carry.';
  const tx = o.transaction as Transaction;
  const proceedsVout = tx.outputs.length - 1;
  const inputPaths = coins.map((c, k) => [k + 1, c.chain, c.index] as [number, 'receive' | 'change', number]);
  return {
    hex: binToHex(encodeTransaction(tx)), transaction: tx, sourceOutputs: o.sourceOutputs as PayTx['sourceOutputs'], inputPaths,
    poolCost: 0n, networkFee: fee, buyerPays: 0n, change: proceeds,
    userPrompt: `Sell ${p.label} on a Cauldron pool for ${proceeds.toLocaleString('en-US')} sat to ${p.proceedsAddress} (step 1 of 2; step 2 sends it to THORChain)`,
    proceeds, proceedsVout, proceedsLock: tx.outputs[proceedsVout].lockingBytecode, poolGives: m.poolGives, deposited: m.deposited,
  };
}

export interface VaultSendParams {
  coin: { txid: string; vout: number; satoshis: bigint; lockingBytecode: Uint8Array; path: ['receive' | 'change', number] };
  vault: string;                 // THORChain inbound address, with or without "bitcoincash:"
  memo: string;
  amount: bigint;                // exactly what THORChain quoted for
  changeAddress: string;         // the input's own address (THORChain: "change back to self")
  feePerByte: bigint;            // THORChain's recommended BCH gas rate
  provider: NetworkProvider;
  label: string;
}

// Size of the vault send, signed: 1 P2PKH input, vault output, OP_RETURN with the memo, optional change.
export function vaultSendBytes(memoBytes: number, withChange: boolean) {
  const opret = 8 + 1 + 1 + (memoBytes >= 76 ? 2 : 1) + memoBytes; // value + script length + OP_RETURN + push op(s) + memo
  return BigInt(10 + 148 + 34 + opret + (withChange ? 34 : 0));
}

export function buildVaultSend(p: VaultSendParams): PayTx | string {
  try { return buildVaultSendUnsafe(p); } catch (e) { return `Could not build the send to THORChain: ${String(e).slice(0, 160)}`; }
}

function buildVaultSendUnsafe(p: VaultSendParams): PayTx | string {
  const memo = new TextEncoder().encode(p.memo);
  if (memo.length === 0 || memo.length > OP_RETURN_MAX) return 'The THORChain memo does not fit a BCH OP_RETURN.';
  const vaultAddr = p.vault.includes(':') ? p.vault : `bitcoincash:${p.vault}`;
  const va = decodeCashAddress(vaultAddr);
  if (typeof va === 'string' || va.type !== 'p2pkh' || va.prefix !== 'bitcoincash') return 'The THORChain vault is not a mainnet P2PKH address.';
  const ca = decodeCashAddress(p.changeAddress);
  if (typeof ca === 'string' || ca.type !== 'p2pkh') return 'The change address must be a plain P2PKH address.';
  const own = cashAddressToLockingBytecode(p.changeAddress) as { bytecode: Uint8Array };
  if (binToHex(own.bytecode) !== binToHex(p.coin.lockingBytecode)) return 'Change must go back to the address that sends (THORChain refunds there).';
  const spare = p.coin.satoshis - p.amount;
  const feeNo = vaultSendBytes(memo.length, false) * p.feePerByte;
  const feeWith = vaultSendBytes(memo.length, true) * p.feePerByte;
  const withChange = spare - feeWith >= CHANGE_DUST;
  const fee = withChange ? feeWith : spare;
  if (spare < feeNo) return 'The BCH from the sale does not cover the amount plus the network fee.';
  const tb = new TransactionBuilder({ provider: p.provider, maximumFeeSatsPerByte: 20 });
  tb.addInput({ txid: p.coin.txid, vout: p.coin.vout, satoshis: p.coin.satoshis, lockingBytecode: binToHex(p.coin.lockingBytecode) } as never,
    placeholderP2PKHUnlocker(p.changeAddress));
  tb.addOutput({ to: encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: va.payload }).address, amount: p.amount });
  if (withChange) tb.addOutput({ to: p.changeAddress, amount: spare - feeWith });
  tb.addOpReturnOutput([p.memo]);
  const o = tb.generateWcTransactionObject({ broadcast: true, userPrompt: '' });
  const tx = o.transaction as Transaction;
  return {
    hex: binToHex(encodeTransaction(tx)), transaction: tx, sourceOutputs: o.sourceOutputs as PayTx['sourceOutputs'],
    inputPaths: [[0, p.coin.path[0], p.coin.path[1]]], poolCost: 0n, networkFee: fee, buyerPays: p.amount + fee,
    change: withChange ? spare - feeWith : 0n,
    userPrompt: `Send ${p.amount.toLocaleString('en-US')} sat to the THORChain vault ${vaultAddr.slice(12, 22)}… for ${p.label} (step 2 of 2; memo ${p.memo.slice(0, 40)}…)`,
  };
}
