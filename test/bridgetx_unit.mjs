// Unit test of the bridge OUT transactions (app/src/bridgetx.ts): A = Cauldron sell, B = send to the THORChain vault.
// A test "wallet" (random HD seed, m/44'/145'/0') signs at the paths the page asks for; checkSigned and the
// libauth BCH 2025 VM judge the result. Made-up pool, made-up token, made-up vault: no network, nothing broadcast.
// Usage: node test/bridgetx_unit.mjs [app/src dir]   (Node >= 23)   Exit 0 = all pass, 1 = a case failed.
import { pathToFileURL } from 'node:url';
import * as la from '@bitauth/libauth';
import * as cs from 'cashscript';
import { cauldronArtifactWithPkh } from '@mr-zwets/cauldron-swap-sdk/dist/utils.js';
import { calcSellToPool } from '@mr-zwets/cauldron-swap-sdk';

const src = process.argv[2] ?? new URL('../app/src', import.meta.url).pathname;
const bt = await import(pathToFileURL(`${src}/bridgetx.ts`).href);
const pt = await import(pathToFileURL(`${src}/paytx.ts`).href);

const provider = new cs.ElectrumNetworkProvider(cs.Network.MAINNET, { manualConnectionManagement: true });
const prefix = 'bitcoincash';
const root = la.deriveHdPrivateNodeFromSeed(la.generateRandomBytes(32));
const keyAt = (chain, i) => la.deriveHdPath(root, `m/44'/145'/0'/${chain}/${i}`).privateKey;
const pkhOf = (priv) => la.hash160(la.secp256k1.derivePublicKeyCompressed(priv));
const addrOf = (priv, type = 'p2pkh') => la.encodeCashAddress({ prefix, type, payload: pkhOf(priv) }).address;
const fakeTxid = (s) => la.binToHex(la.sha256.hash(la.utf8ToBin(s)));
const CAT = fakeTxid('pusd');
const OTHER = fakeTxid('selene');
const ownerPkh = la.binToHex(pkhOf(la.generatePrivateKey()));
// Live-like pool (19.11 mainnet PUSD pool size): 5,227,556 units against 25.3 BCH.
const pool = { pool_id: 'p', txid: fakeTxid('pool'), tx_pos: 0, sats: 2_530_000_000, tokens: 5_227_556, token_id: CAT, owner_pkh: ownerPkh };
const tcoin = (chain, index, units, tag, category = CAT) => ({ txid: fakeTxid(tag), vout: 0, satoshis: 1000n, chain: chain === 0 ? 'receive' : 'change',
  index, address: addrOf(keyAt(chain, index)), token: { category, amount: units } });
// Like the W3 wallet on 19.11: 100 + 300 PUSD units on receive/0, plus another token that must stay put.
const tokenCoins = [tcoin(0, 0, 100n, 't1'), tcoin(0, 0, 300n, 't3'), tcoin(0, 0, 5n, 'sel', OTHER)];
const proceedsAddress = addrOf(keyAt(1, 4));
const sellParams = { pool, units: 400n, tokenCoins, proceedsAddress, proceedsPath: ['change', 4], tokenChangeAddress: addrOf(keyAt(0, 0), 'p2pkhWithTokens'), provider, label: '4.00 PUSD' };

function walletSign(req, poolAt0) {
  const contract = new cs.Contract(cauldronArtifactWithPkh(ownerPkh), [], { provider, addressType: 'p2sh32' });
  const tb = new cs.TransactionBuilder({ provider, maximumFeeSatsPerByte: 20 });
  const paths = new Map(req.inputPaths.map(([k, ch, i]) => [k, [ch === 'receive' ? 0 : 1, i]]));
  req.transaction.inputs.forEach((inp, k) => {
    const so = req.sourceOutputs[k];
    const utxo = { txid: la.binToHex(inp.outpointTransactionHash), vout: inp.outpointIndex, satoshis: so.valueSatoshis,
      lockingBytecode: la.binToHex(so.lockingBytecode), ...(so.token ? { token: { category: la.binToHex(so.token.category), amount: so.token.amount } } : {}) };
    if (k === 0 && poolAt0) tb.addInput(utxo, contract.unlock.swap());
    else { const [ch, i] = paths.get(k); tb.addInput(utxo, new cs.SignatureTemplate(keyAt(ch, i)).unlockP2PKH()); }
  });
  for (const o of req.transaction.outputs) {
    tb.addOutput({ to: o.lockingBytecode, amount: o.valueSatoshis,
      ...(o.token ? { token: { category: la.binToHex(o.token.category), amount: o.token.amount } } : {}) });
  }
  return tb.build();
}
const vm = la.createVirtualMachineBch2025(true);
const vmOk = (req, hex) => vm.verify({ sourceOutputs: req.sourceOutputs, transaction: la.decodeTransaction(la.hexToBin(hex)) });
const sum = (xs) => xs.reduce((s, x) => s + x, 0n);

