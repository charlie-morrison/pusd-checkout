// Finds the buyer's coins across the wallet's HD addresses (build rule 8, measured 11.11).
//
// An HD wallet does not keep its coins on receive/0: Paytaca hands out a fresh receive address per
// payment and sends change to the change chain, so a page that reads one address tells a buyer who
// has money that they have none. This walks the receive (0) and change (1) chains from the xpubs the
// wallet shared and stops a chain after GAP_LIMIT unused addresses in a row (the usual BIP44 rule;
// the BLAZE organizer gives ~20 for Selene, TG #3150).
//
// "Used" means the address has any history, not just unspent coins: an address that was paid and
// then emptied still counts, otherwise the scan would stop in front of a wallet's later addresses.

import { encodeCashAddress, hash160 } from '@bitauth/libauth';

export const GAP_LIMIT = 20;
export type ChainName = 'receive' | 'change';
export const CHAINS: { name: ChainName; child: number }[] = [
  { name: 'receive', child: 0 },
  { name: 'change', child: 1 },
];

export interface ChainUtxo {
  txid: string;
  vout: number;
  satoshis: bigint;
  token?: unknown;
}

// What the scan needs from the chain; the page passes an Electrum-backed reader, tests pass a fake.
export interface ChainReader {
  history(address: string): Promise<unknown[]>;
  utxos(address: string): Promise<ChainUtxo[]>;
}

export interface FoundUtxo extends ChainUtxo {
  chain: ChainName;
  index: number;
  address: string;
}

export interface ChainSummary {
  checked: number;      // addresses looked at on this chain
  lastUsed: number;     // highest used index, -1 = none
  stopped: 'gap' | 'max' | 'no-xpub';
}

export interface ScanResult {
  utxos: FoundUtxo[];         // every unspent output found, token outputs included
  spendable: FoundUtxo[];     // plain BCH outputs (no token): the only ones the page will spend
  spendableSats: bigint;
  tokenUtxos: number;         // left alone: spending them as plain BCH would burn the tokens
  chains: Record<ChainName, ChainSummary>;
}

export type PubkeyAt = (child: number, index: bigint) => Uint8Array | undefined;

export function addressOf(pub: Uint8Array, prefix: 'bitcoincash' | 'bchtest'): string {
  return encodeCashAddress({ prefix, type: 'p2pkh', payload: hash160(pub) }).address;
}

export async function scanWallet(pubkeyAt: PubkeyAt, prefix: 'bitcoincash' | 'bchtest', reader: ChainReader,
                                 opts: { gap?: number; maxPerChain?: number } = {}): Promise<ScanResult> {
  const gap = opts.gap ?? GAP_LIMIT;
  const maxPerChain = opts.maxPerChain ?? 1000;
  const utxos: FoundUtxo[] = [];
  const chains = {} as Record<ChainName, ChainSummary>;

  for (const { name, child } of CHAINS) {
    if (!pubkeyAt(child, 0n)) {
      chains[name] = { checked: 0, lastUsed: -1, stopped: 'no-xpub' };
      continue;
    }
    let misses = 0;
    let lastUsed = -1;
    let checked = 0;
    let stopped: ChainSummary['stopped'] = 'max';
    let next = 0;
    // Look `gap` addresses ahead in one parallel batch, then walk the batch in index order.
    outer: while (next < maxPerChain) {
      const batch: { index: number; address: string }[] = [];
      for (let i = next; i < Math.min(next + gap, maxPerChain); i++) {
        const pub = pubkeyAt(child, BigInt(i));
        if (!pub) throw new Error(`the wallet's ${name} key ${i} could not be derived`);
        batch.push({ index: i, address: addressOf(pub, prefix) });
      }
      next += batch.length;
      const histories = await Promise.all(batch.map((b) => reader.history(b.address)));
      for (let k = 0; k < batch.length; k++) {
        checked++;
        if (histories[k].length > 0) {
          misses = 0;
          lastUsed = batch[k].index;
          for (const u of await reader.utxos(batch[k].address)) {
            utxos.push({ ...u, chain: name, index: batch[k].index, address: batch[k].address });
          }
        } else if (++misses >= gap) {
          stopped = 'gap';
          break outer;
        }
      }
    }
    chains[name] = { checked, lastUsed, stopped };
  }

  const spendable = utxos.filter((u) => !u.token);
  return {
    utxos,
    spendable,
    spendableSats: spendable.reduce((s, u) => s + u.satoshis, 0n),
    tokenUtxos: utxos.length - spendable.length,
    chains,
  };
}

// WizardConnect input path for a found coin: [inputIndex, pathName, addressIndex].
export function inputPathOf(inputIndex: number, u: FoundUtxo): [number, ChainName, number] {
  return [inputIndex, u.chain, u.index];
}
