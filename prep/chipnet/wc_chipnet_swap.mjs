// BLAZE checkout prep: the PRODUCT transaction end to end on chipnet with the REAL Cashonize web app.
// ONE tx: the buyer's tBCH buys exactly N units of a test token from a live chipnet Cauldron pool and the
// tokens land at the merchant's token address; the buyer's change returns to the wallet's change/0.
// The pool input is unlocked by the dapp (contract.unlock.swap), the buyer input is left for the wallet
// (inputPaths), the wallet signs AND broadcasts; we then look for the tx and the merchant's tokens on chain.
// Builder = the 04.11 spike (pusd-liquidity/checkout_spike.mjs) moved to chipnet + a real buyer UTXO.
// Coins: faucet tBCH; test token 53636bc8..0ed4 (worthless). Merchant = a throwaway key made here.
//
// Usage: node24 wc_chipnet_swap.mjs <deps/node_modules> <uri_out.txt> <result.json> <app_receive0_bchtest> <token_units> [live|fake] [object|hex]
// object|hex = wire form of the `transaction` field (06.11: Paytaca's signRequest only takes a HEX STRING; build rule 7).
// fake = made-up buyer UTXO + broadcast:false (real app signs the real product tx shape; nothing can reach the chain).
// Measured 06.11: the faucet allows one withdrawal per 5 h per IP, so keep test coins until a series is done.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const [nm, uriOut, resOut, appAddr, unitsArg, modeArg = 'live', wireForm = 'object'] = process.argv.slice(2);
const FAKE = modeArg === 'fake';
const imp = (p) => import(pathToFileURL(path.join(nm, p)).href);
const core = await imp('@wizardconnect/core/dist/index.js');
const dappLib = await imp('@wizardconnect/dapp/dist/index.js');
const la = await imp('@bitauth/libauth/build/index.js');
const cs = await imp('cashscript/dist/index.js');
const sdkUtils = await imp('@mr-zwets/cauldron-swap-sdk/dist/utils.js');
const { ceilDiv } = await imp('@mr-zwets/cauldron-swap-sdk/dist/multipool.js');

process.on('uncaughtException', (e) => {
  if (/WebSocket was closed before the connection was established/.test(String(e && e.message))) return;
  console.error('FATAL', e); process.exit(3);
});
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const TEST_CATEGORY = '53636bc8c1afbe35a7ba169eadfac0aebadeacf96954a9a066a483e885580ed4';
const r = { mode: modeArg, what: 'chipnet product tx: swap tBCH->test token on a live Cauldron pool + pay merchant, signed+broadcast by real Cashonize', started: new Date().toISOString(), app_receive0: appAddr, token: TEST_CATEGORY };
const save = () => writeFileSync(resOut, JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) + '\n');
const hexify = (x) => (x instanceof Uint8Array ? la.binToHex(x) : typeof x === 'bigint' ? `<bigint: ${x}n>`
  : Array.isArray(x) ? x.map(hexify) : (x && typeof x === 'object') ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, hexify(v)])) : x);
const addr = (pkh, type) => la.encodeCashAddress({ prefix: 'bchtest', type, payload: pkh }).address;

// ---------- live pool ----------
const res = await fetch(`https://indexer-chipnet.riften.net/cauldron/pool/active?token=${TEST_CATEGORY}`);
const pools = (await res.json()).active;
const pool = pools.sort((a, b) => b.sats - a.sats)[0];
r.pool = { id: pool.pool_id, sats: pool.sats, tokens: pool.tokens, utxo: `${pool.txid}:${pool.tx_pos}` };
const provider = new cs.ElectrumNetworkProvider('chipnet');
const contract = new cs.Contract(sdkUtils.cauldronArtifactWithPkh(pool.owner_pkh), [], { provider, addressType: 'p2sh32' });
const onchain = await provider.getUtxos(contract.address);
const live = onchain.find((u) => u.txid === pool.txid && u.vout === pool.tx_pos);
r.pool_utxo_live_on_chain = !!live && live.satoshis === BigInt(pool.sats) && live.token?.amount === BigInt(pool.tokens);
save();
if (!r.pool_utxo_live_on_chain) { r.stage = 'pool'; r.ok = false; save(); process.exit(1); }

