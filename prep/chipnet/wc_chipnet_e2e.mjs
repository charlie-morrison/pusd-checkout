// BLAZE checkout prep: END-TO-END on chipnet with the REAL Cashonize web app. The dapp pairs over the live
// WizardConnect relay, reads the wallet's real UTXO from a chipnet Electrum server, asks the wallet to sign AND
// broadcast (broadcast:true) a payment to a "merchant" address, then confirms on chain that the tx exists.
// Coins: tBCH from the public faucet (worthless test coins); the merchant is the faucet's own donation address,
// so the paid part goes back to the faucet.
//
// Usage: node24 wc_chipnet_e2e.mjs <deps/node_modules> <uri_out.txt> <result.json> <app_receive0_bchtest> <merchant_bchtest> <pay_sats>
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const [nm, uriOut, resOut, appAddr, merchantAddr, paySatsArg] = process.argv.slice(2);
const imp = (p) => import(pathToFileURL(path.join(nm, p)).href);
const core = await imp('@wizardconnect/core/dist/index.js');
const dappLib = await imp('@wizardconnect/dapp/dist/index.js');
const la = await imp('@bitauth/libauth/build/index.js');
const cs = await imp('cashscript/dist/index.js');

process.on('uncaughtException', (e) => {
  if (/WebSocket was closed before the connection was established/.test(String(e && e.message))) return;
  console.error('FATAL', e); process.exit(3);
});
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const t0 = Date.now();
const r = { what: 'WizardConnect chipnet E2E vs real Cashonize (sign + wallet broadcast)', started: new Date().toISOString(), app_receive0: appAddr, merchant: merchantAddr };
const save = () => writeFileSync(resOut, JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) + '\n');
const hexify = (x) => (x instanceof Uint8Array ? la.binToHex(x) : typeof x === 'bigint' ? `<bigint: ${x}n>`
  : Array.isArray(x) ? x.map(hexify) : (x && typeof x === 'object') ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, hexify(v)])) : x);
const addrOf = (pub) => { const a = la.lockingBytecodeToCashAddress({ prefix: 'bchtest', bytecode: la.encodeLockingBytecodeP2pkh(la.hash160(pub)) }); return typeof a === 'string' ? a : a.address; };
const lockOf = (addr) => { const d = la.cashAddressToLockingBytecode(addr); if (typeof d === 'string') throw new Error(d); return d.bytecode; };

const provider = new cs.ElectrumNetworkProvider('chipnet');
const dm = new dappLib.DappConnectionManager('BLAZE checkout chipnet E2E', undefined, { session: false });
const relay = core.initiateDappRelay(({ client, status }) => dm.updateConnection(client, status));
r.keyexchangecomplete = false;
relay.events.on('keyexchangecomplete', () => { r.keyexchangecomplete = true; save(); });
const ready = new Promise((res) => dm.once('walletready', res));
writeFileSync(uriOut, relay.uri + '\n'); save();
console.log('URI', relay.uri);

const got = await Promise.race([ready.then(() => true), sleep(600000).then(() => false)]);
if (!got || !r.keyexchangecomplete) { r.stage = 'pairing'; r.ok = false; save(); process.exit(1); }
r.wallet_name = dm.walletName;
const buyerPub = dm.getPubkey(0, 0n);
const changePub = dm.getPubkey(1, 0n);
r.derived_receive0 = addrOf(buyerPub);
r.address_matches_app = r.derived_receive0 === appAddr;
r.change_address = addrOf(changePub);
save();
if (!r.address_matches_app) { r.stage = 'address'; r.ok = false; save(); process.exit(1); }

// the wallet's real coin(s) at receive/0, as the checkout would read them
let utxos = [];
for (let i = 0; i < 20 && utxos.length === 0; i++) { utxos = await provider.getUtxos(appAddr); if (!utxos.length) await sleep(3000); }
r.utxos = utxos.map((u) => ({ txid: u.txid, vout: u.vout, sats: u.satoshis }));
if (!utxos.length) { r.stage = 'utxo'; r.ok = false; save(); process.exit(1); }
const u = utxos.filter((x) => !x.token).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
const pay = BigInt(paySatsArg);
const fee = 400n;
const change = u.satoshis - pay - fee;
const buyerLock = la.encodeLockingBytecodeP2pkh(la.hash160(buyerPub));
const sourceOutputs = [{ outpointTransactionHash: la.hexToBin(u.txid), outpointIndex: u.vout, sequenceNumber: 0xffffffff,
  unlockingBytecode: new Uint8Array(), lockingBytecode: buyerLock, valueSatoshis: u.satoshis }];
const tx = { version: 2, locktime: 0,
  inputs: [{ outpointTransactionHash: la.hexToBin(u.txid), outpointIndex: u.vout, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
  outputs: [{ lockingBytecode: lockOf(merchantAddr), valueSatoshis: pay }, { lockingBytecode: la.encodeLockingBytecodeP2pkh(la.hash160(changePub)), valueSatoshis: change }] };
r.planned = { input_sats: u.satoshis, pay, change, fee };
const wire = hexify({ transaction: la.binToHex(la.encodeTransaction(tx)), sourceOutputs, broadcast: true,
  userPrompt: `prep chipnet test: pay ${pay} sat to the faucet donation address` });
r.sign_sent_at = new Date().toISOString(); save();
console.log('SIGN_SENT');
try {
  const resp = await Promise.race([dm.signTransaction({ transaction: wire, inputPaths: [[0, 'receive', 0]] }),
    sleep(600000).then(() => { throw new Error('no sign response in 10 min'); })]);
  const bin = la.hexToBin(resp.signedTransaction);
  const signed = la.decodeTransaction(bin);
  r.txid = la.binToHex(la.sha256.hash(la.sha256.hash(bin)).reverse());
  r.vm_bch2025 = (() => { const v = la.createVirtualMachineBch2025().verify({ sourceOutputs, transaction: signed }); return v === true ? true : String(v).slice(0, 200); })();
  r.outputs_untouched = la.binToHex(la.encodeTransactionOutputs(signed.outputs)) === la.binToHex(la.encodeTransactionOutputs(tx.outputs));
  // did the WALLET broadcast? look for the tx on chipnet without sending it ourselves first
  let onChain = null;
  for (let i = 0; i < 20 && !onChain; i++) {
    try { onChain = await provider.getRawTransaction(r.txid); } catch { await sleep(3000); }
  }
  r.found_on_chipnet_by_wallet_broadcast = !!onChain;
  if (!onChain) { // fallback: the dapp broadcasts, recorded separately
    try { r.dapp_broadcast_txid = await provider.sendRawTransaction(resp.signedTransaction); } catch (e) { r.dapp_broadcast_error = String(e).slice(0, 200); }
  }
  const merchUtxos = await provider.getUtxos(merchantAddr);
  r.merchant_has_output = merchUtxos.some((x) => x.txid === r.txid && x.satoshis === pay);
  r.ok = r.vm_bch2025 === true && r.outputs_untouched && (r.found_on_chipnet_by_wallet_broadcast || !!r.dapp_broadcast_txid) && r.merchant_has_output;
  r.stage = 'done';
} catch (e) { r.stage = 'sign'; r.ok = false; r.sign_error = String(e).slice(0, 300); }
save();
try { await dm.sendDisconnect('test done'); } catch { /* courtesy */ }
await sleep(1500); dm.destroy(); relay.cleanup();
try { await provider.disconnect(); } catch { /* ignore */ }
console.log('DONE', r.ok);
process.exit(r.ok ? 0 : 1);
