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
