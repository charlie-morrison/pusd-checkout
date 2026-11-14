// BLAZE checkout prep: does PAYTACA's own WizardConnect signing code sign our product tx?
// Same method as the 05.11 Cashonize check: run the wallet's real code offline (unmodified source, only the
// import specifiers are re-pointed), feed it the request our dapp would send, check the result in the VM.
// Paytaca source: paytaca/paytaca-app src/wallet/wizardconnect/service.js (hydrate + signRequest + key paths)
// and src/wallet/bch-sign.js (signBchTransaction), fetched at a pinned commit into <vendor_dir>.
// The product tx = live chipnet Cauldron pool (input 0, dapp-unlocked) + a buyer UTXO at Paytaca's receive/0
// (input 1, made-up outpoint) -> pool, merchant token output, buyer change. Nothing is broadcast.
//
// Cases:  A = our current wire (transaction as a decoded OBJECT, everything else hexified)
//         B = build rule 7 candidate: transaction as a HEX STRING (binToHex(encodeTransaction(..)))
// Controls: C = B with inputPaths pointing at change/0 (wrong key) -> must not verify;
//           D = B with one output value bumped AFTER signing -> must not verify (our outputs guard + VM).
// Usage: node24 pt_offline_sign.mjs <deps/node_modules> <vendor_dir> <scratch_build_dir> <out.json>
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const [nm, vendor, build, outFile] = process.argv.slice(2);
const u = (p) => pathToFileURL(p).href;
const la = await import(u(path.join(nm, '@bitauth/libauth/build/index.js')));
const cs = await import(u(path.join(nm, 'cashscript/dist/index.js')));
const sdkUtils = await import(u(path.join(nm, '@mr-zwets/cauldron-swap-sdk/dist/utils.js')));
const { ceilDiv } = await import(u(path.join(nm, '@mr-zwets/cauldron-swap-sdk/dist/multipool.js')));
const bip39 = (await import(u(path.join(nm, 'bip39/src/index.js')))).default;

const r = { what: 'Paytaca signRequest/signBchTransaction (unmodified source) on our chipnet product tx', started: new Date().toISOString(), cases: {} };
const save = () => writeFileSync(outFile, JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) + '\n');

// ---- re-point Paytaca's imports (source text otherwise untouched; sha256 recorded) ----
const sha = (t) => la.binToHex(la.sha256.hash(la.utf8ToBin(t)));
const map = {
  "'bitauth-libauth-v3'": `'${u(path.join(nm, 'bitauth-libauth-v3/build/index.js'))}'`,
  "'@wizardconnect/core'": `'${u(path.join(nm, '@wizardconnect/core/dist/index.js'))}'`,
  "'bip39'": `'${u(path.join(nm, 'bip39/src/index.js'))}'`,
  "'src/wallet/index'": `'${u(path.join(build, 'stub-wallet-index.js'))}'`,
  "'src/wallet/bch-sign'": `'${u(path.join(build, 'bch-sign.js'))}'`,
};
r.vendor = {};
for (const f of ['service.js', 'bch-sign.js']) {
  let t = readFileSync(path.join(vendor, f), 'utf8');
  r.vendor[f] = { sha256: sha(t) };
  for (const [a, b] of Object.entries(map)) t = t.split(`from ${a}`).join(`from ${b}`);
  writeFileSync(path.join(build, f), t);
}
writeFileSync(path.join(build, 'package.json'), '{"type":"module"}\n');
writeFileSync(path.join(build, 'stub-wallet-index.js'), 'export async function getMnemonic() { return process.env.PT_MNEMONIC; }\n');

process.env.PT_MNEMONIC = bip39.generateMnemonic(); // throwaway, never printed
const svc = await import(u(path.join(build, 'service.js')));
svc.setWalletConfig(0, true); // chipnet

// buyer key the way Paytaca derives it: m/44'/145'/0'/0/0 (receive/0)
const seed = new Uint8Array(bip39.mnemonicToSeedSync(process.env.PT_MNEMONIC));
const master = la.deriveHdPrivateNodeFromSeed(seed);
const recv0 = la.deriveHdPrivateNodeChild(la.deriveHdPath(master, "m/44'/145'/0'/0"), 0);
const buyerPkh = la.hash160(la.secp256k1.derivePublicKeyCompressed(recv0.privateKey));
const buyerAddr = la.encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: buyerPkh }).address;

