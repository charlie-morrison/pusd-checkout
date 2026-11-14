// BLAZE checkout prep: the dapp half of a LIVE test against the REAL Cashonize web app (cashonize.com) over the
// public WizardConnect relays. The wallet is a throwaway HD wallet created in a clean browser profile, never
// funded; the request is broadcast:false and spends a made-up source output at the wallet's own receive/0
// address, so nothing can reach the chain.
// Checks: pairing completes (keyexchangecomplete), the receive/0 address the dapp derives from the app's xpub
// equals the address the app shows, the app shows our request, its signed hex is VM-valid with outputs untouched.
//
// Usage: node24 wc_dapp_live.mjs <deps/node_modules> <uri_out.txt> <result.json> <expected_receive0_cashaddr>
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const [nm, uriOut, resOut, expectedAddr] = process.argv.slice(2);
const imp = (p) => import(pathToFileURL(path.join(nm, p)).href);
const core = await imp('@wizardconnect/core/dist/index.js');
const dappLib = await imp('@wizardconnect/dapp/dist/index.js');
const la = await imp('@bitauth/libauth/build/index.js');

process.on('uncaughtException', (e) => {
  if (/WebSocket was closed before the connection was established/.test(String(e && e.message))) return;
  console.error('FATAL', e); process.exit(3);
});
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const t0 = Date.now();
const r = { try: 2, what: 'WizardConnect live test vs real Cashonize web app', started: new Date().toISOString(), expected_receive0: expectedAddr };
const save = () => writeFileSync(resOut, JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) + '\n');

const dm = new dappLib.DappConnectionManager('BLAZE checkout test (no broadcast)', undefined, { session: false });
const relay = core.initiateDappRelay(({ client, status }) => dm.updateConnection(client, status));
r.keyexchangecomplete = false;
relay.events.on('keyexchangecomplete', () => { r.keyexchangecomplete = true; r.kx_ms = Date.now() - t0; save(); });
const ready = new Promise((res) => dm.once('walletready', res));
writeFileSync(uriOut, relay.uri + '\n');
r.uri_written = true; save();
console.log('URI', relay.uri);

const got = await Promise.race([ready.then(() => true), sleep(600000).then(() => false)]);
if (!got || !r.keyexchangecomplete) { r.stage = 'pairing'; r.ok = false; r.error = got ? 'walletready without keyexchangecomplete' : 'no wallet_ready in 10 min'; save(); process.exit(1); }
r.wallet_name = dm.walletName; r.protocol = dm.protocol; r.paths = dm.getSessionPaths().map((p) => p.name);
const buyerPub = dm.getPubkey(0, 0n);
const lock = la.encodeLockingBytecodeP2pkh(la.hash160(buyerPub));
const ca = la.lockingBytecodeToCashAddress({ prefix: 'bitcoincash', bytecode: lock });
r.derived_receive0 = typeof ca === 'string' ? ca : ca.address;
r.address_matches_app = r.derived_receive0 === expectedAddr;
save();

const merchantLock = la.encodeLockingBytecodeP2pkh(la.hash160(la.secp256k1.derivePublicKeyCompressed(randomBytes(32))));
const sourceOutputs = [{ outpointTransactionHash: randomBytes(32), outpointIndex: 0, sequenceNumber: 0xffffffff,
  unlockingBytecode: new Uint8Array(), lockingBytecode: lock, valueSatoshis: 100000n }];
const tx = { version: 2, locktime: 0,
  inputs: [{ outpointTransactionHash: sourceOutputs[0].outpointTransactionHash, outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
  outputs: [{ lockingBytecode: merchantLock, valueSatoshis: 90000n }, { lockingBytecode: lock, valueSatoshis: 9500n }] };
// Wire format the real app accepts (measured 06.11, try 1): bytes as PLAIN hex, bigint as '<bigint: Xn>'.
// libauth stringify's '<Uint8Array: 0x..>' form is listed as valid by @wizardconnect/core, but Cashonize's strict
// schema rejects it ('Invalid input at transaction.sourceOutputs[0].outpointTransactionHash').
const hexify = (x) => (x instanceof Uint8Array ? la.binToHex(x) : typeof x === 'bigint' ? `<bigint: ${x}n>`
  : Array.isArray(x) ? x.map(hexify) : (x && typeof x === 'object') ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, hexify(v)])) : x);
const wire = hexify({ transaction: la.binToHex(la.encodeTransaction(tx)), sourceOutputs, broadcast: false,
  userPrompt: 'prep test: made-up input, do not broadcast' });
r.wire_sample = { outpointTransactionHash: String(wire.sourceOutputs[0].outpointTransactionHash).slice(0, 16), valueSatoshis: wire.sourceOutputs[0].valueSatoshis };
r.sign_sent_at = new Date().toISOString(); save();
console.log('SIGN_SENT');
try {
  const resp = await Promise.race([dm.signTransaction({ transaction: wire, inputPaths: [[0, 'receive', 0]] }),
    sleep(600000).then(() => { throw new Error('no sign response in 10 min'); })]);
  const signed = la.decodeTransaction(la.hexToBin(resp.signedTransaction));
  r.signed_bytes = resp.signedTransaction.length / 2;
  const v = la.createVirtualMachineBch2025().verify({ sourceOutputs, transaction: signed });
  r.vm_bch2025 = v === true ? true : String(v).slice(0, 200);
  r.outputs_untouched = la.binToHex(la.encodeTransactionOutputs(signed.outputs)) === la.binToHex(la.encodeTransactionOutputs(tx.outputs));
  r.sighash_byte = (() => { const ub = signed.inputs[0].unlockingBytecode; const len = ub[0]; return ub[len]; })();
  r.ok = r.vm_bch2025 === true && r.outputs_untouched && r.address_matches_app;
  r.stage = 'signed';
} catch (e) { r.stage = 'sign'; r.ok = false; r.sign_error = String(e).slice(0, 300); }
save();
try { await dm.sendDisconnect('test done'); } catch { /* courtesy */ }
await sleep(1500); dm.destroy(); relay.cleanup();
console.log('DONE', r.ok);
process.exit(r.ok ? 0 : 1);
