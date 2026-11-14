// BLAZE checkout prep spike (NOT the product; the judged build starts 14.11 in this repo (see README)).
// Question: does the whole stack run inside a BROWSER from a static page, with no server of ours?
// Node runs on 05-06.11 proved the logic; this measures the browser delta only:
//   1) the bundle loads (Vite/Rollup production build, no Node polyfills added by us)
//   2) Cauldron indexer fetch from the page origin (CORS)
//   3) Electrum over browser WebSocket via cashscript ElectrumNetworkProvider (pool UTXO seen on chain)
//   4) WizardConnect relay from the browser: a wiz:// URI and a live relay connection
//   5) the product tx object (pool swap + merchant tokens + change) built and wire-encoded (no signing, fake buyer)
// Results go to window.__spike (read by the test harness over CDP) and to the page.
import * as core from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import * as la from '@bitauth/libauth';
import { ElectrumNetworkProvider, Contract, TransactionBuilder, placeholderP2PKHUnlocker } from 'cashscript';
import { cauldronArtifactWithPkh, convertPoolToUtxo } from '@mr-zwets/cauldron-swap-sdk/dist/utils.js';
import { ceilDiv } from '@mr-zwets/cauldron-swap-sdk/dist/multipool.js';

let relayRef, dmRef;
const S = (window.__spike = { started: new Date().toISOString(), steps: {}, done: false });
const out = document.getElementById('out');
const put = (k, v) => { S.steps[k] = v; out.textContent = JSON.stringify(S, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 1); };
const CONTROL = new URLSearchParams(location.search).has('control'); // control run: steps 3 and 5 MUST fail
const TEST_CATEGORY = '53636bc8c1afbe35a7ba169eadfac0aebadeacf96954a9a066a483e885580ed4'; // chipnet test token
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: timeout ${ms} ms`)), ms))]);
const hexify = (x) => (x instanceof Uint8Array ? la.binToHex(x) : typeof x === 'bigint' ? `<bigint: ${x}n>`
  : Array.isArray(x) ? x.map(hexify) : (x && typeof x === 'object') ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, hexify(v)])) : x);

async function run() {
  S.control = CONTROL;
  put('1_bundle', { ok: typeof la.binToHex === 'function' && typeof DappConnectionManager === 'function', has_Buffer_global: typeof globalThis.Buffer !== 'undefined', has_process_global: typeof globalThis.process !== 'undefined' });

  let pool;
  try {
    const t0 = performance.now();
    const res = await withTimeout(fetch(`https://indexer-chipnet.riften.net/cauldron/pool/active?token=${TEST_CATEGORY}`), 20000, 'indexer');
    const pools = (await res.json()).active;
    pool = pools.sort((a, b) => b.sats - a.sats)[0];
    put('2_indexer_cors', { ok: !!pool, ms: Math.round(performance.now() - t0), pools: pools.length, pool: pool && { id: pool.pool_id.slice(0, 12), sats: pool.sats, tokens: pool.tokens } });
  } catch (e) { put('2_indexer_cors', { ok: false, error: String(e).slice(0, 300) }); }

  let provider, contract, poolUtxo;
  if (pool) {
    try {
      const t0 = performance.now();
      provider = new ElectrumNetworkProvider('chipnet');
      const pkh = CONTROL ? '00'.repeat(20) : pool.owner_pkh; // control: a contract nobody funded
      contract = new Contract(cauldronArtifactWithPkh(pkh), [], { provider, addressType: 'p2sh32' });
      const utxos = await withTimeout(provider.getUtxos(contract.address), 30000, 'electrum');
      const live = utxos.find((u) => u.txid === pool.txid && u.vout === pool.tx_pos);
      put('3_electrum_ws', { ok: !!live && live.token?.amount === BigInt(pool.tokens), ms: Math.round(performance.now() - t0), contract_utxos: utxos.length });
      poolUtxo = { ...convertPoolToUtxo(pool), lockingBytecode: la.binToHex(la.cashAddressToLockingBytecode(contract.address).bytecode) };
    } catch (e) { put('3_electrum_ws', { ok: false, error: String(e).slice(0, 300) }); }
  }

  try {
    const t0 = performance.now();
    const dm = new DappConnectionManager('prep browser spike', undefined, { session: false });
    const statuses = [];
    const relay = core.initiateDappRelay(({ client, status }) => { statuses.push(String(status?.status ?? status)); dm.updateConnection(client, status); });
    const uriOk = /^wiz:\/\/\?p=[a-z0-9]+&s=[a-z0-9]+/.test(relay.uri);
    await new Promise((r) => setTimeout(r, 6000));
    put('4_relay', { ok: uriOk && statuses.length > 0, uri_shape_ok: uriOk, ms_to_report: Math.round(performance.now() - t0), statuses: [...new Set(statuses)].slice(0, 8) });
    relayRef = relay; dmRef = dm; // NOT on S: S is JSON-stringified by put() (06.11 spike bug: circular)
  } catch (e) { put('4_relay', { ok: false, error: String(e).slice(0, 300) }); }

  if (poolUtxo) {
    try {
      const demand = 40n;
      const k = BigInt(pool.tokens) * BigInt(pool.sats);
      const newSats = ceilDiv(k, BigInt(pool.tokens) - demand);
      const trade = newSats - BigInt(pool.sats);
      const lpFee = ceilDiv(trade * 3n, 997n);
      const buyerPkh = la.hash160(la.secp256k1.derivePublicKeyCompressed(la.generatePrivateKey()));
      const buyerAddr = la.encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: buyerPkh }).address;
      const merchantAddr = la.encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: la.hash160(la.secp256k1.derivePublicKeyCompressed(la.generatePrivateKey())) }).address;
      const bu = { txid: la.binToHex(la.sha256.hash(la.utf8ToBin('prep-spike-' + Date.now()))), vout: 0, satoshis: 100000n, lockingBytecode: la.binToHex(la.encodeLockingBytecodeP2pkh(buyerPkh)) };
      const tb = new TransactionBuilder({ provider, maximumFeeSatsPerByte: 10 });
      tb.addInput(poolUtxo, contract.unlock.swap());
      tb.addInput(bu, placeholderP2PKHUnlocker(buyerAddr));
      tb.addOutput({ to: contract.tokenAddress, amount: newSats + lpFee, token: { category: TEST_CATEGORY, amount: ceilDiv(k, newSats) } });
      tb.addOutput({ to: merchantAddr, amount: 1000n, token: { category: TEST_CATEGORY, amount: demand } });
      tb.addOutput({ to: buyerAddr, amount: bu.satoshis - (trade + lpFee) - 1000n - 800n });
      const o = tb.generateWcTransactionObject({ broadcast: false, userPrompt: 'spike' });
      const wire = JSON.stringify(CONTROL ? o : hexify(o)); // control: raw Uint8Array must trip the guard
      put('5_product_tx_object', { ok: wire.length > 500 && !/"0":/.test(wire) && !/<Uint8Array/.test(wire), wire_bytes: wire.length, inputs: o.transaction.inputs.length, outputs: o.transaction.outputs.length, buyer_pays: String(trade + lpFee + 1800n) });
    } catch (e) { put('5_product_tx_object', { ok: false, error: String(e).slice(0, 300) }); }
  } else put('5_product_tx_object', { ok: false, error: 'no pool utxo (step 2/3 failed)' });

  try { relayRef?.cleanup(); dmRef?.destroy(); await provider?.disconnect(); } catch { /* ignore */ }
  S.all_ok = Object.values(S.steps).every((s) => s.ok);
  S.done = true; put('z_end', { ok: true, at: new Date().toISOString() });
}
window.addEventListener('error', (e) => { S.page_errors = [...(S.page_errors || []), String(e.message).slice(0, 200)]; });
window.addEventListener('unhandledrejection', (e) => { S.page_errors = [...(S.page_errors || []), String(e.reason).slice(0, 200)]; });
run();
