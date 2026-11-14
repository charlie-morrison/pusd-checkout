// BLAZE checkout prep, build prep before the 14.11 fork.
// Question: will a REAL WizardConnect wallet sign our one-tx "swap BCH->PUSD on Cauldron + pay the merchant"
// request, and is what it returns a valid transaction?
// Method (offline, nothing broadcast, throwaway keys): build the sign request exactly as the checkout would
// (cashscript generateWcTransactionObject, pool input pre-unlocked, buyer input left for the wallet), put it
// on the wire as JSON the way the WizardConnect reference serializer does (Uint8Array -> hex,
// bigint -> "<bigint: Xn>"), then run it through Cashonize's OWN code: the strict zod schema
// (src/utils/dapp/zodValidation.ts), the store's structural checks (validateWizTransaction, copied verbatim),
// key derivation as in deriveInputKeys, and createSignedWizTransaction (src/utils/dapp/wizSigning.ts).
// The signed hex is judged by libauth's BCH VM (bch2025 + bch2026), independently of the wallet.
//
// Usage: tsx wc_wallet_sign_check.mts <node_modules> <cashonize src dir> <spike-pool.json> <pusd_amount>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [nm, cz, poolPath, pusdArg] = process.argv.slice(2);
const imp = (p: string) => import(pathToFileURL(p).href);
const cs = await imp(path.join(nm, 'cashscript/dist/index.js'));
const la = await imp(path.join(nm, '@bitauth/libauth/build/index.js'));
const sdkUtils = await imp(path.join(nm, '@mr-zwets/cauldron-swap-sdk/dist/utils.js'));
const { ceilDiv } = await imp(path.join(nm, '@mr-zwets/cauldron-swap-sdk/dist/multipool.js'));
const zv = await imp(path.join(cz, 'utils/dapp/zodValidation.ts'));
const ws = await imp(path.join(cz, 'utils/dapp/wizSigning.ts'));

const pool = JSON.parse(readFileSync(poolPath, 'utf8'));
const demand = BigInt(Math.round(Number(pusdArg) * 100)); // PUSD base units (2 decimals)
const provider = new cs.MockNetworkProvider({ updateUtxoSet: false });
provider.network = 'mainnet';

// --- buyer = an HD wallet laid out like Cashonize: m/44'/145'/0' then chain 0 = 'receive'
const seed = la.generateRandomBytes(32);
const root = la.deriveHdPrivateNodeFromSeed(seed);
const receiveChain = la.deriveHdPath(root, "m/44'/145'/0'/0");
const buyerNode = la.deriveHdPrivateNodeChild(receiveChain, 0);
const buyerPub = la.secp256k1.derivePublicKeyCompressed(buyerNode.privateKey);
const buyerAddr = la.encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: la.hash160(buyerPub) }).address;
// merchant = a separate throwaway key (it never signs; it only receives the PUSD)
const mPriv = la.generatePrivateKey();
const merchantTokenAddr = la.encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkhWithTokens', payload: la.hash160(la.secp256k1.derivePublicKeyCompressed(mPriv)) }).address;

const contract = new cs.Contract(sdkUtils.cauldronArtifactWithPkh(pool.owner_pkh), [], { provider, addressType: 'p2sh32', contractType: 'p2sh32' });
const spkMatches = la.binToHex(la.cashAddressToLockingBytecode(contract.address).bytecode) === pool.onchain_spk;

function poolOut() {
  const k = BigInt(pool.tokens) * BigInt(pool.sats);
  const newSatsExclFee = ceilDiv(k, BigInt(pool.tokens) - demand);
  const trade = newSatsExclFee - BigInt(pool.sats);
  const fee = ceilDiv(trade * 3n, 997n);
  return { sats: newSatsExclFee + fee, tokens: ceilDiv(k, newSatsExclFee), paid: trade + fee };
}
const po = poolOut();
// cashscript >= 0.14 wants lockingBytecode on hand-built UTXOs (hex)
const buyerUtxo = { txid: la.binToHex(la.sha256.hash(la.utf8ToBin('prep-wcsign-' + Date.now()))), vout: 0, satoshis: 10_000_000n,
  lockingBytecode: la.binToHex(la.cashAddressToLockingBytecode(buyerAddr).bytecode) };
