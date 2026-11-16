// THORChain half of the quote engine: the bridge between PUSD on Bitcoin Cash and a dollar
// stablecoin on another chain (BCH BLAZE "Stablecoin Bridge" bounty). Read-only: chain status and
// quotes. Nothing here signs or sends anything.
//
//   OUT  PUSD --(Cauldron sell, WizardConnect)--> BCH --(plain send to the THORChain vault + memo)--> USDT / USDC
//   IN   USDT / USDC --(EVM wallet: approve + depositWithExpiry)--> BCH --(Cauldron buy, WizardConnect)--> PUSD
//
// THORChain amounts are always in 1e8 units, whatever the asset's own decimals.

// Sends `Access-Control-Allow-Origin: *` on GET and preflight (measured 16.11 for charliemorrison.dev);
// thornode.ninerealms.com did not answer at all that day.
export const THOR_API = 'https://gateway.liquify.com/chain/thorchain_api/thorchain';

export const BCH_ASSET = 'BCH.BCH';

export interface Stable { asset: string; chain: string; label: string; symbol: string }
export const STABLES: Stable[] = [
  { asset: 'BSC.USDT-0X55D398326F99059FF775485246999027B3197955', chain: 'BSC', label: 'USDT on BNB Smart Chain', symbol: 'USDT' },
  { asset: 'BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913', chain: 'BASE', label: 'USDC on Base', symbol: 'USDC' },
];

export const chainOf = (asset: string) => asset.split('.')[0].toUpperCase();

// ---------- chain status (inbound_addresses) ----------

export interface InboundEntry {
  chain: string; address: string; router?: string | null;
  halted: boolean; global_trading_paused: boolean; chain_trading_paused: boolean;
  gas_rate?: string; gas_rate_units?: string;
}
export interface ChainStatus { chain: string; open: boolean; reason: string | null; gasRate: bigint | null }

export function chainStatus(inbound: InboundEntry[], chain: string): ChainStatus {
  const c = inbound.find((x) => x.chain === chain);
  if (!c) return { chain, open: false, reason: `THORChain does not list ${chain} right now.`, gasRate: null };
  const gasRate = /^\d+$/.test(c.gas_rate ?? '') ? BigInt(c.gas_rate as string) : null;
  if (c.global_trading_paused) return { chain, open: false, reason: 'THORChain has paused all trading.', gasRate };
  if (c.halted) return { chain, open: false, reason: `THORChain has halted the ${chain} chain.`, gasRate };
  if (c.chain_trading_paused) return { chain, open: false, reason: `THORChain has paused trading on ${chain}.`, gasRate };
  return { chain, open: true, reason: null, gasRate };
}

// ---------- active vaults (vaults/asgard) ----------
// A quote names one vault; THORChain runs several, and two nodes may hand out different ones. The check
// is "this address belongs to an ACTIVE vault for that chain", not "it equals the inbound_addresses entry".

export type Vaults = Map<string, { addresses: Set<string>; routers: Set<string> }>;

interface AsgardVault { status?: string; addresses?: { chain: string; address: string }[]; routers?: { chain: string; router: string }[] }

export function activeVaults(asgard: AsgardVault[]): Vaults {
  const m: Vaults = new Map();
  const slot = (chain: string) => {
    let s = m.get(chain);
    if (!s) { s = { addresses: new Set(), routers: new Set() }; m.set(chain, s); }
    return s;
  };
  for (const v of asgard) {
    if (v.status !== 'ActiveVault') continue;
    for (const a of v.addresses ?? []) slot(a.chain).addresses.add(a.address.toLowerCase());
    for (const r of v.routers ?? []) slot(r.chain).routers.add(r.router.toLowerCase());
  }
  return m;
}

// ---------- quotes (/quote/swap) ----------

export interface SwapRequest { from: string; to: string; amountIn: bigint; destination: string }

export interface ThorQuote {
  req: SwapRequest;
  expectedOut: bigint;          // 1e8 units of `to`, after every THORChain fee
  fees: { outbound: bigint; liquidity: bigint; affiliate: bigint; total: bigint; totalBps: number; slippageBps: number };
  minIn: bigint;                // recommended_min_amount_in, 1e8 units of `from`
  expiry: number;               // unix seconds; never send after it
  inboundAddress: string;
  router: string | null;        // EVM router for token deposits (IN leg)
  memo: string;
  dust: bigint;
  seconds: number;              // THORChain's own best-case estimate
  gasRate: string; gasUnits: string;
}

export type QuoteKind = 'halted' | 'minimum' | 'refused' | 'invalid';
export type QuoteResult = { ok: true; q: ThorQuote } | { ok: false; kind: QuoteKind; error: string };

const MIN_SECONDS_LEFT = 60;    // a quote that dies within a minute is not worth showing as payable
const OP_RETURN_MAX = 80;       // THORChain's note for BCH inbound: OP_RETURN "limited to 80 bytes"

const isUint = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);
const big = (v: unknown) => (isUint(v) ? BigInt(v) : 0n);

export function thorUnits(display: string): bigint | null {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(display)) return null;
  const [w, f = ''] = display.split('.');
  return BigInt(w) * 100000000n + BigInt((f + '00').slice(0, 2)) * 1000000n;
}

export function formatThor(units: bigint, digits = 2): string {
  const neg = units < 0n;
  const a = neg ? -units : units;
  const scale = 10n ** BigInt(8 - digits);
  const r = (a + scale / 2n) / scale;
  const s = r.toString().padStart(digits + 1, '0');
  return `${neg ? '-' : ''}${BigInt(s.slice(0, -digits)).toLocaleString('en-US')}.${s.slice(-digits)}`;
}

