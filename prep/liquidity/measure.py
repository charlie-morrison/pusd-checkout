#!/usr/bin/env python3
"""PUSD liquidity check on Cauldron DEX (BCH BLAZE checkout prep, gate before the 14.11 fork).

Question: can a buyer's BCH become exactly N PUSD for the merchant inside ONE transaction,
at demo size ($1-$20), at an acceptable cost?

Read-only. Pool math mirrors mr-zwets/Cauldron-Swap-SDK src/multipool.ts (calcBuyFromPool,
0.3% fee as ceil(3*trade/997)) and src/fees.ts (byte budget: 300 overhead + 200 per pool +
141 per signed P2PKH input). Best SINGLE pool only = an upper bound on cost; the SDK's
multi-pool split (sdk_crosscheck.mjs, computeOptimalBuy) can only be cheaper. Cross-checked
04.11: $1/$5/$10 pool sats identical to the SDK.

Usage: measure.py <pools.json> <bch_usd> [--json]
rc 0 = workable at every demo size, 4 = not workable at some demo size, 3 = blind (bad input).
"""
import json
import math
import sys

PUSD = "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544"
DECIMALS = 2                       # BCMR (bcmr.paytaca.com), measured 04.11
DEMO_USD = [1, 5, 10, 20]          # demo sizes the gate is about
EXTRA_USD = [50, 100, 500, 1000]   # context only
FEE_RATE = 1.2                     # sats/byte, SDK default
WORKABLE_MAX_COST_PCT = 3.0        # buyer overpay vs the $1 peg, incl. pool fee + miner fee
PEG_TOLERANCE = 0.03               # median pool price must sit within 3% of $1


def ceil_div(a, b):
    return -(-a // b)


def buy_from_pool(sats, tokens, demand):
    """Sats the buyer supplies (incl. 0.3% LP fee) to take `demand` token units out of one pool."""
    if demand <= 0:
        return 0, 0
    k = sats * tokens
    new_tokens = tokens - demand
    if new_tokens <= 0:
        raise ValueError("demand exceeds pool")
    trade = ceil_div(k, new_tokens) - sats
    fee = ceil_div(trade * 3, 997)
    return trade + fee, fee


def single_best(pools, target):
    best = None
    for p in pools:
        if p["tokens"] - 1 < target:
            continue
        c, f = buy_from_pool(p["sats"], p["tokens"], target)
        if best is None or c < best["sats"]:
            best = {"sats": c, "lp_fee_sats": f, "pools_used": 1, "pool_id": p["pool_id"]}
    return best


def miner_fee(pools_used, user_inputs=1):
    size = 300 + 200 * pools_used + 141 * user_inputs
    return math.ceil(size * FEE_RATE), size


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 3
    raw = json.load(open(sys.argv[1]))
    bch_usd = float(sys.argv[2])
    pools = [p for p in raw.get("active", []) if p.get("token_id") == PUSD]
    if not pools or bch_usd <= 0:
        print("BLIND: no PUSD pools or no BCH price", file=sys.stderr)
        return 3
    unit = 10 ** DECIMALS
    usd_per_sat = bch_usd / 1e8
    tot_tokens = sum(p["tokens"] for p in pools)
    tot_sats = sum(p["sats"] for p in pools)
    spots = sorted(p["sats"] / p["tokens"] for p in pools)  # sats per token base unit
    best_spot = spots[0]
    out = {
        "pools": len(pools),
        "pusd_in_pools": tot_tokens / unit,
        "bch_in_pools": tot_sats / 1e8,
        "tvl_usd": round(tot_tokens / unit + tot_sats * usd_per_sat, 2),
        "bch_usd": bch_usd,
        "best_spot_usd_per_pusd": round(best_spot * unit * usd_per_sat, 4),
        "median_spot_usd_per_pusd": round(spots[len(spots) // 2] * unit * usd_per_sat, 4),
        "worst_spot_usd_per_pusd": round(spots[-1] * unit * usd_per_sat, 4),
        "largest_pool_pusd": max(p["tokens"] for p in pools) / unit,
        "sizes": [],
    }
    workable = True
    for usd in DEMO_USD + EXTRA_USD:
        target = usd * unit
        sb = single_best(pools, target)
        row = {"usd": usd, "demo": usd in DEMO_USD}
        for name, r in (("single", sb),):
            if r is None:
                row[name] = None
                continue
            mf, size = miner_fee(r["pools_used"])
            cost_usd = (r["sats"] + mf) * usd_per_sat
            row[name] = {
                "pools_used": r["pools_used"],
                "buyer_pays_sats": r["sats"] + mf,
                "lp_fee_sats": r["lp_fee_sats"],
                "miner_fee_sats": mf,
                "tx_bytes_est": size,
                "buyer_pays_usd": round(cost_usd, 4),
                "overpay_vs_peg_pct": round((cost_usd / usd - 1) * 100, 3),
                "impact_vs_best_spot_pct": round((r["sats"] / (target * best_spot) - 1) * 100, 3),
            }
        cands = [row[n] for n in ("single",) if row.get(n)]
        row["best"] = min(cands, key=lambda c: c["buyer_pays_sats"]) if cands else None
        if usd in DEMO_USD and (row["best"] is None or row["best"]["overpay_vs_peg_pct"] > WORKABLE_MAX_COST_PCT):
            workable = False
        out["sizes"].append(row)
    # a cheap fill is not good news if the median pool is far off $1: either the BCH price input is
    # wrong or PUSD has depegged; both make every number above meaningless (control 04.11: BCH=$200 passed)
    med = out["median_spot_usd_per_pusd"]
    out["peg_ok"] = abs(med - 1) <= PEG_TOLERANCE
    if not out["peg_ok"]:
        workable = False
        print(f"PEG/PRICE MISMATCH: median pool ${med}/PUSD vs $1 (tolerance {PEG_TOLERANCE:.0%})", file=sys.stderr)
    out["workable_at_demo_sizes"] = workable
    out["threshold_overpay_pct"] = WORKABLE_MAX_COST_PCT
    if "--json" in sys.argv:
        print(json.dumps(out, indent=1))
    else:
        print(f"pools {out['pools']}  PUSD in pools {out['pusd_in_pools']:.2f}  BCH {out['bch_in_pools']:.4f}  TVL ${out['tvl_usd']}")
        print(f"spot $/PUSD best {out['best_spot_usd_per_pusd']} median {out['median_spot_usd_per_pusd']} worst {out['worst_spot_usd_per_pusd']}  largest pool {out['largest_pool_pusd']} PUSD")
        for r in out["sizes"]:
            b = r["best"]
            if b is None:
                print(f"${r['usd']:>5}: NO LIQUIDITY")
                continue
            print(f"${r['usd']:>5}: pays ${b['buyer_pays_usd']:.4f} (overpay {b['overpay_vs_peg_pct']:+.3f}% vs peg, impact {b['impact_vs_best_spot_pct']:.3f}%), pools {b['pools_used']}, ~{b['tx_bytes_est']} B, miner {b['miner_fee_sats']} sat")
        print("WORKABLE" if workable else "NOT WORKABLE", f"(threshold {WORKABLE_MAX_COST_PCT}% overpay at $1-$20)")
    return 0 if workable else 4


if __name__ == "__main__":
    sys.exit(main())
