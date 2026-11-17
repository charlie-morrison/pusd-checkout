// Electrum (Fulcrum over browser WebSocket) reader for the wallet scan. One connection per scan:
// a wallet scan is 40+ requests, and the provider's default connect-per-request would redo the
// handshake for each of them.

import { ElectrumNetworkProvider, Network } from 'cashscript';
import { cashAddressToLockingBytecode, sha256, binToHex } from '@bitauth/libauth';
import type { ChainReader, ChainUtxo } from './utxos';

function scripthashOf(address: string): string {
  const r = cashAddressToLockingBytecode(address);
  if (typeof r === 'string') throw new Error(`bad address ${address}: ${r}`);
  return binToHex(sha256.hash(r.bytecode).slice().reverse());
}

// Unspent outputs of an address as a Fulcrum node sees them now (mempool included): the chain-side check
// of a pool before signing (build rule 5), because the pool indexer can lag behind the chain.
export async function utxosAt(net: 'mainnet' | 'chipnet', address: string) {
  const provider = new ElectrumNetworkProvider(net === 'chipnet' ? Network.CHIPNET : Network.MAINNET,
    { manualConnectionManagement: true });
  await provider.connect();
  try { return await provider.getUtxos(address); } finally { await provider.disconnect().catch(() => undefined); }
}

// Sends a signed transaction the page has already checked (build rule 4) and returns its txid. If the node
// refuses it but already knows the same txid (the wallet sent it too, or a retry), that counts as sent.
export async function sendChecked(net: 'mainnet' | 'chipnet', hex: string, txid: string):
    Promise<{ txid: string; how: 'sent' | 'already-known' }> {
  const provider = new ElectrumNetworkProvider(net === 'chipnet' ? Network.CHIPNET : Network.MAINNET,
    { manualConnectionManagement: true });
  await provider.connect();
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
  const provider = new ElectrumNetworkProvider(net === 'chipnet' ? Network.CHIPNET : Network.MAINNET,
    { manualConnectionManagement: true });
  await provider.connect();
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