export function parseQuote(raw: unknown, req: SwapRequest, vaults: Vaults, nowSec: number): QuoteResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.message === 'string' && !('expected_amount_out' in r)) {
    const m = r.message;
    if (/halt|paused/i.test(m)) return { ok: false, kind: 'halted', error: `THORChain is not swapping this pair right now (${m.slice(0, 120)}).` };
    if (/dust threshold|less than|too small|minimum/i.test(m)) return { ok: false, kind: 'minimum', error: 'The amount is below THORChain\'s minimum for this route.' };
    return { ok: false, kind: 'refused', error: `THORChain refused the quote: ${m.slice(0, 160)}` };
  }
  const bad = (error: string): QuoteResult => ({ ok: false, kind: 'invalid', error });
  if (!isUint(r.expected_amount_out) || BigInt(r.expected_amount_out) <= 0n) return bad('THORChain sent a quote with no output amount.');
  const fees = (r.fees ?? {}) as Record<string, unknown>;
  if (typeof fees.asset !== 'string' || fees.asset.toUpperCase() !== req.to.toUpperCase()) return bad('THORChain quoted fees in an unexpected asset.');
  if (typeof r.expiry !== 'number' || r.expiry - nowSec < MIN_SECONDS_LEFT) return bad('The THORChain quote expires too soon; ask again.');

  // The memo is what tells THORChain where to pay. It must name the asset we asked for and OUR destination.
  const memo = typeof r.memo === 'string' ? r.memo : '';
  const parts = memo.split(':');
  const assetPart = (parts[1] ?? '').toUpperCase();
  const assetOk = req.to === BCH_ASSET ? (assetPart === 'C' || assetPart === BCH_ASSET)
    : assetPart.includes('.') && req.to.toUpperCase().startsWith(assetPart);
  const destOk = req.destination.startsWith('0x')
    ? (parts[2] ?? '').toLowerCase() === req.destination.toLowerCase()
    : parts[2] === req.destination;
  if (parts[0] !== '=' || !assetOk || !destOk) return bad('The THORChain memo does not pay the asset and address you asked for.');

  const fromChain = chainOf(req.from);
  if (fromChain === 'BCH' && new TextEncoder().encode(memo).length > OP_RETURN_MAX) return bad('The THORChain memo is too long for a BCH OP_RETURN.');

  const inbound = typeof r.inbound_address === 'string' ? r.inbound_address : '';
  const v = vaults.get(fromChain);
  if (!inbound || !v || !v.addresses.has(inbound.toLowerCase())) return bad('The quote names a THORChain vault that is not active.');
  const router = typeof r.router === 'string' ? r.router : null;
  if (fromChain !== 'BCH' && (!router || !v.routers.has(router.toLowerCase()))) return bad('The quote names a THORChain router that is not active.');

  const minIn = big(r.recommended_min_amount_in);
  if (req.amountIn < minIn) {
    const sym = req.from === BCH_ASSET ? 'BCH' : (req.from.split('.')[1] ?? '').split('-')[0];
    return { ok: false, kind: 'minimum', error: `The amount is below THORChain's minimum for this route (${formatThor(minIn, req.from === BCH_ASSET ? 8 : 2)} ${sym}).` };
  }
  return {
    ok: true,
    q: {
      req, expectedOut: BigInt(r.expected_amount_out),
      fees: { outbound: big(fees.outbound), liquidity: big(fees.liquidity), affiliate: big(fees.affiliate), total: big(fees.total),
              totalBps: Number(fees.total_bps ?? 0), slippageBps: Number(fees.slippage_bps ?? 0) },
      minIn, expiry: r.expiry, inboundAddress: inbound, router, memo, dust: big(r.dust_threshold),
      seconds: Number(r.total_swap_seconds ?? 0),
      gasRate: String(r.recommended_gas_rate ?? ''), gasUnits: String(r.gas_rate_units ?? ''),
    },
  };
}

// ---------- network calls ----------

async function thorGet(path: string, timeoutMs = 20000): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // A refused quote comes back as HTTP 400 with a JSON body ({code, message}); read it either way.
    const res = await fetch(`${THOR_API}${path}`, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error(`THORChain HTTP ${res.status}, not JSON`); }
  } finally {
    clearTimeout(timer);
  }
}

export interface ThorState { inbound: InboundEntry[]; vaults: Vaults; readAt: number }

export async function readThorState(): Promise<ThorState> {
  const [inbound, asgard] = await Promise.all([thorGet('/inbound_addresses'), thorGet('/vaults/asgard')]);
  if (!Array.isArray(inbound) || !Array.isArray(asgard)) throw new Error('THORChain status answer is not a list');
  return { inbound: inbound as InboundEntry[], vaults: activeVaults(asgard as AsgardVault[]), readAt: Math.floor(Date.now() / 1000) };
}

export async function quoteSwap(req: SwapRequest, state: ThorState): Promise<QuoteResult> {
  for (const chain of [chainOf(req.from), chainOf(req.to)]) {
    const s = chainStatus(state.inbound, chain);
    if (!s.open) return { ok: false, kind: 'halted', error: s.reason as string };
  }
  const qs = new URLSearchParams({ from_asset: req.from, to_asset: req.to, amount: req.amountIn.toString(), destination: req.destination });
  const raw = await thorGet(`/quote/swap?${qs.toString()}`);
  return parseQuote(raw, req, state.vaults, Math.floor(Date.now() / 1000));
}
