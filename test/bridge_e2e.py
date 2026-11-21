"""End-to-end check of the bridge quote card (live THORChain, live Cauldron pools). Quotes only, nothing sent.

Usage: python3 test/bridge_e2e.py <page base url> [--chromium PATH]
  STATUS  the page's THORChain line matches an independent read of inbound_addresses (BCH, BSC, BASE).
  OUT     PUSD -> USDT on BSC, 5 USD to a burn address: quoted; the memo pays exactly that address; the page's
          output equals an independent THORChain quote for the same BCH amount within 1%.
  IN      USDT on BSC -> PUSD, 5 USD to the prize key: quoted; memo `=:c:<q without prefix>`; output within 1%.
  CLOSED  a chain THORChain reports closed shows the reason and no quote (if every chain is open: the
          same chain must quote instead, so the case still checks the page against THORChain).
  BAD     a short 0x address and a chipnet BCH address are refused with no quote.
  CHIP    on ?net=chipnet the card says the bridge is mainnet only.
Exit 0 = all pass, 1 = a case failed, 3 = harness error.
"""
import json, shutil, sys, urllib.request
from urllib.parse import urlencode
from playwright.sync_api import sync_playwright

base = sys.argv[1]


def limited(memo, head):
    """memo == head + ':' + a positive integer limit (rule 14)."""
    if not isinstance(memo, str) or not memo.startswith(head + ":"):
        return False
    lim = memo[len(head) + 1:]
    return lim.isdigit() and int(lim) > 0
chromium = (sys.argv[sys.argv.index("--chromium") + 1] if "--chromium" in sys.argv else
            shutil.which("chromium") or shutil.which("chromium-browser"))
THOR = "https://gateway.liquify.com/chain/thorchain_api/thorchain"
USDT = "BSC.USDT-0X55D398326F99059FF775485246999027B3197955"
USDC = "BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913"
DEAD = "0x000000000000000000000000000000000000dEaD"
PRIZE_Z = "bitcoincash:zzmsqp8y48crckhv63y5mz9fek066xrufu9u9w59mp"
PRIZE_Q_BARE = "qzmsqp8y48crckhv63y5mz9fek066xrufuzkks6ryj"
CHIP_Q = "bchtest:qzmsqp8y48crckhv63y5mz9fek066xrufuxyjhc5rw"  # same key, chipnet form (libauth)
res, console_errors = {}, []


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.load(e)


def thor_open(ib, chain):
    c = next((x for x in ib if x["chain"] == chain), None)
    return bool(c) and not (c["halted"] or c["global_trading_paused"] or c["chain_trading_paused"])


def quote(page, direction, chain, usd, dest):
    page.check(f"#dir-{direction}")
    page.select_option("#br-chain", chain)
    page.fill("#br-usd", usd)
    page.fill("#br-dest", dest)
    page.click("#br-go")
    page.wait_for_function("() => !['quoting','idle'].includes(document.querySelector('#bridge').dataset.state)", timeout=60000)
    return page.eval_on_selector("#bridge", "b => ({...b.dataset, text: document.querySelector('#bridge-quote').innerText})")


def close(a, b, tol=0.01):
    return a > 0 and b > 0 and abs(a - b) / b <= tol


try:
    with sync_playwright() as p:
        br = p.chromium.launch(executable_path=chromium, headless=True, args=["--use-gl=angle", "--use-angle=swiftshader"])
        page = br.new_page(viewport={"width": 1000, "height": 1400})
        page.on("console", lambda m: m.type == "error" and console_errors.append(m.text[:200]))
        page.goto(base, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_function("() => /THORChain right now/.test(document.querySelector('#thor-status')?.textContent || '')", timeout=60000)
        line = page.inner_text("#thor-status")
        ib = get(f"{THOR}/inbound_addresses")
        want = {c: thor_open(ib, c) for c in ("BCH", "BSC", "BASE")}
        got = {c: (f"{c} open" in line) for c in want}
        res["STATUS"] = {"pass": got == want, "page": line, "thorchain": want}

        d = quote(page, "out", "BSC", "5", DEAD)
        # rule 14 (20.11): the memo carries a price limit, "=:BSC.USDT:<addr>:<min out>"; a memo without one is a FAIL
        ok = d.get("state") == "quoted" and limited(d.get("memo"), f"=:BSC.USDT:{DEAD}")
        ind = get(f"{THOR}/quote/swap?" + urlencode({"from_asset": "BCH.BCH", "to_asset": USDT, "amount": d.get("amountIn", "0"), "destination": DEAD}))
        ok = ok and close(int(d.get("expectedOut", 0)), int(ind.get("expected_amount_out", 0)))
        res["OUT"] = {"pass": ok, "page_out": d.get("expectedOut"), "independent_out": ind.get("expected_amount_out"), "amount_in_sats": d.get("amountIn"), "memo": d.get("memo"), "text": d.get("text", "")[:900]}
        page.screenshot(path="/tmp/exp2_thor/bridge-out.png", full_page=True)

        d = quote(page, "in", "BSC", "5", PRIZE_Z)
        ok = d.get("state") == "quoted" and limited(d.get("memo"), f"=:c:{PRIZE_Q_BARE}") and d.get("amountIn") == "500000000"
        ind = get(f"{THOR}/quote/swap?" + urlencode({"from_asset": USDT, "to_asset": "BCH.BCH", "amount": "500000000", "destination": PRIZE_Q_BARE}))
        ok = ok and close(int(d.get("expectedOut", 0)), int(ind.get("expected_amount_out", 0)))
        res["IN"] = {"pass": ok, "page_out": d.get("expectedOut"), "independent_out": ind.get("expected_amount_out"), "memo": d.get("memo"), "text": d.get("text", "")[:900]}
        page.screenshot(path="/tmp/exp2_thor/bridge-in.png", full_page=True)

        closed = [c for c in ("BASE", "BSC") if not want[c]]
        chain = closed[0] if closed else "BASE"
        d = quote(page, "out", chain, "5", DEAD)
        if closed:
            ok = d.get("state") == "thor-halted" and ("halted" in d.get("text", "") or "paused" in d.get("text", ""))
        else:
            ok = d.get("state") == "quoted"
        res["CLOSED"] = {"pass": ok, "chain": chain, "thorchain_says_closed": bool(closed), "state": d.get("state"), "text": d.get("text", "")[:300]}
        page.screenshot(path="/tmp/exp2_thor/bridge-closed.png", full_page=True)

        a = quote(page, "out", "BSC", "5", "0x1234")
        b = quote(page, "in", "BSC", "5", CHIP_Q)
        res["BAD"] = {"pass": a.get("state") == "error" and b.get("state") == "error" and "mainnet" in b.get("text", ""),
                      "short_evm": a.get("text", "")[:120], "chipnet_bch": b.get("text", "")[:120]}

        sep = "&" if "?" in base else "?"
        page.goto(base + sep + "net=chipnet", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("#bridge[data-state='mainnet-only']", timeout=30000)
        res["CHIP"] = {"pass": "mainnet only" in page.inner_text("#bridge")}
        br.close()
except Exception as e:  # harness error, not a verdict
    print(json.dumps({"harness_error": str(e)[:400], "partial": res}, indent=1))
    sys.exit(3)

res["console_errors"] = console_errors
fails = [k for k, v in res.items() if isinstance(v, dict) and not v.get("pass")]
print(json.dumps(res, indent=1, ensure_ascii=False))
print(f"{len([k for k in res if k != 'console_errors']) - len(fails)}/{len(res) - 1} PASS" + (f"; FAIL: {fails}" if fails else ""))
sys.exit(1 if fails else 0)
