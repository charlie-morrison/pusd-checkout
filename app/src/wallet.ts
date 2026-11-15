// WizardConnect link to the buyer's wallet. Holds no keys: the wallet shares its xpubs over an
// encrypted relay and signs on its own side.
//
// Build rule 2 (measured 06.11): `walletready` also fires for a wallet that failed the pairing-secret
// check, so the page treats the wallet as connected only after BOTH `keyexchangecomplete` and
// `walletready`.

import { initiateDappRelay, type DappRelayResult } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { encodeCashAddress, hash160, binToHex } from '@bitauth/libauth';

export type LinkState =
  | { kind: 'idle' }
  | { kind: 'waiting'; uri: string; qrUri: string }
  | { kind: 'connected'; walletName: string; firstAddress: string; firstPubkeyHex: string }
  | { kind: 'error'; message: string };

export class WalletLink {
  private dm: DappConnectionManager | null = null;
  private relay: DappRelayResult | null = null;
  private keyExchanged = false;
  private walletReady = false;
  state: LinkState = { kind: 'idle' };

  constructor(private readonly addressPrefix: 'bitcoincash' | 'bchtest',
              private readonly onChange: (s: LinkState) => void) {}

  private set(s: LinkState) {
    this.state = s;
    this.onChange(s);
  }

  start() {
    this.stop(false);
    this.keyExchanged = false;
    this.walletReady = false;
    try {
      const dm = new DappConnectionManager('PUSD checkout', undefined, { session: false });
      const relay = initiateDappRelay(({ client, status }) => dm.updateConnection(client, status));
      this.dm = dm;
      this.relay = relay;
      relay.events.on('keyexchangecomplete', () => { this.keyExchanged = true; this.maybeConnected(); });
      dm.on('walletready', () => { this.walletReady = true; this.maybeConnected(); });
      dm.on('disconnect', () => {
        if (this.dm === dm) this.set({ kind: 'error', message: 'The wallet disconnected.' });
      });
      this.set({ kind: 'waiting', uri: relay.uri, qrUri: relay.qrUri });
    } catch (e) {
      this.set({ kind: 'error', message: `Could not open the relay: ${String(e).slice(0, 160)}` });
    }
  }

  private maybeConnected() {
    const dm = this.dm;
    if (!dm || !this.keyExchanged || !this.walletReady) return;
    const pub = dm.getPubkey(0, 0n);
    if (!pub) {
      this.set({ kind: 'error', message: 'The wallet did not share a receive key.' });
      return;
    }
    const { address } = encodeCashAddress({ prefix: this.addressPrefix, type: 'p2pkh', payload: hash160(pub) });
    this.set({ kind: 'connected', walletName: dm.walletName ?? 'Unnamed wallet', firstAddress: address,
      firstPubkeyHex: binToHex(pub) });
  }

  // Disconnect tells the wallet, then tears down the relay. `notify` = false on internal restarts.
  stop(notify = true) {
    const dm = this.dm;
    const relay = this.relay;
    this.dm = null;
    this.relay = null;
    if (notify) this.set({ kind: 'idle' });
    if (!dm) { relay?.cleanup(); return; }
    // Let the disconnect message leave before the sockets close (measured 14.11: tearing down at once
    // made the relay drop it), but never wait more than 2 s for a wallet that is already gone.
    const sent = this.keyExchanged
      ? Promise.race([dm.sendDisconnect('dapp closed the session').catch(() => undefined),
          new Promise((r) => setTimeout(r, 2000))])
      : Promise.resolve();
    void sent.then(() => { dm.destroy(); relay?.cleanup(); });
  }

  get manager() { return this.dm; }

  // Derives the wallet's public key at chain `child` (0 receive, 1 change), address `index`, from the
  // xpub it shared. Undefined before the wallet is ready or for a chain it did not share.
  pubkeyAt = (child: number, index: bigint): Uint8Array | undefined => {
    const dm = this.dm;
    if (!dm || this.state.kind !== 'connected' || !dm.hasPath(child)) return undefined;
    return dm.getPubkey(child, index);
  };
}
