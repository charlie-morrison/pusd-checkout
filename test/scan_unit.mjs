// Unit test of the wallet scan (app/src/utxos.ts) against a fake chain. Node >= 23 (strips TS types).
// Usage: node test/scan_unit.mjs [path to utxos.ts]   (the path lets a mutant copy be tested)
// Exit 0 = all cases pass, 1 = a case failed.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as la from '@bitauth/libauth';

const target = process.argv[2] ?? new URL('../app/src/utxos.ts', import.meta.url).pathname;
const { scanWallet, addressOf } = await import(pathToFileURL(target).href);

const root = la.deriveHdPrivateNodeFromSeed(randomBytes(32));
const chainNode = (c) => la.deriveHdPath(root, `m/44'/145'/0'/${c}`);
const pubkeyAt = (shared) => (child, i) => {
  if (!shared.includes(child)) return undefined;
  const n = la.deriveHdPrivateNodeChild(chainNode(child), Number(i));
  return la.secp256k1.derivePublicKeyCompressed(n.privateKey);
};
const addr = (child, i) => addressOf(pubkeyAt([0, 1])(child, BigInt(i)), 'bchtest');

// chain: { 'c/i': { history: n, utxos: [{sats, token?}] } }
function fakeReader(chain) {
  const byAddr = new Map();
  for (const [k, v] of Object.entries(chain)) {
    const [c, i] = k.split('/').map(Number);
    byAddr.set(addr(c, i), v);
  }
  let calls = 0;
  return {
    get calls() { return calls; },
    async history(a) { calls++; const v = byAddr.get(a); return v ? Array.from({ length: v.history }, () => ({})) : []; },
    async utxos(a) {
      calls++;
      const v = byAddr.get(a);
      return (v?.utxos ?? []).map((u, n) => ({ txid: `${a}-${n}`, vout: n, satoshis: BigInt(u.sats), token: u.token }));
    },
  };
}

const cases = [
  ['coins on receive/3 and change/2, none on receive/0', { '0/0': { history: 1 }, '0/3': { history: 1, utxos: [{ sats: 7000 }] }, '1/2': { history: 2, utxos: [{ sats: 1500 }] } },
    [0, 1], (r) => r.spendableSats === 8500n && r.spendable.length === 2 &&
      r.spendable.some((u) => u.chain === 'receive' && u.index === 3) && r.spendable.some((u) => u.chain === 'change' && u.index === 2)],
  ['gap boundary: 19 unused then a coin on receive/19 is found', { '0/19': { history: 1, utxos: [{ sats: 1234 }] } },
    [0, 1], (r) => r.spendableSats === 1234n && r.chains.receive.lastUsed === 19],
  ['gap boundary: 20 unused in a row stops the chain (coin on receive/20 not reached)', { '0/20': { history: 1, utxos: [{ sats: 999 }] } },
    [0, 1], (r) => r.spendableSats === 0n && r.chains.receive.checked === 20 && r.chains.receive.stopped === 'gap'],
  ['an emptied address keeps the scan going (history, no coins)', { '0/0': { history: 3 }, '0/15': { history: 2 }, '0/30': { history: 1, utxos: [{ sats: 5000 }] } },
    [0, 1], (r) => r.spendableSats === 5000n && r.chains.receive.lastUsed === 30 && r.chains.receive.checked === 51],
  ['token coins are listed but not spendable', { '0/0': { history: 1, utxos: [{ sats: 1000, token: { category: 'aa', amount: 5n } }, { sats: 4000 }] } },
    [0, 1], (r) => r.spendableSats === 4000n && r.tokenUtxos === 1 && r.utxos.length === 2],
  ['no change xpub shared', { '0/1': { history: 1, utxos: [{ sats: 10 }] } },
    [0], (r) => r.spendableSats === 10n && r.chains.change.stopped === 'no-xpub'],
  ['empty wallet: 20 + 20 addresses checked, nothing found', {},
    [0, 1], (r) => r.spendableSats === 0n && r.chains.receive.checked === 20 && r.chains.change.checked === 20],
];

let failed = 0;
for (const [name, chain, shared, ok] of cases) {
  let pass = false, info = '';
  try {
    const reader = fakeReader(chain);
    const r = await scanWallet(pubkeyAt(shared), 'bchtest', reader);
    pass = ok(r);
    info = `sats=${r.spendableSats} coins=${r.spendable.length} receive=${JSON.stringify(r.chains.receive)} change=${JSON.stringify(r.chains.change)} calls=${reader.calls}`;
  } catch (e) { info = `threw ${String(e).slice(0, 160)}`; }
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${info}`);
}
console.log(`${cases.length - failed}/${cases.length}`);
process.exit(failed ? 1 : 0);
