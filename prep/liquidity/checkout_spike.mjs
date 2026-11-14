// Spike (BLAZE checkout prep, prep before the 14.11 fork): ONE transaction where the buyer's BCH
// buys exactly N PUSD from a live Cauldron pool and the PUSD lands at the MERCHANT's address.
// Offline and read-only: ephemeral throwaway keys, a synthetic buyer UTXO, NO broadcast.
// The pool input is the real UTXO (indexer snapshot + on-chain locking bytecode checked below);
// validity is judged by libauth's BCH VM, independently of CashScript's own builder.
//
// Usage: node checkout_spike.mjs <node_modules dir> <spike-pool.json> <pusd_amount>
// Prints JSON: valid tx + two negative controls (both must FAIL on the pool input).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [nm, poolPath, pusdArg] = process.argv.slice(2);
const imp = (p) => import(pathToFileURL(path.join(nm, p)).href);
const cs = await imp('cashscript/dist/index.js');
const la = await imp('@bitauth/libauth/build/index.js');
const sdkUtils = await imp('@mr-zwets/cauldron-swap-sdk/dist/utils.js');
const { ceilDiv } = await imp('@mr-zwets/cauldron-swap-sdk/dist/multipool.js');

const pool = JSON.parse(readFileSync(poolPath, 'utf8'));
const demand = BigInt(Math.round(Number(pusdArg) * 100)); // PUSD base units (2 decimals)
const provider = new cs.MockNetworkProvider({ updateUtxoSet: false });
provider.network = 'mainnet'; // the mock defaults to chipnet ('bchtest' prefix); nothing is ever sent

function key() {
  const priv = la.generatePrivateKey();
  const pub = la.secp256k1.derivePublicKeyCompressed(priv);
  const pkh = la.hash160(pub);
  const addr = (type) => la.encodeCashAddress({ prefix: 'bitcoincash', type, payload: pkh }).address;
  return { priv, pkh, addr: addr('p2pkh'), tokenAddr: addr('p2pkhWithTokens') };
}
const buyer = key();
const merchant = key();

const contract = new cs.Contract(sdkUtils.cauldronArtifactWithPkh(pool.owner_pkh), [], { provider, addressType: 'p2sh32', contractType: 'p2sh32' });
const contractSpk = la.binToHex(la.cashAddressToLockingBytecode(contract.address).bytecode);
const spkMatches = contractSpk === pool.onchain_spk;

// pool state after the trade, exactly as the SDK computes it (transactions.ts buildCauldronInputsOutputs)
function poolOut(stealTokens = 0n, shortSats = 0n) {
  const k = BigInt(pool.tokens) * BigInt(pool.sats);
  const newTokens = BigInt(pool.tokens) - demand;
  const newSatsExclFee = ceilDiv(k, newTokens);
  const trade = newSatsExclFee - BigInt(pool.sats);
  const fee = ceilDiv(trade * 3n, 997n);
  const short = shortSats === -1n ? fee : shortSats; // -1 = skip the whole 0.3% LP fee
  return { sats: newSatsExclFee + fee - short, tokens: ceilDiv(k, newSatsExclFee) - stealTokens, paid: trade + fee, short };
}

const buyerUtxo = { txid: la.binToHex(la.sha256.hash(la.utf8ToBin('prep-spike-' + Date.now()))), vout: 0, satoshis: 10_000_000n };
const poolUtxo = sdkUtils.convertPoolToUtxo(pool);