const demand = BigInt(unitsArg);
const k = BigInt(pool.tokens) * BigInt(pool.sats);
const newSatsExclFee = ceilDiv(k, BigInt(pool.tokens) - demand);
const trade = newSatsExclFee - BigInt(pool.sats);
const lpFee = ceilDiv(trade * 3n, 997n);
const poolOut = { sats: newSatsExclFee + lpFee, tokens: ceilDiv(k, newSatsExclFee) };
r.quote = { demand_units: demand, pool_receives_sats: trade + lpFee, lp_fee: lpFee };

// ---------- pairing ----------
const dm = new dappLib.DappConnectionManager('BLAZE checkout: chipnet swap+pay', undefined, { session: false });
const relay = core.initiateDappRelay(({ client, status }) => dm.updateConnection(client, status));
r.keyexchangecomplete = false;
relay.events.on('keyexchangecomplete', () => { r.keyexchangecomplete = true; save(); });
const ready = new Promise((res2) => dm.once('walletready', res2));
writeFileSync(uriOut, relay.uri + '\n'); save();
console.log('URI', relay.uri);
const got = await Promise.race([ready.then(() => true), sleep(600000).then(() => false)]);
if (!got || !r.keyexchangecomplete) { r.stage = 'pairing'; r.ok = false; save(); process.exit(1); }
const buyerPkh = la.hash160(dm.getPubkey(0, 0n));
const changePkh = la.hash160(dm.getPubkey(1, 0n));
r.address_matches_app = addr(buyerPkh, 'p2pkh') === appAddr;
const merchantPriv = la.generatePrivateKey();
const merchantTokenAddr = addr(la.hash160(la.secp256k1.derivePublicKeyCompressed(merchantPriv)), 'p2pkhWithTokens');
r.merchant_token_address = merchantTokenAddr;
save();
if (!r.address_matches_app) { r.stage = 'address'; r.ok = false; save(); process.exit(1); }

let bu;
if (FAKE) {
  bu = { txid: la.binToHex(la.sha256.hash(la.utf8ToBin('prep-fake-buyer-' + Date.now()))), vout: 0, satoshis: 2_000_000n };
} else {
  let utxos = [];
  for (let i = 0; i < 20 && !utxos.length; i++) { utxos = (await provider.getUtxos(appAddr)).filter((u) => !u.token); if (!utxos.length) await sleep(3000); }
  if (!utxos.length) { r.stage = 'utxo'; r.ok = false; save(); process.exit(1); }
  bu = utxos.sort((a, b) => Number(b.satoshis - a.satoshis))[0];
}
r.buyer_utxo = { txid: bu.txid, vout: bu.vout, sats: bu.satoshis };

