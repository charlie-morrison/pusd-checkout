// How the test wallet signs a WizardConnect sign request (shared by test/wc_fake_wallet.mjs and
// test/wc_sign_unit.mjs). Like Cashonize / Paytaca: decode the hex tx (build rule 7), read the relay-form
// source outputs (rule 1), sign only the inputs named by inputPaths, and only if each one is this wallet's
// P2PKH address at that path. mode 'tamper-output' then takes 1,000 sat off the last output AFTER signing:
// a wallet that changes what the buyer saw (the page must refuse it).
import * as la from '@bitauth/libauth';
import { SignatureTemplate } from 'cashscript';

// Relay JSON -> libauth types (bytes are hex, bigints are "<bigint: Xn>", build rule 1).
export const BYTES = new Set(['outpointTransactionHash', 'unlockingBytecode', 'lockingBytecode', 'category', 'commitment']);
export function fromRelay(v, key) {
  if (typeof v === 'string') {
    const m = /^<bigint: (-?\d+)n>$/.exec(v);
    if (m) return BigInt(m[1]);
    return BYTES.has(key) ? la.hexToBin(v) : v;
  }
  if (Array.isArray(v)) return v.map((x) => fromRelay(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromRelay(x, k)]));
  return v;
}
export function signRequest(req, childPriv, signMode = 'sign') {
  const wc = req.transaction;
  if (typeof wc?.transaction !== 'string') throw new Error('transaction is not hex (build rule 7)');
  const tx = la.decodeTransaction(la.hexToBin(wc.transaction));
  if (typeof tx === 'string') throw new Error(`cannot decode: ${tx}`);
  const sourceOutputs = fromRelay(wc.sourceOutputs);
  if (!Array.isArray(sourceOutputs) || sourceOutputs.length !== tx.inputs.length) throw new Error('sourceOutputs do not match the inputs');
  const signed = [];
  for (const [k, pathName, i] of req.inputPaths) {
    const chain = pathName === 'receive' ? 0 : pathName === 'change' ? 1 : null;
    if (chain === null) throw new Error(`unknown path ${pathName}`);
    const priv = childPriv(chain, i);
    const mine = la.binToHex(la.encodeLockingBytecodeP2pkh(la.hash160(la.secp256k1.derivePublicKeyCompressed(priv))));
    if (la.binToHex(sourceOutputs[k].lockingBytecode) !== mine) throw new Error(`input ${k} is not ${pathName}/${i} of this wallet`);
    tx.inputs[k].unlockingBytecode = new SignatureTemplate(priv).unlockP2PKH()
      .generateUnlockingBytecode({ transaction: tx, sourceOutputs, inputIndex: k });
    signed.push(`${k}:${pathName}/${i}`);
  }
  if (signMode === 'tamper-output') tx.outputs[tx.outputs.length - 1].valueSatoshis -= 1000n;
  const bin = la.encodeTransaction(tx);
  return { hex: la.binToHex(bin), txid: la.binToHex(la.hash256(bin).slice().reverse()), signed };
}