function build(stealTokens = 0n, shortSats = 0n) {
  const po = poolOut(stealTokens, shortSats);
  const tb = new cs.TransactionBuilder({ provider, maximumFeeSatsPerByte: 10 });
  tb.addInput(poolUtxo, contract.unlock.swap());                       // input 0 = pool (OP_INPUTINDEX pairing)
  tb.addInput(buyerUtxo, new cs.SignatureTemplate(buyer.priv).unlockP2PKH()); // input 1 = buyer
  tb.addOutput({ to: contract.tokenAddress, amount: po.sats, token: { category: pool.token_id, amount: po.tokens } }); // output 0 = pool
  tb.addOutput({ to: merchant.tokenAddr, amount: 1000n, token: { category: pool.token_id, amount: demand + stealTokens } }); // merchant gets PUSD
  const minerFee = 800n;
  tb.addOutput({ to: buyer.addr, amount: buyerUtxo.satoshis - po.paid + po.short - 1000n - minerFee }); // buyer change
  const hex = tb.build();
  const tx = la.decodeTransaction(la.hexToBin(hex));
  const sourceOutputs = [
    { lockingBytecode: la.hexToBin(pool.onchain_spk), valueSatoshis: BigInt(pool.sats), token: { category: la.hexToBin(pool.token_id), amount: BigInt(pool.tokens) } },
    { lockingBytecode: la.cashAddressToLockingBytecode(buyer.addr).bytecode, valueSatoshis: buyerUtxo.satoshis },
  ];
  const res = {};
  for (const [name, vm] of [['bch2025', la.createVirtualMachineBch2025(true)], ['bch2026', la.createVirtualMachineBch2026(true)]]) {
    const r = vm.verify({ transaction: tx, sourceOutputs });
    res[name] = r === true ? true : String(r).slice(0, 220);
  }
  return { hex, bytes: hex.length / 2, buyer_pays_sats: Number(po.paid + 1000n + minerFee), merchant_pusd: Number(demand + stealTokens) / 100, vm: res };
}

let good, steal, short;
try { good = build(); } catch (e) { good = { error: String(e).slice(0, 300) }; }
try { steal = build(1n, 0n); } catch (e) { steal = { build_error: String(e).slice(0, 300) }; }
try { short = build(0n, 1n); } catch (e) { short = { build_error: String(e).slice(0, 300) }; }
let nofee;
try { nofee = build(0n, -1n); } catch (e) { nofee = { build_error: String(e).slice(0, 300) }; }
// WizardConnect / BCH-WC shape: same tx, buyer input left for the wallet (placeholder unlocker)
let wc;
try {
  const po = poolOut();
  const tb = new cs.TransactionBuilder({ provider, maximumFeeSatsPerByte: 10 });
  tb.addInput(poolUtxo, contract.unlock.swap());
  tb.addInput(buyerUtxo, cs.placeholderP2PKHUnlocker(buyer.addr));
  tb.addOutput({ to: contract.tokenAddress, amount: po.sats, token: { category: pool.token_id, amount: po.tokens } });
  tb.addOutput({ to: merchant.tokenAddr, amount: 1000n, token: { category: pool.token_id, amount: demand } });
  tb.addOutput({ to: buyer.addr, amount: buyerUtxo.satoshis - po.paid - 1000n - 800n });
  const o = tb.generateWcTransactionObject({ broadcast: false, userPrompt: 'Pay ' + Number(demand) / 100 + ' PUSD (BCH swapped on Cauldron)' });
  const signed = la.decodeTransaction(la.hexToBin(build().hex));
  wc = {
    inputs: o.transaction.inputs.length, outputs: o.transaction.outputs.length, sourceOutputs: o.sourceOutputs.length,
    pool_input_unlocking_preset: o.transaction.inputs[0].unlockingBytecode.length > 0,
    pool_input_unlocking_equals_signed_tx: la.binToHex(o.transaction.inputs[0].unlockingBytecode) === la.binToHex(signed.inputs[0].unlockingBytecode),
    pool_source_has_contract_info: Boolean(o.sourceOutputs[0].contract),
    buyer_input_unlocking_len: o.transaction.inputs[1].unlockingBytecode.length,
    outputs_equal_signed_tx: JSON.stringify(o.transaction.outputs.map(x => [String(x.valueSatoshis), la.binToHex(x.lockingBytecode)])) === JSON.stringify(signed.outputs.map(x => [String(x.valueSatoshis), la.binToHex(x.lockingBytecode)])),
    wizardconnect_inputPaths: [[1, 'receive', 0]],
  };
} catch (e) { wc = { error: String(e).slice(0, 300) }; }
console.log(JSON.stringify({
  pool: pool.pool_id, pool_pusd: pool.tokens / 100, demand_pusd: Number(demand) / 100,
  contract_spk_matches_onchain: spkMatches, contract_spk: contractSpk,
  valid_swap_and_pay: good, control_merchant_takes_1_extra_unit: steal, control_pool_short_1_sat_within_rounding: short, control_pool_skips_lp_fee: nofee, wc_sign_request_shape: wc,
}, null, 1));