// ---------- the product tx (04.11 builder) ----------
const minerFee = 800n;
const merchantDust = 1000n;
const tb = new cs.TransactionBuilder({ provider, maximumFeeSatsPerByte: 10 });
// cashscript 0.14 wants lockingBytecode on hand-built UTXOs (measured 05.11 and again 06.11)
const poolUtxo = { ...sdkUtils.convertPoolToUtxo(pool), lockingBytecode: la.binToHex(la.cashAddressToLockingBytecode(contract.address).bytecode) };
if (!bu.lockingBytecode) bu.lockingBytecode = la.binToHex(la.encodeLockingBytecodeP2pkh(buyerPkh));
tb.addInput(poolUtxo, contract.unlock.swap());                                           // input 0 = pool
tb.addInput(bu, cs.placeholderP2PKHUnlocker(appAddr));                                  // input 1 = buyer (wallet signs)
tb.addOutput({ to: contract.tokenAddress, amount: poolOut.sats, token: { category: TEST_CATEGORY, amount: poolOut.tokens } }); // pool
tb.addOutput({ to: merchantTokenAddr, amount: merchantDust, token: { category: TEST_CATEGORY, amount: demand } });              // merchant
const buyerChange = bu.satoshis - (trade + lpFee) - merchantDust - minerFee;
tb.addOutput({ to: addr(changePkh, 'p2pkh'), amount: buyerChange });                                                   // change
const o = tb.generateWcTransactionObject({ broadcast: !FAKE, userPrompt: `prep chipnet: buy ${demand} test-token units on Cauldron and pay them to a merchant` });
r.buyer_pays_sats = trade + lpFee + merchantDust + minerFee;
const wire = hexify(o);
if (wireForm === 'hex') wire.transaction = la.binToHex(la.encodeTransaction(o.transaction));
r.wire_transaction_form = typeof wire.transaction === 'string' ? 'hex' : 'object';
r.sign_sent_at = new Date().toISOString(); save();
console.log('SIGN_SENT');
try {
  const resp = await Promise.race([dm.signTransaction({ transaction: wire, inputPaths: [[1, 'receive', 0]] }),
    sleep(600000).then(() => { throw new Error('no sign response in 10 min'); })]);
  const bin = la.hexToBin(resp.signedTransaction);
  const signed = la.decodeTransaction(bin);
  r.txid = la.binToHex(la.sha256.hash(la.sha256.hash(bin)).reverse());
  r.bytes = bin.length;
  const sourceOutputs = o.sourceOutputs.map((s) => ({ lockingBytecode: s.lockingBytecode, valueSatoshis: s.valueSatoshis, ...(s.token ? { token: s.token } : {}) }));
  const v = la.createVirtualMachineBch2025(true).verify({ sourceOutputs, transaction: signed });
  r.vm_bch2025 = v === true ? true : String(v).slice(0, 200);
  r.outputs_untouched = la.binToHex(la.encodeTransactionOutputs(signed.outputs)) === la.binToHex(la.encodeTransactionOutputs(o.transaction.outputs));
  r.pool_unlock_untouched = la.binToHex(signed.inputs[0].unlockingBytecode) === la.binToHex(o.transaction.inputs[0].unlockingBytecode);
  if (FAKE) {
    r.ok = r.vm_bch2025 === true && r.outputs_untouched && r.pool_unlock_untouched;
    r.stage = 'signed (fake buyer, no broadcast)';
    throw Object.assign(new Error('__fake_done__'), { fakeDone: true });
  }
  let onChain = null;
  for (let i = 0; i < 20 && !onChain; i++) { try { onChain = await provider.getRawTransaction(r.txid); } catch { await sleep(3000); } }
  r.found_on_chipnet_by_wallet_broadcast = !!onChain;
  if (!onChain) { try { r.dapp_broadcast_txid = await provider.sendRawTransaction(resp.signedTransaction); } catch (e) { r.dapp_broadcast_error = String(e).slice(0, 300); } }
  await sleep(2000);
  const mu = await provider.getUtxos(merchantTokenAddr);
  r.merchant_token_utxo = mu.filter((x) => x.txid === r.txid).map((x) => ({ vout: x.vout, sats: x.satoshis, token_amount: x.token?.amount, category_ok: x.token?.category === TEST_CATEGORY }));
  r.merchant_got_exact_tokens = r.merchant_token_utxo.some((x) => x.token_amount === demand && x.category_ok);
  r.ok = r.vm_bch2025 === true && r.outputs_untouched && r.pool_unlock_untouched && (r.found_on_chipnet_by_wallet_broadcast || !!r.dapp_broadcast_txid) && r.merchant_got_exact_tokens;
  r.stage = 'done';
} catch (e) { if (!e.fakeDone) { r.stage = 'sign'; r.ok = false; r.sign_error = String(e).slice(0, 400); } }
save();
try { await dm.sendDisconnect('test done'); } catch { /* courtesy */ }
await sleep(1500); dm.destroy(); relay.cleanup();
try { await provider.disconnect(); } catch { /* ignore */ }
console.log('DONE', r.ok);
process.exit(r.ok ? 0 : 1);
