// Unit test of the page's WizardConnect sign request (app/src/paytx.ts wcRequest) against the test
// wallet's signer (test/wc_sign.mjs), offline: the request goes through a JSON round trip like the relay,
// the test wallet signs it, and checkSigned + the libauth BCH 2025 VM judge the result.
// Usage: node test/wc_sign_unit.mjs [app/src dir]   (Node >= 23)   Exit 0 = all pass, 1 = a case failed.
import { pathToFileURL } from 'node:url';
import * as la from '@bitauth/libauth';
import * as cs from 'cashscript';
import { signRequest } from './wc_sign.mjs';

const src = process.argv[2] ?? new URL('../app/src', import.meta.url).pathname;
const pt = await import(pathToFileURL(`${src}/paytx.ts`).href);

const provider = new cs.ElectrumNetworkProvider(cs.Network.CHIPNET, { manualConnectionManagement: true });
const prefix = 'bchtest';
const root = la.deriveHdPrivateNodeFromSeed(la.generateRandomBytes(32));
const childPriv = (chain, i) => la.deriveHdPath(root, `m/44'/145'/0'/${chain}/${i}`).privateKey;
const pkhOf = (priv) => la.hash160(la.secp256k1.derivePublicKeyCompressed(priv));
const addrOf = (priv, type = 'p2pkh') => la.encodeCashAddress({ prefix, type, payload: pkhOf(priv) }).address;
const fakeTxid = (s) => la.binToHex(la.sha256.hash(la.utf8ToBin(s)));
const pool = { pool_id: 'p', txid: fakeTxid('pool'), tx_pos: 0, sats: 10_000_000, tokens: 10_000, token_id: fakeTxid('tok'),
  owner_pkh: la.binToHex(pkhOf(la.generatePrivateKey())) };
const coin = (chain, index, sats, tag) => ({ txid: fakeTxid(tag), vout: 0, satoshis: sats, chain: chain === 0 ? 'receive' : 'change', index, address: addrOf(childPriv(chain, index)) });
// 15.11 chipnet layout: nothing on receive/0, coins on receive/3 and change/2; the amount needs both.
const coins = [coin(0, 3, 10_000n, 'r3'), coin(1, 2, 10_000n, 'c2')];
const params = { pool, units: 12n, merchant: addrOf(la.generatePrivateKey(), 'p2pkhWithTokens'), coins,
  changeAddress: addrOf(childPriv(1, 3)), provider, label: '12 TEST' };
const tx = pt.buildPayment(params);
const relay = (o) => JSON.parse(JSON.stringify(o)); // what crosses the relay: plain JSON, nothing else
const req = typeof tx === 'object' ? { transaction: relay(pt.wcRequest(tx)), inputPaths: relay(tx.inputPaths) } : null;
const vm = la.createVirtualMachineBch2025(true);
const vmOk = (hex) => vm.verify({ sourceOutputs: tx.sourceOutputs, transaction: la.decodeTransaction(la.hexToBin(hex)) });
const tryIt = (f) => { try { return f(); } catch (e) { return { error: String(e?.message ?? e) }; } };

const cases = [];
const t = (name, fn) => cases.push([name, fn]);
const signed = req ? tryIt(() => signRequest(req, childPriv, 'sign')) : { error: String(tx) };
t('builds a two-input payment (receive/3 + change/2)', () => typeof tx === 'object' && JSON.stringify(tx.inputPaths) === '[[1,"receive",3],[2,"change",2]]');
t('wire: tx as hex (rule 7), broadcast false, prompt carries the cost (rule 9)', () =>
  req.transaction.transaction === tx.hex && req.transaction.broadcast === false && req.transaction.userPrompt.includes(tx.buyerPays.toLocaleString('en-US')));
t('wire: source outputs survive JSON as hex + "<bigint: Xn>" (rule 1)', () =>
  /^<bigint: \d+n>$/.test(req.transaction.sourceOutputs[1].valueSatoshis) && typeof req.transaction.sourceOutputs[0].lockingBytecode === 'string');
t('test wallet signs both buyer inputs', () => { if (signed.error) console.log('   sign error:', signed.error); return signed.signed?.join(',') === '1:receive/3,2:change/2'; });
t('signed tx passes checkSigned', () => pt.checkSigned(tx, signed.hex) === null);
t('signed tx is VALID in the BCH 2025 VM', () => vmOk(signed.hex) === true);
t('txidOf = the signed tx id', () => pt.txidOf(signed.hex) === signed.txid);
const tampered = tryIt(() => signRequest(req, childPriv, 'tamper-output'));
t('control: wallet that changes an output after signing -> checkSigned refuses', () => /outputs/.test(pt.checkSigned(tx, tampered.hex) ?? ''));
t('control: a path that is not this wallet\'s input -> wallet refuses to sign', () => {
  const bad = relay(req); bad.inputPaths[0] = [1, 'receive', 4];
  return /is not receive\/4/.test(tryIt(() => signRequest(bad, childPriv)).error ?? '');
});
t('control: object-form transaction -> wallet refuses (rule 7)', () => {
  const bad = relay(req); bad.transaction.transaction = { inputs: [] };
  return /not hex/.test(tryIt(() => signRequest(bad, childPriv)).error ?? '');
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