// ---- the product tx on the LIVE chipnet pool ----
const TEST_CATEGORY = '53636bc8c1afbe35a7ba169eadfac0aebadeacf96954a9a066a483e885580ed4';
const pools = (await (await fetch(`https://indexer-chipnet.riften.net/cauldron/pool/active?token=${TEST_CATEGORY}`)).json()).active;
const pool = pools.sort((a, b) => b.sats - a.sats)[0];
const provider = new cs.ElectrumNetworkProvider('chipnet');
const contract = new cs.Contract(sdkUtils.cauldronArtifactWithPkh(pool.owner_pkh), [], { provider, addressType: 'p2sh32' });
const live = (await provider.getUtxos(contract.address)).find((x) => x.txid === pool.txid && x.vout === pool.tx_pos);
r.pool = { id: pool.pool_id.slice(0, 16), sats: pool.sats, tokens: pool.tokens, utxo_live_on_chain: !!live };
const demand = 40n;
const k = BigInt(pool.tokens) * BigInt(pool.sats);
const newSats = ceilDiv(k, BigInt(pool.tokens) - demand);
const trade = newSats - BigInt(pool.sats);
const lpFee = ceilDiv(trade * 3n, 997n);
const merchantAddr = la.encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: la.hash160(la.secp256k1.derivePublicKeyCompressed(la.generatePrivateKey())) }).address;
const bu = { txid: la.binToHex(la.sha256.hash(la.utf8ToBin('prep-pt-buyer-' + Date.now()))), vout: 0, satoshis: 2_000_000n, lockingBytecode: la.binToHex(la.encodeLockingBytecodeP2pkh(buyerPkh)) };
const tb = new cs.TransactionBuilder({ provider, maximumFeeSatsPerByte: 10 });
tb.addInput({ ...sdkUtils.convertPoolToUtxo(pool), lockingBytecode: la.binToHex(la.cashAddressToLockingBytecode(contract.address).bytecode) }, contract.unlock.swap());
tb.addInput(bu, cs.placeholderP2PKHUnlocker(buyerAddr));
tb.addOutput({ to: contract.tokenAddress, amount: newSats + lpFee, token: { category: TEST_CATEGORY, amount: ceilDiv(k, newSats) } });
tb.addOutput({ to: merchantAddr, amount: 1000n, token: { category: TEST_CATEGORY, amount: demand } });
tb.addOutput({ to: la.encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: buyerPkh }).address, amount: bu.satoshis - (trade + lpFee) - 1800n });
const o = tb.generateWcTransactionObject({ broadcast: false, userPrompt: 'prep paytaca offline check' });
try { await provider.disconnect(); } catch { /* ignore */ }
r.sourceOutput1_unlocking_len = o.sourceOutputs[1].unlockingBytecode?.length ?? null; // what cashscript sends for the buyer placeholder
r.tx_input1_unlocking_len = o.transaction.inputs[1].unlockingBytecode?.length ?? null;

const hexify = (x) => (x instanceof Uint8Array ? la.binToHex(x) : typeof x === 'bigint' ? `<bigint: ${x}n>`
  : Array.isArray(x) ? x.map(hexify) : (x && typeof x === 'object') ? Object.fromEntries(Object.entries(x).map(([kk, v]) => [kk, hexify(v)])) : x);
const relayed = (x) => JSON.parse(JSON.stringify(x)); // what crosses the relay
const vmSourceOutputs = o.sourceOutputs.map((s) => ({ lockingBytecode: s.lockingBytecode, valueSatoshis: s.valueSatoshis, ...(s.token ? { token: s.token } : {}) }));
const reqOutputsHex = la.binToHex(la.encodeTransactionOutputs(o.transaction.outputs));
const poolUnlockHex = la.binToHex(o.transaction.inputs[0].unlockingBytecode);

async function runCase(name, wire, inputPaths, tamper) {
  const c = { inputPaths };
  try {
    const signedHex = await svc.signRequest(relayed({ transaction: wire, inputPaths }));
    let bin = la.hexToBin(signedHex);
    let tx = la.decodeTransaction(bin);
    if (tamper) { tx = { ...tx, outputs: tx.outputs.map((x, i) => (i === 2 ? { ...x, valueSatoshis: x.valueSatoshis + 1n } : x)) }; bin = la.encodeTransaction(tx); }
    c.bytes = bin.length;
    const v = la.createVirtualMachineBch2025(true).verify({ sourceOutputs: vmSourceOutputs, transaction: tx });
    c.vm_bch2025 = v === true ? true : String(v).slice(0, 160);
    c.outputs_untouched = la.binToHex(la.encodeTransactionOutputs(tx.outputs)) === reqOutputsHex;
    c.pool_unlock_untouched = la.binToHex(tx.inputs[0].unlockingBytecode) === poolUnlockHex;
    c.buyer_input_signed = tx.inputs[1].unlockingBytecode.length > 0 && !/^41(00){65}/.test(la.binToHex(tx.inputs[1].unlockingBytecode));
    c.pass = c.vm_bch2025 === true && c.outputs_untouched && c.pool_unlock_untouched && c.buyer_input_signed;
  } catch (e) { c.error = String(e && e.message || e).slice(0, 300); c.pass = false; }
  r.cases[name] = c; save();
}

const wireObj = hexify(o);                                                              // A: our current wire
const wireHex = { ...hexify(o), transaction: la.binToHex(la.encodeTransaction(o.transaction)) }; // B: rule 7
await runCase('A_object_transaction', wireObj, [[1, 'receive', 0]]);
await runCase('B_hex_transaction', wireHex, [[1, 'receive', 0]]);
await runCase('C_control_wrong_key', wireHex, [[1, 'change', 0]]);
await runCase('D_control_output_bumped_after_sign', wireHex, [[1, 'receive', 0]], true);
r.expect = { B_pass: true, C_pass: false, D_pass: false };
r.controls_ok = r.cases.C_control_wrong_key.pass === false && r.cases.D_control_output_bumped_after_sign.pass === false;
r.ok = r.cases.B_hex_transaction.pass === true && r.controls_ok;
save();
console.log(JSON.stringify({ A: r.cases.A_object_transaction.pass, B: r.cases.B_hex_transaction.pass, C: r.cases.C_control_wrong_key.pass, D: r.cases.D_control_output_bumped_after_sign.pass, ok: r.ok }));
process.exit(r.ok ? 0 : 1);
