// Electrum (Fulcrum over browser WebSocket) reader for the wallet scan. One connection per scan:
// a wallet scan is 40+ requests, and the provider's default connect-per-request would redo the
// handshake for each of them.

import { ElectrumNetworkProvider, Network } from 'cashscript';
import { cashAddressToLockingBytecode, sha256, binToHex } from '@bitauth/libauth';
import type { ChainReader, ChainUtxo } from './utxos';

// Measured 20.11 on mainnet: the page's coin scan failed twice in a row on the default server
// (bch.imaginary.cash: "Connection lost", then "Failed to connect") and passed on the third press, while
// three other Fulcrum servers answered from the host. So every connection tries the next server on failure.
export const HOSTS: Record<'mainnet' | 'chipnet', (string | undefined)[]> = {
  mainnet: [undefined, 'electrum.imaginary.cash', 'bch.loping.net', 'fulcrum.greyh.at'], // undefined = cashscript default
  chipnet: [undefined],
};

export async function connectAny(net: 'mainnet' | 'chipnet'): Promise<ElectrumNetworkProvider> {
  let last: unknown = null;
  for (const hostname of HOSTS[net]) {
    const p = new ElectrumNetworkProvider(net === 'chipnet' ? Network.CHIPNET : Network.MAINNET,
      { manualConnectionManagement: true, ...(hostname ? { hostname } : {}) });
    try {
      await Promise.race([p.connect(), new Promise((_, r) => setTimeout(() => r(new Error('no answer in 10 s')), 10000))]);
      return p;
    } catch (e) { last = e; await p.disconnect().catch(() => undefined); }
  }
  throw new Error(`no Bitcoin Cash server answered (last: ${String((last as Error)?.message ?? last).slice(0, 80)})`);
}

function scripthashOf(address: string): string {
  const r = cashAddressToLockingBytecode(address);
  if (typeof r === 'string') throw new Error(`bad address ${address}: ${r}`);
  return binToHex(sha256.hash(r.bytecode).slice().reverse());
}

// Unspent outputs of an address as a Fulcrum node sees them now (mempool included): the chain-side check
// of a pool before signing (build rule 5), because the pool indexer can lag behind the chain.
export async function utxosAt(net: 'mainnet' | 'chipnet', address: string) {
  const provider = await connectAny(net);
  try { return await provider.getUtxos(address); } finally { await provider.disconnect().catch(() => undefined); }
}

// Sends a signed transaction the page has already checked (build rule 4) and returns its txid. If the node
// refuses it but already knows the same txid (the wallet sent it too, or a retry), that counts as sent.
export async function sendChecked(net: 'mainnet' | 'chipnet', hex: string, txid: string):
    Promise<{ txid: string; how: 'sent' | 'already-known' }> {
  const provider = await connectAny(net);
  try {
    try {
      const got = await provider.sendRawTransaction(hex);
      if (got !== txid) throw new Error(`the node answered with another txid (${String(got).slice(0, 16)}…)`);
      return { txid, how: 'sent' };
    } catch (e) {
      const known = await provider.performRequest('blockchain.transaction.get', txid).then(() => true, () => false);
      if (known) return { txid, how: 'already-known' };
      throw e;
    }
  } finally {
    await provider.disconnect().catch(() => undefined);
  }
}

export async function withElectrum<T>(net: 'mainnet' | 'chipnet',
                                      run: (reader: ChainReader) => Promise<T>): Promise<T> {
  const provider = await connectAny(net);
  const reader: ChainReader = {
    async history(address) {
      const h = await provider.performRequest('blockchain.scripthash.get_history', scripthashOf(address));
      if (!Array.isArray(h)) throw new Error(`unexpected history reply for ${address}`);
      return h;
    },
    async utxos(address): Promise<ChainUtxo[]> {
      return (await provider.getUtxos(address)).map((u) => ({
        txid: u.txid, vout: u.vout, satoshis: u.satoshis, token: u.token,
      }));
    },
  };
  try {
    return await run(reader);
  } finally {
    await provider.disconnect().catch(() => undefined);
  }
}
