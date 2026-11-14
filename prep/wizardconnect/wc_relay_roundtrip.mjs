// BLAZE checkout prep, build prep before the 14.11 fork.
// Question: does a WizardConnect session work END TO END over the LIVE public Nostr relay from our host,
// with the official libraries the checkout will ship (@wizardconnect/dapp + @wizardconnect/wallet)?
// 05.11 proved Cashonize's signing code offline; the transport (pairing URI, key exchange, xpub handoff,
// sign request / response, large-message chunking) was untested.
// Method: dapp = DappConnectionManager + initiateDappRelay (default relays), wallet = WalletConnectionManager
// with a throwaway HD test wallet (random seed, never funded, nothing broadcast). The dapp builds a P2PKH
// spend for the buyer pubkey it derived itself from the wallet's xpub, sends it as a sign request, and judges
// the returned hex with libauth's BCH VM + an "outputs untouched" guard (the checkout's own check).
// Controls: tampered pairing secret -> no wallet_ready; wallet rejects -> dapp promise rejects; wallet bumps an
// output -> dapp guard flags it; 40 KB userPrompt -> chunked round trip.
//
// Usage: node24 wc_relay_roundtrip.mjs <deps/node_modules> [out.json]
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const [nm, outPath] = process.argv.slice(2);
const imp = (p) => import(pathToFileURL(path.join(nm, p)).href);
const core = await imp('@wizardconnect/core/dist/index.js');
const dappLib = await imp('@wizardconnect/dapp/dist/index.js');
const walletLib = await imp('@wizardconnect/wallet/dist/index.js');
const la = await imp('@bitauth/libauth/build/index.js');

const t0 = Date.now();
// Measured 06.11: after relay.cleanup() nostr-tools' pool closes a socket that is still connecting and `ws` emits
// an 'error' nobody listens to -> Node exits. Browsers do not crash on this. Count exactly this one, rethrow the rest.
const noise = { ws_closed_before_connect: 0 };
process.on('uncaughtException', (e) => {
  if (/WebSocket was closed before the connection was established/.test(String(e && e.message))) { noise.ws_closed_before_connect++; return; }
  console.error('FATAL', e); process.exit(3);
});
const ms = () => Date.now() - t0;
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const withTimeout = (p, n, what) => Promise.race([p, sleep(n).then(() => { throw new Error(`timeout ${what} ${n}ms`); })]);

// ---------- throwaway HD test wallet ----------
const seed = randomBytes(32);
const root = la.deriveHdPrivateNodeFromSeed(seed);
if (typeof root === 'string') throw new Error(root);
const CHAINS = { 0: "m/44'/145'/0'/0", 1: "m/44'/145'/0'/1", 7: "m/44'/145'/0'/7" };
const chainNode = (child) => {
  const n = la.deriveHdPath(root, CHAINS[child]);
  if (typeof n === 'string') throw new Error(n);
  return n;
};
const childPriv = (child, index) => {
  const n = la.deriveHdPrivateNodeChild(chainNode(child), Number(index));
  if (typeof n === 'string') throw new Error(n);
  return n.privateKey;
};
const pubOf = (priv) => la.secp256k1.derivePublicKeyCompressed(priv);
const p2pkh = (pub) => la.encodeLockingBytecodeP2pkh(la.hash160(pub));

function makeAdapter() {
  return {
    walletName: 'prep relay test wallet (throwaway)',
    walletIcon: '',
    getRelayPrivateKey: (uri) => new Uint8Array(createHash('sha256').update(seed).update(uri).digest()),
    getPublicKey: (p, index) => pubOf(childPriv(Number(p), index)),
    getXpub: (p) => {
      const pub = la.deriveHdPublicNode(chainNode(Number(p)));
      const enc = la.encodeHdPublicKey({ network: 'mainnet', node: pub });
      return typeof enc === 'string' ? enc : enc.hdPublicKey;
    },
    signTransaction: async () => { throw new Error('host app signs (pendingSignRequest)'); },
  };
}

