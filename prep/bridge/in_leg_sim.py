#!/usr/bin/env python3
"""Simulate the bridge IN leg's EVM side (BSC.USDT -> THORChain router) with eth_call. Signs nothing.

What it proves: our `depositWithExpiry(vault, USDT, amount, memo, expiry)` call, built from a live THORChain
quote, succeeds against the live router on BSC. The caller is a dummy address whose USDT balance and router
allowance are set by a state override, so no real wallet and no real token are involved.

Steps: live quote (liquify) + vault cross-check on a second thornode; router bytecode has the selector;
find the USDT balance slot (eth_getStorageAt vs balanceOf); prove the allowance slot (allowance() under an
override returns the value); simulate the deposit; three controls that must revert; eth_estimateGas.

rc 0 = deposit call succeeds and all controls revert; rc 2 = quote/vault/router guard failed;
rc 3 = storage slots not found; rc 4 = the deposit call reverted; rc 5 = a control did NOT revert.
Usage: python3 in_leg_sim.py [--usdt 4] [--dest <BCH q-address without prefix>] [--out <json>]
"""
import argparse, json, sys, time
from urllib.request import Request, urlopen

THOR_A = "https://gateway.liquify.com/chain/thorchain_api/thorchain"
THOR_B = "https://thorchain-thornode-lb-1.thorwallet.org/thorchain"
RPCS = ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org"]
USDT = "0x55d398326f99059ff775485246999027b3197955"   # BSC-USD (18 decimals)
ASSET = "BSC.USDT-0X55D398326F99059FF775485246999027B3197955"
DUMMY = "0x00000000000000000000000000000000000e2e02"  # no key exists; only used inside eth_call


def get(url):
    with urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as r:
        return json.loads(r.read())


def rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = Request(url, data=body, headers={"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"})
    with urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--usdt", default="4")
    ap.add_argument("--dest", required=True, help="BCH cashaddr WITHOUT the bitcoincash: prefix")
    ap.add_argument("--out")
    a = ap.parse_args()
    if a.dest.startswith("bitcoincash:"):
        print("dest must not carry the bitcoincash: prefix (THORChain memo splits on ':')", file=sys.stderr)
        return 2
    from web3 import Web3
    from eth_abi import encode

    k = Web3.keccak
    res = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "usdt": a.usdt, "dest": a.dest}
    amount_1e8 = int(float(a.usdt) * 10**8)
    amount_wei = int(float(a.usdt) * 10**18)

    q = get(f"{THOR_A}/quote/swap?from_asset={ASSET}&to_asset=BCH.BCH&amount={amount_1e8}&destination={a.dest}")
    vault, router, memo, expiry = q["inbound_address"].lower(), q["router"].lower(), q["memo"], int(q["expiry"])
    res["quote"] = {k2: q.get(k2) for k2 in ("expected_amount_out", "memo", "inbound_address", "router",
                                             "recommended_min_amount_in", "expiry")}
    res["quote"]["fees"] = q.get("fees")
    # THORChain runs several asgard vaults; inbound_addresses hands out a different ActiveVault per call
    # (measured 12.11: 0x0d15… in the quote, 0x5164… a minute later, same 6 vaults on both nodes).
    # So the guard is "quoted vault is an ActiveVault on BOTH nodes", not "both nodes return the same one".
    def active_bsc(base):
        return {a["address"].lower() for v in get(f"{base}/vaults/asgard") if v.get("status") == "ActiveVault"
                for a in v.get("addresses", []) if a.get("chain") == "BSC"}
    act_a, act_b = active_bsc(THOR_A), active_bsc(THOR_B)
    ib = [x for x in get(f"{THOR_B}/inbound_addresses") if x.get("chain") == "BSC"][0]
    res["vault_cross_check"] = {"quoted_vault_active_on_liquify": vault in act_a,
                                "quoted_vault_active_on_thorwallet": vault in act_b,
                                "active_vaults_liquify": len(act_a), "active_vaults_thorwallet": len(act_b),
                                "thorwallet_router": ib.get("router"), "halted": ib.get("halted"),
                                "chain_trading_paused": ib.get("chain_trading_paused")}
    if (vault not in act_a or vault not in act_b or (ib.get("router") or "").lower() != router
            or ib.get("halted") or ib.get("chain_trading_paused")):
        print(json.dumps(res, indent=1)); print("vault not active on both nodes, router differs, or halted",
                                               file=sys.stderr); return 2
    if f":{a.dest}" not in memo or not memo.startswith("=:"):
        print(json.dumps(res, indent=1)); print("memo does not carry our destination", file=sys.stderr); return 2

    url = RPCS[0]
    sel = k(text="depositWithExpiry(address,address,uint256,string,uint256)")[:4]
    code = rpc(url, "eth_getCode", [router, "latest"])["result"]
    res["router_has_selector"] = sel.hex().replace("0x", "") in code
    if not res["router_has_selector"]:
        print(json.dumps(res, indent=1)); return 2

    def pad(x):
        return bytes.fromhex(x[2:].rjust(64, "0")) if isinstance(x, str) else x.to_bytes(32, "big")

    # balances slot: compare storage with balanceOf for an address that holds USDT (the router itself)
    holder = router
    bal_hex = rpc(url, "eth_call", [{"to": USDT, "data": "0x70a08231" + pad(holder).hex()}, "latest"])["result"]
    bal_slot = None
    for s in range(0, 12):
        key = "0x" + k(pad(holder) + pad(s)).hex().replace("0x", "")
        v = rpc(url, "eth_getStorageAt", [USDT, key, "latest"])["result"]
        if int(v, 16) == int(bal_hex, 16) and int(v, 16) > 0:
            bal_slot = s
            break
    res["usdt_balance_slot"] = bal_slot
    if bal_slot is None:
        print(json.dumps(res, indent=1)); return 3

    def bal_key(owner):
        return "0x" + k(pad(owner) + pad(bal_slot)).hex().replace("0x", "")

    def alw_key(owner, spender, slot):
        inner = k(pad(owner) + pad(slot))
        return "0x" + k(pad(spender) + bytes(inner)).hex().replace("0x", "")

    val = "0x" + amount_wei.to_bytes(32, "big").hex()
    alw_slot = None
    for s in range(0, 12):
        ov = {USDT: {"stateDiff": {alw_key(DUMMY, router, s): val}}}
        r = rpc(url, "eth_call", [{"to": USDT, "data": "0xdd62ed3e" + pad(DUMMY).hex() + pad(router).hex()},
                                  "latest", ov])
        if "result" in r and int(r["result"], 16) == amount_wei:
            alw_slot = s
            break
    res["usdt_allowance_slot"] = alw_slot
    if alw_slot is None:
        print(json.dumps(res, indent=1)); return 3

    def call(amount, mem, exp, with_allowance=True, balance=amount_wei):
        diff = {bal_key(DUMMY): "0x" + balance.to_bytes(32, "big").hex()}
        if with_allowance:
            diff[alw_key(DUMMY, router, alw_slot)] = val
        data = "0x" + sel.hex().replace("0x", "") + encode(
            ["address", "address", "uint256", "string", "uint256"],
            [Web3.to_checksum_address(vault), Web3.to_checksum_address(USDT), amount, mem, exp]).hex()
        tx = {"from": DUMMY, "to": router, "data": data}
        ov = {USDT: {"stateDiff": diff}}
        r = rpc(url, "eth_call", [tx, "latest", ov])
        return r, tx, ov

    r, tx, ov = call(amount_wei, memo, expiry)
    res["deposit_call"] = r
    res["deposit_calldata_len"] = len(tx["data"]) // 2 - 1
    ok = "result" in r and "error" not in r
    g = rpc(url, "eth_estimateGas", [tx, "latest", ov])
    res["deposit_estimate_gas"] = int(g["result"], 16) if "result" in g else g.get("error")
    ga = rpc(url, "eth_estimateGas", [{"from": DUMMY, "to": USDT, "data": "0x095ea7b3" + pad(router).hex() + val[2:]}])
    res["approve_estimate_gas"] = int(ga["result"], 16) if "result" in ga else ga.get("error")

    controls = {
        "no_allowance": call(amount_wei, memo, expiry, with_allowance=False)[0],
        "expired": call(amount_wei, memo, int(time.time()) - 600)[0],
        "amount_over_balance": call(amount_wei * 2, memo, expiry)[0],
    }
    res["controls"] = controls
    reverted = {n: ("error" in c) for n, c in controls.items()}
    res["controls_reverted"] = reverted
    res["verdict"] = "PASS" if ok and all(reverted.values()) else ("DEPOSIT_REVERTED" if not ok else "CONTROL_PASSED")
    out = json.dumps(res, indent=1, ensure_ascii=False)
    if a.out:
        open(a.out, "w").write(out + "\n")
    print(out)
    if not ok:
        return 4
    if not all(reverted.values()):
        return 5
    return 0


if __name__ == "__main__":
    sys.exit(main())
