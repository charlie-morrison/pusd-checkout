"""End-to-end check of the merchant link generator and the payment card (live pools, live relay).

Usage: WC_TEST_SEED_HEX=<hex> python3 test/pay_e2e.py <page base url> <node binary> [--chromium PATH]
  e.g. python3 test/pay_e2e.py http://localhost:4317/pusd-checkout/ ~/bin/node

  GEN    chipnet: fill the generator (token address, 40 TEST, memo) -> the link keeps net=chipnet and carries
         to/usd/memo; opening it shows the payment card with a live quote.
  QUOTE  the page's total equals an independent quote (SDK computeOptimalBuy limited to one pool + 445 sat)
         computed by node right after, within 2% (pools move between the two reads).
  FUNDS  the seeded chipnet test wallet (20,000 sat) -> "enough" for 40 TEST and "short" for 900 TEST.
  BAD    a non-token address in the link -> the generator shows "not valid", no payment card.
  MAIN   mainnet link for 12.50 PUSD to the prize address -> quoted, total within 2% of node's quote.
Exit 0 = all pass, 1 = a case failed, 3 = harness error.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path
from urllib.parse import urlencode, urlparse, parse_qs
from playwright.sync_api import sync_playwright

base, node = sys.argv[1], sys.argv[2]
chromium = (sys.argv[sys.argv.index("--chromium") + 1] if "--chromium" in sys.argv else
            shutil.which("chromium") or shutil.which("chromium-browser"))
repo = Path(__file__).resolve().parent.parent
PRIZE_Z = "bitcoincash:zzmsqp8y48crckhv63y5mz9fek066xrufu9u9w59mp"
CHIP_Z = "bchtest:zzmsqp8y48crckhv63y5mz9fek066xrufupwpfkjua"  # same key hash, chipnet token-aware form
PRIZE_Q = "bitcoincash:qzmsqp8y48crckhv63y5mz9fek066xrufuzkks6ryj"
TOKENS = {"mainnet": "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544",
          "chipnet": "53636bc8c1afbe35a7ba169eadfac0aebadeacf96954a9a066a483e885580ed4"}
INDEXER = {"mainnet": "https://indexer.cauldron.quest", "chipnet": "https://indexer-chipnet.riften.net"}
res = {}

NODE_QUOTE = """
import { computeOptimalBuy } from '@mr-zwets/cauldron-swap-sdk';
const [indexer, token, units] = process.argv.slice(1);
const pools = (await (await fetch(`${indexer}/cauldron/pool/active?token=${token}`)).json()).active.filter((p) => p.token_id === token);
const a = computeOptimalBuy(pools, BigInt(units), 1n, 1);
console.log(String(a.reduce((s, x) => s + x.supplyAmount, 0n) + 445n));
"""


def node_quote(net, units):
    out = subprocess.run([node, "--input-type=module", "-e", NODE_QUOTE, INDEXER[net], TOKENS[net], str(units)],
                         cwd=repo, capture_output=True, text=True, timeout=60)
    return int(out.stdout.strip())


def wait_ds(pg, sel, wants, timeout_s):
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        el = pg.query_selector(sel)
        st = el and pg.eval_on_selector(sel, "e => e.dataset.state")
        if st in wants:
            return st
        pg.wait_for_timeout(400)
    el = pg.query_selector(sel)
    return el and pg.eval_on_selector(sel, "e => e.dataset.state")


def connect_seeded(pg):
    pg.click("#connect")
    pg.wait_for_selector("#wc-uri", timeout=20000)
    p = subprocess.Popen([node, "test/wc_fake_wallet.mjs", pg.input_value("#wc-uri"), "--seconds", "90", "--seed-from-env"],
                         cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=dict(os.environ))
    p.stdout.readline()
    ok = wait_ds(pg, "#wallet", {"connected"}, 45) == "connected" and wait_ds(pg, "#coins", {"done"}, 60) == "done"
    return p, ok


try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True, executable_path=chromium,
                               args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        pg = b.new_page()
        errs = []
        pg.on("console", lambda m: errs.append(m.text[:140]) if m.type == "error" else None)
        # GEN
        pg.goto(base + "?net=chipnet", wait_until="domcontentloaded", timeout=60000)
        pg.fill("#gen-to", CHIP_Z)
        pg.fill("#gen-usd", "40")
        pg.fill("#gen-memo", "Order 7")
        pg.click("#gen-form button[type=submit]")
        pg.wait_for_selector("#gen-link", timeout=5000)
        link = pg.input_value("#gen-link")
        qs = parse_qs(urlparse(link).query)
        res["GEN"] = {"link": link, "params_ok": qs.get("net") == ["chipnet"] and qs.get("to") == [CHIP_Z]
                      and qs.get("usd") == ["40"] and qs.get("memo") == ["Order 7"],
                      "qr": bool(pg.query_selector("#gen-out svg.qr"))}
        # open it, QUOTE + FUNDS enough
        pg.goto(link, wait_until="domcontentloaded")
        st = wait_ds(pg, "#payment", {"quoted", "no-liquidity", "error"}, 30)
        page_total = int(pg.eval_on_selector("#payment", "e => e.dataset.totalSats")) if st == "quoted" else None
        ref = node_quote("chipnet", 40)
        res["QUOTE"] = {"state": st, "page_total": page_total, "node_total": ref,
                        "memo": pg.inner_text("#pay-memo") if pg.query_selector("#pay-memo") else None,
                        "within_2pct": bool(page_total) and abs(page_total - ref) <= ref * 0.02}
        w, ok = connect_seeded(pg)
        pg.wait_for_timeout(800)
        res["FUNDS_enough"] = {"connected_and_scanned": ok, "funds": pg.eval_on_selector("#payment", "e => e.dataset.funds"),
                               "text": pg.inner_text("#pay-funds")}
        pg.screenshot(path=str(repo / "scratch" / "pay-chipnet-enough.png"), full_page=True)
        try:
            pg.click("#disconnect", timeout=3000)
        except Exception:
            pass
        pg.wait_for_timeout(2500)
        w.kill()
        # FUNDS short
        pg.goto(base + "?" + urlencode({"net": "chipnet", "to": CHIP_Z, "usd": "900"}), wait_until="domcontentloaded")
        st2 = wait_ds(pg, "#payment", {"quoted", "no-liquidity", "error"}, 30)
        w, ok = connect_seeded(pg)
        pg.wait_for_timeout(800)
        res["FUNDS_short"] = {"quote_state": st2, "connected_and_scanned": ok,
                              "funds": pg.eval_on_selector("#payment", "e => e.dataset.funds"), "text": pg.inner_text("#pay-funds")}
        try:
            pg.click("#disconnect", timeout=3000)
        except Exception:
            pass
        pg.wait_for_timeout(2500)
        w.kill()
        # BAD
        pg.goto(base + "?" + urlencode({"to": PRIZE_Q, "usd": "5"}), wait_until="domcontentloaded")
        pg.wait_for_selector("#generator", timeout=10000)
        res["BAD"] = {"error": pg.inner_text("#link-error") if pg.query_selector("#link-error") else None,
                      "no_payment_card": pg.query_selector("#payment") is None}
        # MAIN
        pg.goto(base + "?" + urlencode({"to": PRIZE_Z, "usd": "12.50", "memo": "Test order"}), wait_until="domcontentloaded")
        st3 = wait_ds(pg, "#payment", {"quoted", "no-liquidity", "error"}, 30)
        mt = int(pg.eval_on_selector("#payment", "e => e.dataset.totalSats")) if st3 == "quoted" else None
        mref = node_quote("mainnet", 1250)
        res["MAIN"] = {"state": st3, "page_total": mt, "node_total": mref, "within_2pct": bool(mt) and abs(mt - mref) <= mref * 0.02}
        pg.screenshot(path=str(repo / "scratch" / "pay-mainnet.png"), full_page=True)
        res["console_errors"] = errs
        b.close()
except Exception as e:
    res["harness_error"] = str(e)[:300]
    print(json.dumps(res, indent=1))
    sys.exit(3)

res["pass"] = {
    "GEN": res["GEN"]["params_ok"] and res["GEN"]["qr"],
    "QUOTE": res["QUOTE"]["within_2pct"] and res["QUOTE"]["memo"] == "Memo: Order 7",
    "FUNDS": res["FUNDS_enough"]["connected_and_scanned"] and res["FUNDS_enough"]["funds"] == "enough"
             and res["FUNDS_short"]["connected_and_scanned"] and res["FUNDS_short"]["funds"] == "short",
    "BAD": bool(res["BAD"]["error"]) and "cannot receive tokens" in res["BAD"]["error"] and res["BAD"]["no_payment_card"],
    "MAIN": res["MAIN"]["within_2pct"],
}
print(json.dumps(res, indent=1))
sys.exit(0 if all(res["pass"].values()) else 1)