const cases = [];
const t = (name, fn) => cases.push([name, fn]);
let A; try { A = bt.buildSell(sellParams); } catch (e) { A = `threw: ${String(e).slice(0, 200)}`; }
let sA = '', eA = '';
try { sA = typeof A === 'string' ? '' : walletSign(A, true); } catch (e) { eA = String(e).slice(0, 200); }

t('A builds', () => { if (typeof A === 'string') console.log('   build said:', A); return typeof A === 'object'; });
t('A: the test wallet could sign', () => { if (eA) console.log('   sign error:', eA); return sA.length > 0; });
t('A: pool input 0, then only the PUSD coins (the other token stays)', () =>
  A.transaction.inputs.length === 3 && JSON.stringify(A.inputPaths) === JSON.stringify([[1, 'receive', 0], [2, 'receive', 0]]));
t('A: pool output matches the SDK sell math; seller gets calcSellToPool (within its rounding)', () => {
  const po = A.transaction.outputs[0];
  const m = bt.sellMath(pool, 400n);
  const sdk = calcSellToPool({ ...pool, sats: BigInt(pool.sats), tokens: BigInt(pool.tokens) }, 400n).supplyAmount;
  return po.valueSatoshis === m.poolSats && po.token.amount === m.poolTokens && la.binToHex(po.token.category) === CAT
    && A.poolGives >= sdk - 1n && A.poolGives <= sdk + 1n;
});
t('A: no token burned (token in = token out)', () => {
  const tin = sum(A.sourceOutputs.filter((o) => o.token && la.binToHex(o.token.category) === CAT).map((o) => o.token.amount));
  const tout = sum(A.transaction.outputs.filter((o) => o.token).map((o) => o.token.amount));
  return tin === tout;
});
t('A: proceeds = last output, to the proceeds address, money adds up', () => {
  const last = A.transaction.outputs[A.proceedsVout];
  const ins = sum(A.sourceOutputs.map((o) => o.valueSatoshis)), outs = sum(A.transaction.outputs.map((o) => o.valueSatoshis));
  return A.proceedsVout === A.transaction.outputs.length - 1 && !last.token && last.valueSatoshis === A.proceeds
    && la.binToHex(last.lockingBytecode) === la.binToHex(la.cashAddressToLockingBytecode(proceedsAddress).bytecode)
    && ins - outs === A.networkFee;
});
t('A: signed passes checkSigned and the BCH 2025 VM (pool covenant + seller signatures)', () => pt.checkSigned(A, sA) === null && vmOk(A, sA) === true);
t('A: fee covers the signed size at 1 sat/B, not wildly over', () => A.networkFee >= BigInt(la.hexToBin(sA).length) && A.networkFee <= BigInt(la.hexToBin(sA).length) + 40n);
t('A: prompt names the amount and step 1 of 2', () => A.userPrompt.includes('4.00 PUSD') && A.userPrompt.includes(A.proceeds.toLocaleString('en-US')) && A.userPrompt.includes('step 1 of 2'));
t('A: partial sale (250 of 400) returns the rest as token change', () => {
  const r = bt.buildSell({ ...sellParams, units: 250n });
  const ch = r.transaction.outputs.find((o, k) => k > 0 && o.token);
  const tin = sum(r.sourceOutputs.slice(1).filter((o) => o.token).map((o) => o.token.amount)); // input 0 is the pool
  return typeof r === 'object' && ch && tin === 300n && ch.token.amount === tin - r.deposited && ch.valueSatoshis === 1000n;
});
t('A: refuses to sell more than the wallet holds', () => typeof bt.buildSell({ ...sellParams, units: 401n }) === 'string');
t('A: refuses a token address for the proceeds', () => typeof bt.buildSell({ ...sellParams, proceedsAddress: addrOf(keyAt(1, 4), 'p2pkhWithTokens') }) === 'string');