const poolUtxo = { ...sdkUtils.convertPoolToUtxo(pool), lockingBytecode: pool.onchain_spk };
const MINER_FEE = 800n, TOKEN_DUST = 1000n;

const tb = new cs.TransactionBuilder({ provider, maximumFeeSatsPerByte: 10 });
tb.addInput(poolUtxo, contract.unlock.swap());     // input 0 = pool, pre-unlocked
tb.addInput(buyerUtxo, cs.placeholderP2PKHUnlocker(buyerAddr));             // input 1 = buyer, left for the wallet
tb.addOutput({ to: contract.tokenAddress, amount: po.sats, token: { category: pool.token_id, amount: po.tokens } });
tb.addOutput({ to: merchantTokenAddr, amount: TOKEN_DUST, token: { category: pool.token_id, amount: demand } });
tb.addOutput({ to: buyerAddr, amount: buyerUtxo.satoshis - po.paid - TOKEN_DUST - MINER_FEE });
const wcObj = tb.generateWcTransactionObject({ broadcast: false, userPrompt: `Pay ${Number(demand) / 100} PUSD (BCH swapped on Cauldron in the same tx)` });

// --- WizardConnect wire form (JSON): Uint8Array -> plain hex, bigint -> "<bigint: Xn>"
const toWire = (v: unknown): unknown => {
  if (v instanceof Uint8Array) return la.binToHex(v);
  if (typeof v === 'bigint') return `<bigint: ${v}n>`;
  if (Array.isArray(v)) return v.map(toWire);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toWire(x)]));
  return v;
};
const BUYER_INPUT = 1;
const makeRequest = (inputPaths: unknown) => JSON.parse(JSON.stringify(toWire({
  sequence: 1, inputPaths, transaction: { transaction: wcObj.transaction, sourceOutputs: wcObj.sourceOutputs, broadcast: false, userPrompt: wcObj.userPrompt },
})));

// copied verbatim from cashonize src/stores/wizardconnectStore.ts validateWizTransaction (v0.15.2 tree, 04.11)
function validateWizTransaction(request: any): string | undefined {
  const { transaction, sourceOutputs } = request.transaction;
  const decodedTransaction = typeof transaction === 'string' ? la.decodeTransaction(la.hexToBin(transaction)) : transaction;
  if (typeof decodedTransaction === 'string') return 'Invalid transaction hex string in sign request: ' + decodedTransaction;
  if (decodedTransaction.inputs.length !== sourceOutputs.length) return 'Transaction inputs and sourceOutputs length mismatch';
  const invalidInputPath = request.inputPaths.find(([inputIndex]: [number]) => inputIndex >= decodedTransaction.inputs.length);
  if (invalidInputPath) return `inputPaths entry references non-existent input ${invalidInputPath[0]}`;
  return undefined;
}
// as in deriveInputKeys: 'receive' -> chain 0
function deriveInputKeys(inputPaths: [number, string, number][]) {
  const keys = new Map<number, { privateKey: Uint8Array; pubkeyCompressed: Uint8Array }>();
  for (const [inputIndex, pathName, addressIndex] of inputPaths) {
    if (pathName !== 'receive') throw new Error('test wallet only has the receive chain');
    const child = la.deriveHdPrivateNodeChild(receiveChain, addressIndex);
    keys.set(inputIndex, { privateKey: child.privateKey, pubkeyCompressed: la.secp256k1.derivePublicKeyCompressed(child.privateKey) });
  }
  return keys;
}

const realSourceOutputs = [
  { lockingBytecode: la.hexToBin(pool.onchain_spk), valueSatoshis: BigInt(pool.sats), token: { category: la.hexToBin(pool.token_id), amount: BigInt(pool.tokens), nft: undefined } },
  { lockingBytecode: la.cashAddressToLockingBytecode(buyerAddr).bytecode, valueSatoshis: buyerUtxo.satoshis },
];
function vmVerify(hex: string, sourceOutputs = realSourceOutputs) {
  const tx = la.decodeTransaction(la.hexToBin(hex));
  const out: Record<string, unknown> = {};
  for (const [name, vm] of [['bch2025', la.createVirtualMachineBch2025(true)], ['bch2026', la.createVirtualMachineBch2026(true)]] as const) {
    const r = vm.verify({ transaction: tx, sourceOutputs });
    out[name] = r === true ? true : String(r).slice(0, 200);
  }
  return { tx, vm: out };
}

