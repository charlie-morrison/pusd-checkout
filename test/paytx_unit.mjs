// Unit test of the product transaction builder and the signed-tx check (app/src/paytx.ts).
// A test "wallet" (random HD seed, BIP44 m/44'/145'/0') signs the buyer inputs at the paths the page
// asks for, the way Cashonize / Paytaca do; then checkSigned and the libauth BCH 2025 VM judge the result.
// Pool = a made-up Cauldron pool (random owner key) for a made-up token: no network, nothing broadcast.
// Usage: node test/paytx_unit.mjs [app/src dir]   (Node >= 23)   Exit 0 = all pass, 1 = a case failed.
import { pathToFileURL } from 'node:url';
import * as la from '@bitauth/libauth';
import * as cs from 'cashscript';
import { cauldronArtifactWithPkh } from '@mr-zwets/cauldron-swap-sdk/dist/utils.js';

const src = process.argv[2] ?? new URL('../app/src', import.meta.url).pathname;
const pt = await import(pathToFileURL(`${src}/paytx.ts`).href);

const provider = new cs.ElectrumNetworkProvider(cs.Network.CHIPNET, { manualConnectionManagement: true });
const prefix = 'bchtest';
const seed = la.generateRandomBytes(32);
const root = la.deriveHdPrivateNodeFromSeed(seed);
const keyAt = (chain, i) => la.deriveHdPath(root, `m/44'/145'/0'/${chain}/${i}`).privateKey;
const pkhOf = (priv) => la.hash160(la.secp256k1.derivePublicKeyCompressed(priv));
const addrOf = (priv, type = 'p2pkh') => la.encodeCashAddress({ prefix, type, payload: pkhOf(priv) }).address;
const fakeTxid = (s) => la.binToHex(la.sha256.hash(la.utf8ToBin(s)));
const CAT = fakeTxid('test-token');

const ownerPkh = la.binToHex(pkhOf(la.generatePrivateKey()));
const pool = { pool_id: 'p', txid: fakeTxid('pool'), tx_pos: 0, sats: 10_000_000, tokens: 10_000, token_id: CAT, owner_pkh: ownerPkh };
const merchant = addrOf(la.generatePrivateKey(), 'p2pkhWithTokens');
const coin = (chain, index, sats, tag) => ({ txid: fakeTxid(tag), vout: 0, satoshis: sats, chain: chain === 0 ? 'receive' : 'change', index, address: addrOf(keyAt(chain, index)) });
const coins = [coin(0, 3, 30_000n, 'r3'), coin(1, 2, 25_000n, 'c2'), coin(0, 7, 2_000n, 'r7')];
const params = { pool, units: 40n, merchant, coins, changeAddress: addrOf(keyAt(1, 0)), provider, label: '40 TEST' };

// The test wallet: rebuild the requested tx with real signatures on the inputs named by inputPaths.
function walletSign(req) {
  const contract = new cs.Contract(cauldronArtifactWithPkh(ownerPkh), [], { provider, addressType: 'p2sh32' });
  const tb = new cs.TransactionBuilder({ provider, maximumFeeSatsPerByte: 10 });
  const paths = new Map(req.inputPaths.map(([k, ch, i]) => [k, [ch === 'receive' ? 0 : 1, i]]));
  req.transaction.inputs.forEach((inp, k) => {
    const so = req.sourceOutputs[k];
    const utxo = { txid: la.binToHex(inp.outpointTransactionHash), vout: inp.outpointIndex, satoshis: so.valueSatoshis,
      lockingBytecode: la.binToHex(so.lockingBytecode), ...(so.token ? { token: { category: la.binToHex(so.token.category), amount: so.token.amount } } : {}) };
    if (k === 0) tb.addInput(utxo, contract.unlock.swap());
    else { const [ch, i] = paths.get(k); tb.addInput(utxo, new cs.SignatureTemplate(keyAt(ch, i)).unlockP2PKH()); }
  });
  for (const o of req.transaction.outputs) {
    const to = la.lockingBytecodeToCashAddress({ bytecode: o.lockingBytecode, prefix, tokenSupport: !!o.token });
    tb.addOutput({ to: typeof to === 'string' ? to : to.address, amount: o.valueSatoshis,
      ...(o.token ? { token: { category: la.binToHex(o.token.category), amount: o.token.amount } } : {}) });
  }
  return tb.build();
}
const vm = la.createVirtualMachineBch2025(true);
const vmOk = (req, hex) => vm.verify({ sourceOutputs: req.sourceOutputs, transaction: la.decodeTransaction(la.hexToBin(hex)) });