// wallet-side signer: P2PKH inputs listed in inputPaths, SIGHASH_ALL|UTXOS|FORKID (0x61) like Cashonize
function walletSign(req, mode) {
  const wc = req.transaction;
  const txBin = typeof wc.transaction === 'string' ? la.hexToBin(wc.transaction) : la.encodeTransaction(wc.transaction);
  const tx = la.decodeTransaction(txBin);
  if (typeof tx === 'string') throw new Error(tx);
  const sourceOutputs = wc.sourceOutputs.map((o) => ({
    lockingBytecode: core.toUint8Array(o.lockingBytecode), valueSatoshis: core.toBigInt(o.valueSatoshis),
    ...(o.token ? { token: o.token } : {}),
  }));
  for (const [inputIndex, pathName, addressIndex] of req.inputPaths) {
    const child = core.childIndexOfPathName(pathName);
    const priv = childPriv(child, addressIndex);
    const pub = pubOf(priv);
    const sighashType = 0x61;
    const ser = la.generateSigningSerializationBch(
      { inputIndex, sourceOutputs, transaction: tx },
      { coveredBytecode: sourceOutputs[inputIndex].lockingBytecode, signingSerializationType: Uint8Array.of(sighashType) },
    );
    const digest = la.sha256.hash(la.sha256.hash(ser));
    const sig = la.secp256k1.signMessageHashSchnorr(priv, digest);
    if (typeof sig === 'string') throw new Error(sig);
    const sigWithType = la.flattenBinArray([sig, Uint8Array.of(sighashType)]);
    tx.inputs[inputIndex].unlockingBytecode = la.flattenBinArray([la.encodeDataPush(sigWithType), la.encodeDataPush(pub)]);
  }
  if (mode === 'bump_output') tx.outputs[0].valueSatoshis += 1n;
  return la.binToHex(la.encodeTransaction(tx));
}

