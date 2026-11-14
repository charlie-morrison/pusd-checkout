// Read-only view of the Cauldron pools for the network's token. No keys, no signing.

export interface Pool {
  pool_id: string;
  txid: string;
  tx_pos: number;
  sats: number;
  tokens: number;
  token_id: string;
}

export interface PoolSummary {
  count: number;
  tokenUnits: bigint;
  sats: bigint;
  // Cheapest spot price among pools, in satoshis per whole token (decimals applied).
  bestSatsPerToken: number | null;
}

export async function fetchPools(indexer: string, category: string, timeoutMs = 20000): Promise<Pool[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${indexer}/cauldron/pool/active?token=${category}`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
    const body = await res.json();
    const list: Pool[] = Array.isArray(body) ? body : body.active;
    if (!Array.isArray(list)) throw new Error('indexer answer has no pool list');
    // Keep only pools for the token we asked for; the indexer is a third party.
    return list.filter((p) => p.token_id === category && p.sats > 0 && p.tokens > 0);
  } finally {
    clearTimeout(timer);
  }
}

export function summarize(pools: Pool[], decimals: number): PoolSummary {
  let tokenUnits = 0n;
  let sats = 0n;
  let best: number | null = null;
  const unit = 10 ** decimals;
  for (const p of pools) {
    tokenUnits += BigInt(p.tokens);
    sats += BigInt(p.sats);
    const price = (p.sats / p.tokens) * unit;
    if (best === null || price < best) best = price;
  }
  return { count: pools.length, tokenUnits, sats, bestSatsPerToken: best };
}

export function formatUnits(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toLocaleString('en-US');
  const s = units.toString().padStart(decimals + 1, '0');
  const whole = BigInt(s.slice(0, -decimals));
  return `${whole.toLocaleString('en-US')}.${s.slice(-decimals)}`;
}