const cases = [];
const t = (name, fn) => cases.push([name, fn]);
let req; try { req = pt.buildPayment(params); } catch (e) { req = `threw: ${String(e).slice(0, 200)}`; }
let signed = '', signError = '';
try { signed = typeof req === 'string' ? '' : walletSign(req); } catch (e) { signError = String(e).slice(0, 200); }

t('builds', () => { if (typeof req === 'string') console.log('   build said:', req.slice(0, 160)); return typeof req === 'object'; });
t('the test wallet could sign every requested input', () => { if (signError) console.log('   sign error:', signError); return signed.length > 0; });
t('pool is input 0; buyer coins largest first with their own paths (rule 8)', () =>
  JSON.stringify(req.inputPaths) === JSON.stringify([[1, 'receive', 3], [2, 'change', 2]]));
t('outputs: pool (tokens - 40), merchant gets exactly 40 on 1000 sat, change to change/0', () => {
  const [po, mo, co] = req.transaction.outputs;
  return po.token.amount === 9960n && mo.token.amount === 40n && mo.valueSatoshis === 1000n
    && la.binToHex(mo.token.category) === CAT && co && la.binToHex(co.lockingBytecode) === la.binToHex(la.cashAddressToLockingBytecode(params.changeAddress).bytecode);
});
t('hex is the wire form of the same tx (rule 7)', () => req.hex === la.binToHex(la.encodeTransaction(req.transaction)));
t('prompt carries the cost and the merchant (rule 9)', () => req.userPrompt.includes(req.buyerPays.toLocaleString('en-US')) && req.userPrompt.includes(merchant) && req.userPrompt.includes('40 TEST'));
t('money adds up: inputs = outputs + fee', () => {
  const ins = req.sourceOutputs.reduce((s, o) => s + o.valueSatoshis, 0n);
  const outs = req.transaction.outputs.reduce((s, o) => s + o.valueSatoshis, 0n);
  return ins - outs === req.networkFee && req.buyerPays === req.poolCost + 1000n + req.networkFee;
});
t('wallet-signed tx passes checkSigned', () => pt.checkSigned(req, signed) === null);
t('wallet-signed tx is VALID in the BCH 2025 VM (pool covenant + both buyer signatures)', () => vmOk(req, signed) === true);
t('fee covers the SIGNED size at 1 sat/byte', () => req.networkFee >= BigInt(la.hexToBin(signed).length));
t('fee is not wildly over (<= signed size + 40)', () => req.networkFee <= BigInt(la.hexToBin(signed).length) + 40n);

// rule 4: anything but signatures must be refused
const mutate = (f) => { const tx = la.decodeTransaction(la.hexToBin(signed)); f(tx); return la.binToHex(la.encodeTransaction(tx)); };
t('changed output amount -> refused', () => /outputs/.test(pt.checkSigned(req, mutate((tx) => { tx.outputs[2].valueSatoshis -= 1000n; })) ?? ''));
t('extra output -> refused', () => /outputs/.test(pt.checkSigned(req, mutate((tx) => { tx.outputs.push({ ...tx.outputs[2], valueSatoshis: 600n }); })) ?? ''));
t('changed pool unlock -> refused', () => /pool input/.test(pt.checkSigned(req, mutate((tx) => { tx.inputs[0].unlockingBytecode = la.hexToBin('00'); })) ?? ''));
t('swapped outpoint -> refused', () => /input 1/.test(pt.checkSigned(req, mutate((tx) => { tx.inputs[1].outpointIndex = 5; })) ?? ''));
t('an input left unsigned -> refused', () => /not signed/.test(pt.checkSigned(req, mutate((tx) => { tx.inputs[2].unlockingBytecode = new Uint8Array(); })) ?? ''));
t('garbage -> refused', () => typeof pt.checkSigned(req, 'zz') === 'string');
t('control: a wrong key signs input 1 -> checkSigned passes it (signatures are the wallet\'s job) but the VM refuses', () => {
  const bad = mutate((tx) => { const s = la.decodeTransaction(la.hexToBin(signed)); tx.inputs[1].unlockingBytecode = s.inputs[2].unlockingBytecode; });
  return pt.checkSigned(req, bad) === null && vmOk(req, bad) !== true;
});