// ---------- one session ----------
async function session({ tamperSecret = false, walletMode = 'sign', bigPrompt = false, waitReadyMs = 45000 }) {
  const r = { tamperSecret, walletMode, bigPrompt };
  const dm = new dappLib.DappConnectionManager('prep relay test (checkout prep)', undefined, { session: false });
  const relay = core.initiateDappRelay(({ client, status }) => dm.updateConnection(client, status));
  // the authenticated pairing signal; walletready alone also fires for a wallet that failed the secret check
  r.keyexchangecomplete = false;
  relay.events.on('keyexchangecomplete', () => { r.keyexchangecomplete = true; });
  r.uri_prefix = relay.uri.slice(0, 16);
  r.relays_in_uri = (relay.uri.match(/relay[^&]*/g) || []).slice(0, 3);
  let uri = relay.uri;
  if (tamperSecret) {
    // same dapp pubkey + relay, but a DIFFERENT valid secret (a bech32-valid URI, so the wallet does connect
    // to the relay; only the key exchange must fail). Measured 06.11: flipping one character instead breaks the
    // bech32 checksum and the wallet throws at decode time, which tests the codec, not the handshake.
    const dec = core.decodeKeyExchangeURI(uri);
    const other = core.generateKeyExchangeCredentials();
    uri = core.encodeKeyExchangeURI(dec.publicKey, other.secret, { hostname: dec.hostname, port: dec.port, protocol: dec.protocol }).uri;
    r.tampered = uri !== relay.uri && core.decodeKeyExchangeURI(uri).secret !== dec.secret && core.decodeKeyExchangeURI(uri).publicKey === dec.publicKey;
  }
  const ready = new Promise((res) => dm.once('walletready', (msg) => res(msg)));
  const wm = new walletLib.WalletConnectionManager(makeAdapter());
  wm.on('pendingSignRequest', async ({ connectionId, request }) => {
    r.wallet_got_request_ms = ms();
    r.wallet_request_prompt_len = (request.transaction.userPrompt || '').length;
    try {
      if (walletMode === 'reject') return await wm.sendSignError(connectionId, request.sequence, 'user rejected (control)');
      await wm.sendSignResponse(connectionId, request.sequence, walletSign(request, walletMode));
    } catch (e) { r.wallet_error = String(e).slice(0, 200); }
  });
  const tConnect = ms();
  let connId;
  try { connId = wm.connect(uri); } catch (e) {
    r.wallet_ready = false; r.error = `connect threw: ${String(e).slice(0, 160)}`;
    dm.destroy(); relay.cleanup();
    return r;
  }
  try {
    const msg = await withTimeout(ready, waitReadyMs, 'wallet_ready');
    r.wallet_ready_ms = ms() - tConnect;
    await sleep(1500);
    r.walletready_without_keyexchange = !r.keyexchangecomplete;
    r.wallet_name_seen_by_dapp = dm.walletName;
    r.protocol = dm.protocol;
    r.paths = dm.getSessionPaths().map((p) => p.name);
  } catch (e) {
    r.wallet_ready = false; r.error = String(e).slice(0, 160);
    wm.disconnectAll(); dm.destroy(); relay.cleanup();
    return r;
  }
  // dapp derives the buyer key from the xpub it received, never from the wallet's private side
  const buyerPub = dm.getPubkey(0, 0n);
  r.xpub_pubkey_matches_wallet = !!buyerPub && la.binToHex(buyerPub) === la.binToHex(pubOf(childPriv(0, 0)));
  const merchantPub = pubOf(randomBytes(32));
  const sourceOutputs = [{
    outpointTransactionHash: randomBytes(32), outpointIndex: 0, sequenceNumber: 0xffffffff,
    unlockingBytecode: new Uint8Array(), lockingBytecode: p2pkh(buyerPub), valueSatoshis: 100000n,
  }];
  const tx = {
    version: 2, locktime: 0,
    inputs: [{ outpointTransactionHash: sourceOutputs[0].outpointTransactionHash, outpointIndex: 0,
      sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
    outputs: [{ lockingBytecode: p2pkh(merchantPub), valueSatoshis: 90000n },
      { lockingBytecode: p2pkh(buyerPub), valueSatoshis: 9500n }],
  };
  const userPrompt = bigPrompt ? 'x'.repeat(40000) : 'prep relay test: pay merchant 90000 sats';
  const tSign = ms();
  try {
    // The relay client does a bare JSON.stringify: bigint throws, and a raw Uint8Array would silently become
    // {"0":..,"1":..}. Encode with libauth's stringify (the protocol's <bigint: Xn> / <Uint8Array: 0x..> format).
    const wire = JSON.parse(la.stringify({ transaction: la.binToHex(la.encodeTransaction(tx)), sourceOutputs, broadcast: false, userPrompt }));
    r.wire_sample = { valueSatoshis: wire.sourceOutputs[0].valueSatoshis, lockingBytecode: String(wire.sourceOutputs[0].lockingBytecode).slice(0, 24) };
    const resp = await withTimeout(dm.signTransaction({ transaction: wire, inputPaths: [[0, 'receive', 0]] }), 60000, 'sign_response');
    r.sign_roundtrip_ms = ms() - tSign;
    const signedHex = resp.signedTransaction;
    const signed = la.decodeTransaction(la.hexToBin(signedHex));
    r.signed_bytes = signedHex.length / 2;
    const vm = la.createVirtualMachineBch2025();
    const v = vm.verify({ sourceOutputs, transaction: signed });
    r.vm_bch2025 = v === true ? true : String(v).slice(0, 160);
    r.outputs_untouched = la.binToHex(la.encodeTransactionOutputs(signed.outputs)) === la.binToHex(la.encodeTransactionOutputs(tx.outputs));
    r.ok = r.vm_bch2025 === true && r.outputs_untouched;
  } catch (e) {
    r.sign_error = String(e).slice(0, 200);
    r.ok = false;
  }
  try { await dm.sendDisconnect('test done'); } catch { /* courtesy only */ }
  wm.disconnect(connId); dm.destroy(); relay.cleanup();
  return r;
}

const out = {
  what: 'WizardConnect live-relay round trip (official libs), BLAZE checkout prep',
  run_at: new Date().toISOString(),
  libs: { dapp: '0.2.2', wallet: '0.2.3', core: '0.2.5', libauth: '3.1.0-next.8' },
  default_relays: core.DEFAULT_RELAY_URLS,
  node: process.version,
  results: {},
};
out.results.main = await session({});
out.results.control_tampered_secret = await session({ tamperSecret: true, waitReadyMs: 25000 });
out.results.control_wallet_rejects = await session({ walletMode: 'reject' });
out.results.control_wallet_bumps_output = await session({ walletMode: 'bump_output' });
out.results.large_prompt_40k = await session({ bigPrompt: true });
out.verdict = {
  main_ok: out.results.main.ok === true && out.results.main.xpub_pubkey_matches_wallet === true && out.results.main.keyexchangecomplete === true,
  // what must hold for the checkout: a wrong-secret wallet never completes the key exchange and gets no signature request through
  tampered_blocked: out.results.control_tampered_secret.tampered === true && out.results.control_tampered_secret.keyexchangecomplete === false && out.results.control_tampered_secret.ok !== true && !out.results.control_tampered_secret.wallet_got_request_ms,
  reject_surfaces: !!out.results.control_wallet_rejects.sign_error,
  bump_caught: out.results.control_wallet_bumps_output.outputs_untouched === false && out.results.control_wallet_bumps_output.ok === false,
  large_ok: out.results.large_prompt_40k.ok === true && out.results.large_prompt_40k.wallet_request_prompt_len === 40000,
};
out.node_noise = noise;
out.pass = Object.values(out.verdict).every(Boolean);
const s = JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1);
if (outPath) writeFileSync(outPath, s + '\n');
console.log(s);
process.exit(out.pass ? 0 : 1);
