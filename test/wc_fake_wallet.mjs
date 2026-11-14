// Throwaway WizardConnect wallet for testing the page's connect flow (official @wizardconnect/wallet lib).
// Usage: node test/wc_fake_wallet.mjs <wiz:// uri> [--tamper-secret] [--seconds N]
// Prints JSON lines: the address the page should show for receive/0, then wallet-side events.
// The seed is random per run and never stored; nothing here holds funds.
import { createHash, randomBytes } from 'node:crypto';
import * as core from '@wizardconnect/core';
import { WalletConnectionManager } from '@wizardconnect/wallet';
import * as la from '@bitauth/libauth';

const args = process.argv.slice(2);
let uri = args[0];
const tamper = args.includes('--tamper-secret');
const si = args.indexOf('--seconds');
const seconds = si >= 0 ? Number(args[si + 1]) : 40;
const out = (o) => console.log(JSON.stringify(o));
process.on('uncaughtException', (e) => {
  // The relay library closes sockets that never opened; that is noise, not a failure of the test.
  if (/WebSocket was closed before the connection was established/.test(String(e?.message))) return;
  out({ fatal: String(e).slice(0, 200) }); process.exit(3);
});

const seed = randomBytes(32);
const root = la.deriveHdPrivateNodeFromSeed(seed);
const PATHS = { 0: "m/44'/145'/0'/0", 1: "m/44'/145'/0'/1", 7: "m/44'/145'/0'/7" };
const chainNode = (c) => { const n = la.deriveHdPath(root, PATHS[c]); if (typeof n === 'string') throw new Error(n); return n; };
const childPriv = (c, i) => { const n = la.deriveHdPrivateNodeChild(chainNode(c), Number(i)); if (typeof n === 'string') throw new Error(n); return n.privateKey; };
const pubOf = (k) => la.secp256k1.derivePublicKeyCompressed(k);

const pub0 = pubOf(childPriv(0, 0));
const addr = (prefix) => la.encodeCashAddress({ prefix, type: 'p2pkh', payload: la.hash160(pub0) }).address;
out({ expected: { mainnet: addr('bitcoincash'), chipnet: addr('bchtest') }, tamper });

if (tamper) {
  const dec = core.decodeKeyExchangeURI(uri);
  const other = core.generateKeyExchangeCredentials();
  uri = core.encodeKeyExchangeURI(dec.publicKey, other.secret,
    { hostname: dec.hostname, port: dec.port, protocol: dec.protocol }).uri;
  out({ tampered: core.decodeKeyExchangeURI(uri).secret !== dec.secret });
}

const wm = new WalletConnectionManager({
  walletName: tamper ? 'Test wallet (wrong secret)' : 'Test wallet (throwaway)',
  walletIcon: '',
  getRelayPrivateKey: (u) => new Uint8Array(createHash('sha256').update(seed).update(u).digest()),
  getPublicKey: (p, i) => pubOf(childPriv(Number(p), i)),
  getXpub: (p) => {
    const enc = la.encodeHdPublicKey({ network: 'mainnet', node: la.deriveHdPublicNode(chainNode(Number(p))) });
    return typeof enc === 'string' ? enc : enc.hdPublicKey;
  },
  signTransaction: async () => { throw new Error('this test wallet does not sign'); },
});
for (const ev of ['disconnect', 'connected', 'connectionstatus']) {
  wm.on?.(ev, (...a) => out({ event: ev, detail: String(a[0] ?? '').slice(0, 80) }));
}
try { wm.connect(uri); out({ connect: 'called' }); } catch (e) { out({ connect_error: String(e).slice(0, 200) }); }
setTimeout(() => { try { wm.disconnectAll(); } catch { /* ignore */ } out({ done: true }); process.exit(0); }, seconds * 1000);