// coin selection and refusals
t('one big coin is enough -> one input', () => { const r = pt.buildPayment({ ...params, coins: [coin(0, 0, 100_000n, 'big'), ...coins] }); return r.inputPaths.length === 1 && r.inputPaths[0][1] === 'receive' && r.inputPaths[0][2] === 0; });
t('not enough BCH -> refused', () => /not hold enough/.test(pt.buildPayment({ ...params, coins: [coin(0, 7, 2_000n, 'r7')] })));
t('token coins are never used', () => /not hold enough/.test(pt.buildPayment({ ...params, coins: coins.map((c) => ({ ...c, token: { amount: 1n } })) })));
t('non-token merchant address -> refused', () => /cannot receive tokens/.test(pt.buildPayment({ ...params, merchant: addrOf(keyAt(0, 9)) })));
t('more units than the pool holds -> refused', () => /cannot sell/.test(pt.buildPayment({ ...params, units: 10_000n })));
t('dust change goes to the miner (no change output, fee absorbs it)', () => {
  const exact = typeof req === 'object' ? req.poolCost + 1000n + 450n : 0n; // one input, change would be < 546
  const r = pt.buildPayment({ ...params, coins: [coin(0, 1, exact, 'exact')] });
  return typeof r === 'object' && r.transaction.outputs.length === 2 && r.change === 0n && r.networkFee === 450n;
});

// build rule 5 on chain (17.11): the indexer's outpoint is replaced by what the chain holds at the pool address
t('live pools: a spent indexer outpoint is replaced by the live outputs (both pools of one owner kept)', () => {
  const live = pt.livePoolsOf(pool, [{ txid: fakeTxid('next'), vout: 0, satoshis: 10_008_000n, token: { category: CAT, amount: 9_992n } },
    { txid: fakeTxid('next'), vout: 2, satoshis: 30_000n, token: { category: CAT, amount: 300n } }]);
  return live.length === 2 && live[0].txid === fakeTxid('next') && live[0].tx_pos === 0 && live[0].sats === 10_008_000 && live[0].tokens === 9_992
    && live[1].tx_pos === 2 && live.every((p) => p.owner_pkh === ownerPkh);
});
t('live pools: other tokens, NFTs and plain BCH at the address are not pools', () =>
  pt.livePoolsOf(pool, [{ txid: fakeTxid('a'), vout: 0, satoshis: 5000n, token: { category: fakeTxid('other'), amount: 5n } },
    { txid: fakeTxid('b'), vout: 0, satoshis: 5000n, token: { category: CAT, amount: 5n, nft: { capability: 'none' } } },
    { txid: fakeTxid('c'), vout: 0, satoshis: 5000n }]).length === 0);
t('pool address = the address the pool output pays (same locking bytecode)', () => {
  const lock = la.binToHex(la.cashAddressToLockingBytecode(pt.poolAddress(pool, provider)).bytecode);
  return lock === la.binToHex(req.transaction.outputs[0].lockingBytecode);
});

let fail = 0;
for (const [name, fn] of cases) {
  let ok = false, err = '';
  try { ok = await fn(); } catch (e) { err = String(e).slice(0, 200); }
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${err ? `  (${err})` : ''}`);
}
console.log(`${cases.length - fail}/${cases.length} passed`);
process.exit(fail ? 1 : 0);