// B: the vault send spends A's proceeds.
const vault = addrOf(la.generatePrivateKey()).slice('bitcoincash:'.length); // THORChain lists it without the prefix
const memo = '=:BSC.USDT-0X55D398326F99059FF775485246999027B3197955:0x435afaC555fe115f18e657E49960063c12C6AEd0:3/1/0'.slice(0, 80);
const coin = typeof A === 'object' ? { txid: pt.txidOf(sA || A.hex), vout: A.proceedsVout, satoshis: A.proceeds, lockingBytecode: A.proceedsLock, path: ['change', 4] } : null;
const amount = coin ? coin.satoshis - bt.vaultSendBytes(80, false) * 3n : 0n;
const sendParams = { coin, vault, memo, amount, changeAddress: proceedsAddress, feePerByte: 3n, provider, label: '3.7 USDT on BSC' };
let B; try { B = bt.buildVaultSend(sendParams); } catch (e) { B = `threw: ${String(e).slice(0, 200)}`; }
let sB = '', eB = '';
try { sB = typeof B === 'string' ? '' : walletSign(B, false); } catch (e) { eB = String(e).slice(0, 200); }
t('B builds', () => { if (typeof B === 'string') console.log('   build said:', B); return typeof B === 'object'; });
t('B: the test wallet could sign', () => { if (eB) console.log('   sign error:', eB); return sB.length > 0; });
t('B: one input = A\'s proceeds at its path', () => B.transaction.inputs.length === 1 && B.inputPaths[0].join() === '0,change,4'
  && la.binToHex(B.transaction.inputs[0].outpointTransactionHash) === coin.txid && B.transaction.inputs[0].outpointIndex === A.proceedsVout);
t('B: output 0 pays the vault exactly the quoted amount; OP_RETURN carries the memo byte for byte', () => {
  const [v, ...rest] = B.transaction.outputs;
  const op = rest.find((o) => o.lockingBytecode[0] === 0x6a);
  const vLock = la.binToHex(la.cashAddressToLockingBytecode(`bitcoincash:${vault}`).bytecode);
  // memo >= 76 bytes is pushed with OP_PUSHDATA1 (0x4c <len>), shorter ones with a single length byte
  const pushed = op && la.binToUtf8(op.lockingBytecode.slice(op.lockingBytecode[1] === 0x4c ? 3 : 2));
  return la.binToHex(v.lockingBytecode) === vLock && v.valueSatoshis === amount && op && op.valueSatoshis === 0n && pushed === memo;
});
t('B: signed passes checkSigned (no pool) and the VM; with the pool rule it would be refused', () =>
  pt.checkSigned(B, sB, { poolInput: false }) === null && vmOk(B, sB) === true && pt.checkSigned(B, sB) !== null);
t('B: fee >= signed size x 3 sat/B (THORChain gas rate)', () => B.networkFee >= BigInt(la.hexToBin(sB).length) * 3n);
t('B: a changed output is refused (rule 4)', () => {
  const tx = la.decodeTransaction(la.hexToBin(sB)); tx.outputs[0].valueSatoshis -= 1000n;
  return pt.checkSigned(B, la.binToHex(la.encodeTransaction(tx)), { poolInput: false }) !== null;
});
t('B: refuses a memo over 80 bytes', () => typeof bt.buildVaultSend({ ...sendParams, memo: 'x'.repeat(81) }) === 'string');
t('B: refuses change to another address (THORChain refunds to the sender)', () => typeof bt.buildVaultSend({ ...sendParams, changeAddress: addrOf(keyAt(1, 5)) }) === 'string');
t('B: refuses an amount the coin cannot carry with the fee', () => typeof bt.buildVaultSend({ ...sendParams, amount: coin.satoshis }) === 'string');
t('B: refuses a chipnet or script vault', () => typeof bt.buildVaultSend({ ...sendParams, vault: 'bchtest:' + vault }) === 'string');
t('B: large spare goes back as change to the sender', () => {
  const r = bt.buildVaultSend({ ...sendParams, amount: amount - 10_000n });
  return typeof r === 'object' && r.transaction.outputs.length === 3 && r.change > 9_000n
    && la.binToHex(r.transaction.outputs[1].lockingBytecode) === la.binToHex(A.proceedsLock);
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