function walletFlow(wire: any) {
  const parsed = zv.StrictWizSignTransactionRequestSchema.safeParse(wire);
  if (!parsed.success) return { stage: 'schema', ok: false, error: zv.describeSchemaError ? zv.describeSchemaError(parsed.error) : String(parsed.error).slice(0, 300) };
  const verr = validateWizTransaction(parsed.data);
  if (verr) return { stage: 'validate', ok: false, error: verr };
  let hex: string;
  try { hex = la.binToHex(ws.createSignedWizTransaction(parsed.data.transaction, deriveInputKeys(parsed.data.inputPaths))); }
  catch (e) { return { stage: 'sign', ok: false, error: String(e).slice(0, 300) }; }
  const { tx, vm } = vmVerify(hex);
  const merchantOut = tx.outputs[1];
  return {
    stage: 'signed', bytes: hex.length / 2, vm,
    ok: vm.bch2025 === true && vm.bch2026 === true,
    merchant_pusd: merchantOut?.token ? Number(merchantOut.token.amount) / 100 : null,
    pool_unlock_untouched: la.binToHex(tx.inputs[0].unlockingBytecode) === la.binToHex(wcObj.transaction.inputs[0].unlockingBytecode),
    outputs_untouched: JSON.stringify(tx.outputs.map((o: any) => [String(o.valueSatoshis), la.binToHex(o.lockingBytecode)])) === JSON.stringify(wcObj.transaction.outputs.map((o: any) => [String(o.valueSatoshis), la.binToHex(o.lockingBytecode)])),
    buyer_sighash_byte: (() => { const u = tx.inputs[1].unlockingBytecode; return u.length > 65 ? u[u.length - 34 - 1] : null; })(),
    hex,
  };
}

const main = walletFlow(makeRequest([[BUYER_INPUT, 'receive', 0]]));
// control A: the dapp lists the POOL input for signing -> the wallet must not produce a valid tx
const ctlWrongInput = walletFlow(makeRequest([[0, 'receive', 0]]));
// control B: a field the schema requires is missing -> strict schema must reject before signing
const brokenWire = makeRequest([[BUYER_INPUT, 'receive', 0]]);
delete brokenWire.transaction.sourceOutputs[1].sequenceNumber;
const ctlSchema = walletFlow(brokenWire);
// control C: the dapp misdescribes the buyer coin's value (+1 sat) -> SIGHASH_UTXOS makes the signature invalid
let ctlUtxos: unknown = null;
if (main.ok && main.hex) {
  const lying = realSourceOutputs.map((s, i) => (i === 1 ? { ...s, valueSatoshis: s.valueSatoshis + 1n } : s));
  ctlUtxos = vmVerify(main.hex, lying).vm;
}
// control D: an unsigned buyer input (wallet skipped) must fail too
const ctlUnsigned = vmVerify(la.binToHex(la.encodeTransaction(wcObj.transaction))).vm;

const { hex: _h, ...mainShown } = main as any;
console.log(JSON.stringify({
  pool: pool.pool_id, demand_pusd: Number(demand) / 100, contract_spk_matches_onchain: spkMatches,
  buyer_pays_sats: Number(po.paid + TOKEN_DUST + MINER_FEE),
  wallet_flow: mainShown,
  control_pool_input_in_inputPaths: { stage: ctlWrongInput.stage, ok: ctlWrongInput.ok, vm: (ctlWrongInput as any).vm, error: (ctlWrongInput as any).error },
  control_schema_missing_field: { stage: ctlSchema.stage, ok: ctlSchema.ok, error: String((ctlSchema as any).error ?? '').slice(0, 160) },
  control_lying_buyer_value: ctlUtxos,
  control_buyer_unsigned: ctlUnsigned,
}, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 1));
