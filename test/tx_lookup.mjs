// Independent chain read for the payment E2E: is <txid> known to a Fulcrum node of <net>, and how many
// units of <category> does <address> get in it? Prints one JSON line. Reads only, never broadcasts.
// Usage: node test/tx_lookup.mjs <mainnet|chipnet> <txid> [token address] [category]
import * as cs from 'cashscript';
import * as la from '@bitauth/libauth';
const [net, txid, addr, cat] = process.argv.slice(2);
const p = new cs.ElectrumNetworkProvider(net === 'chipnet' ? cs.Network.CHIPNET : cs.Network.MAINNET, { manualConnectionManagement: true });
await p.connect();
const r = { net, txid, found: false };
try {
  const hex = await p.getRawTransaction(txid);
  const tx = la.decodeTransaction(la.hexToBin(hex));
  r.found = typeof tx !== 'string' && la.binToHex(la.hash256(la.hexToBin(hex)).slice().reverse()) === txid;
  if (r.found && addr) {
    const lock = la.binToHex(la.cashAddressToLockingBytecode(addr).bytecode);
    r.to_address = tx.outputs.filter((o) => la.binToHex(o.lockingBytecode) === lock)
      .map((o) => ({ sats: String(o.valueSatoshis), units: o.token && (!cat || la.binToHex(o.token.category) === cat) ? String(o.token.amount) : '0' }));
  }
  r.inputs = typeof tx === 'string' ? null : tx.inputs.length;
  r.outputs = typeof tx === 'string' ? null : tx.outputs.length;
} catch (e) { r.error = String(e?.message ?? e).slice(0, 160); }
await p.disconnect().catch(() => undefined);
console.log(JSON.stringify(r));
process.exit(0);
