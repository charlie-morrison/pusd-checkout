"""End-to-end check of the Pay button (17.11): page -> live WizardConnect relay -> test wallet that signs
-> page checks the signed tx (build rule 4) -> page sends it -> an independent Fulcrum read on chipnet.

Usage: WC_TEST_SEED_HEX=<hex> python3 test/pay_wc_e2e.py <page url with ?net=chipnet&to=..&usd=..> <node binary>
         --units N [--chromium PATH] [--only CTRL|PAY]

  CTRL  the test wallet signs, then takes 1,000 sat off the last output (a wallet that changes what the buyer
        saw). The page must say "Not sent", and the txid the wallet signed must NOT be on chipnet.
  PAY   the same wallet signs honestly. The page must show "Paid" with a txid equal to the one the wallet
        signed, and chipnet must have that tx with exactly N token units on the merchant's address.
Exit 0 = all pass, 1 = a case failed, 3 = harness error.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

page_url, node = sys.argv[1], sys.argv[2]
arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
chromium = arg("--chromium") or shutil.which("chromium") or shutil.which("chromium-browser")
units = arg("--units")
only = arg("--only")
repo = Path(__file__).resolve().parent.parent
merchant = parse_qs(urlparse(page_url).query)["to"][0]
CAT = "53636bc8c1afbe35a7ba169eadfac0aebadeacf96954a9a066a483e885580ed4"  # chipnet TEST token (config.ts)
res = {"url": page_url, "units": units, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def lookup(txid):
    out = subprocess.run([node, "test/tx_lookup.mjs", "chipnet", txid, merchant, CAT], cwd=repo, capture_output=True, text=True, timeout=90)
    return json.loads(out.stdout.strip().splitlines()[-1])


def wait_state(pg, sel, wants, timeout_s):
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        st = pg.eval_on_selector(sel, "e => e.dataset.state") if pg.query_selector(sel) else None
        if st in wants:
            return st, round(time.time() - t0, 1)
        pg.wait_for_timeout(500)
    return (pg.eval_on_selector(sel, "e => e.dataset.state") if pg.query_selector(sel) else None), None


def run(b, mode, shot):
    pg = b.new_page()
    errs = []
    pg.on("console", lambda m: errs.append(m.text[:160]) if m.type == "error" else None)
    pg.goto(page_url, wait_until="domcontentloaded", timeout=60000)
    o = {}
    st, _ = wait_state(pg, "#payment", {"quoted"}, 60)
    o["quote_state"] = st
    pg.click("#connect")
    pg.wait_for_selector("#wc-uri", timeout=20000)
    uri = pg.input_value("#wc-uri")
    w = subprocess.Popen([node, "test/wc_fake_wallet.mjs", uri, "--seconds", "240", "--seed-from-env", mode],
                         cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=dict(os.environ))
    lines = []
    st, secs = wait_state(pg, "#wallet", {"connected"}, 45)
    o["connected"] = {"state": st, "seconds": secs}
    cs, _ = wait_state(pg, "#coins", {"done", "error"}, 90)
    o["scan"] = {"state": cs, "sats": pg.eval_on_selector("#coins", "e => e.dataset.sats") if cs == "done" else None}
    pg.wait_for_function("() => !document.querySelector('#pay-go').disabled", timeout=60000)
    o["need_sats"] = pg.eval_on_selector("#payment", "e => e.dataset.totalSats")
    pg.click("#pay-go")
    ENDS = {"paid", "refused", "rejected", "send-error", "build-error", "price-up", "gone", "error"}
    final, psecs = wait_state(pg, "#payment", ENDS, 120)
    if final == "price-up":  # the page showed the new price; a buyer who accepts it presses Pay again
        o["price_up"] = {"message": pg.inner_text("#pay-result")[:300], "new_total": pg.eval_on_selector("#payment", "e => e.dataset.totalSats")}
        o["need_sats"] = o["price_up"]["new_total"]
        pg.wait_for_function("() => !document.querySelector('#pay-go').disabled", timeout=30000)
        pg.click("#pay-go")
        final, psecs = wait_state(pg, "#payment", ENDS - {"price-up"} | {"price-up-again"}, 120)
    o["pay"] = {"state": final, "seconds": psecs, "message": pg.inner_text("#pay-result")[:400],
                "page_txid": pg.eval_on_selector("#payment", "e => e.dataset.txid || null"),
                "buyer_pays": pg.eval_on_selector("#payment", "e => e.dataset.buyerPays || null")}
    pg.wait_for_timeout(1500)
    pg.screenshot(path=str(repo / "scratch" / shot), full_page=True)
    try:
        pg.click("#disconnect", timeout=3000)
    except Exception:
        pass
    pg.wait_for_timeout(2500)
    w.kill()
    lines = [json.loads(l) for l in w.stdout.read().splitlines() if l.strip().startswith("{")]
    signed = [l["signed"] for l in lines if "signed" in l]
    o["wallet_signed"] = signed[0] if signed else None
    o["wallet_sign_error"] = next((l["sign_error"] for l in lines if "sign_error" in l), None)
    o["console_errors"] = errs
    pg.close()
    return o


try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True, executable_path=chromium,
                               args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        if only in (None, "CTRL"):
            res["CTRL"] = run(b, "--sign-tamper-output", "pay-wc-ctrl-chipnet.png")
        if only in (None, "PAY"):
            res["PAY"] = run(b, "--sign", "pay-wc-pay-chipnet.png")
        b.close()
except Exception as e:
    res["harness_error"] = str(e)[:300]
    print(json.dumps(res, indent=1))
    sys.exit(3)

res["pass"] = {}
if "CTRL" in res:
    c = res["CTRL"]
    t = (c.get("wallet_signed") or {}).get("txid")
    c["chain"] = lookup(t) if t else None
    res["pass"]["CTRL"] = bool(t) and c["pay"]["state"] == "refused" and "Not sent" in c["pay"]["message"] \
        and c["chain"] is not None and c["chain"].get("found") is False and not c["pay"]["page_txid"]
if "PAY" in res:
    p = res["PAY"]
    t = (p.get("wallet_signed") or {}).get("txid")
    p["chain"] = None
    for _ in range(6):
        p["chain"] = lookup(t) if t else None
        if p["chain"] and p["chain"].get("found"):
            break
        time.sleep(5)
    got = sum(int(x["units"]) for x in (p["chain"] or {}).get("to_address", []))
    p["merchant_units_on_chain"] = got
    res["pass"]["PAY"] = bool(t) and p["pay"]["state"] == "paid" and p["pay"]["page_txid"] == t \
        and (p["chain"] or {}).get("found") is True and str(got) == str(units) \
        and (p["wallet_signed"] or {}).get("broadcast_flag") is False and (p["wallet_signed"] or {}).get("wire_form") == "string"
    # The card's "You pay about" must be the wallet's real cost, up to what the page says can change before
    # signing: the fee of extra buyer inputs and a pool price rise within the 0.5% re-quote tolerance (rule 5).
    # (First version, 17.11 run 3, allowed only the inputs + 20 sat and failed on a 22 sat move of the live
    # pool after our own previous trade, which the stated tolerance covers.)
    shown_pool = int(p.get("need_sats") or 0) - 1000 - 445
    extra = 148 * max(0, ((p["chain"] or {}).get("inputs") or 2) - 2) + (shown_pool * 5 + 999) // 1000 + 20
    # No change output = the change was below 546 sat and went to the miners (paytx, disclosed in the signing
    # line since 17.11 run 5, where 485 sat went that way and the card had not said so).
    if ((p["chain"] or {}).get("outputs") or 3) == 2:
        extra += 545
    d = int(p["pay"]["buyer_pays"] or 0) - int(p.get("need_sats") or 0)
    p["shown_vs_wallet"] = {"shown": p.get("need_sats"), "wallet": p["pay"]["buyer_pays"], "diff": d, "allowed": extra}
    res["pass"]["QUOTE_HONEST"] = 0 <= d <= extra
print(json.dumps(res, indent=1))
sys.exit(0 if res["pass"] and all(res["pass"].values()) else 1)
