"""End-to-end check of the page's WizardConnect connect flow over the live public relay.

Usage: python3 test/wc_connect_e2e.py <page url> <node binary> [--chromium PATH]
  e.g. python3 test/wc_connect_e2e.py http://localhost:4317/pusd-checkout/?net=chipnet ~/bin/node

Cases:
  A good wallet   -> page reaches data-state=connected and shows exactly the wallet's receive/0 address
                     (bchtest: prefix on chipnet); Disconnect returns the page to idle.
  B wrong secret  -> the page must NOT show connected within the window (build rule 2).
Exit 0 = both pass, 1 = a case failed, 3 = harness error.
"""
import json, shutil, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

page_url, node = sys.argv[1], sys.argv[2]
chromium = sys.argv[sys.argv.index("--chromium") + 1] if "--chromium" in sys.argv else (
    shutil.which("chromium") or shutil.which("chromium-browser"))
repo = Path(__file__).resolve().parent.parent
wallet_js = repo / "test" / "wc_fake_wallet.mjs"
net = "chipnet" if "net=chipnet" in page_url else "mainnet"
res = {"url": page_url, "net": net}


def start_wallet(uri, tamper, seconds):
    cmd = [node, str(wallet_js), uri, "--seconds", str(seconds)] + (["--tamper-secret"] if tamper else [])
    p = subprocess.Popen(cmd, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    first = json.loads(p.stdout.readline())
    return p, first


def wait_state(pg, want, timeout_s):
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        st = pg.eval_on_selector("#wallet", "e => e.dataset.state")
        if st == want:
            return st, round(time.time() - t0, 1)
        pg.wait_for_timeout(500)
    return pg.eval_on_selector("#wallet", "e => e.dataset.state"), None


try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True, executable_path=chromium,
                               args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        # Case A: good wallet
        pg = b.new_page()
        errs = []
        pg.on("console", lambda m: errs.append(m.text[:160]) if m.type == "error" else None)
        pg.goto(page_url, wait_until="domcontentloaded", timeout=60000)
        pg.click("#connect")
        pg.wait_for_selector("#wc-uri", timeout=20000)
        uri = pg.input_value("#wc-uri")
        res["uri_prefix"] = uri[:9]
        w, first = start_wallet(uri, False, 50)
        st, secs = wait_state(pg, "connected", 45)
        shown = pg.inner_text("#wc-address") if st == "connected" else None
        name = pg.inner_text("#wc-name") if st == "connected" else None
        pg.screenshot(path=str(repo / "scratch" / f"wc-connected-{net}.png"), full_page=True)
        res["A"] = {"state": st, "seconds": secs, "shown": shown, "expected": first["expected"][net], "name": name}
        res["A"]["pass_connect"] = st == "connected" and shown == first["expected"][net]
        if st == "connected":
            pg.click("#disconnect")
            st2, _ = wait_state(pg, "idle", 10)
            res["A"]["after_disconnect"] = st2
            res["A"]["pass_disconnect"] = st2 == "idle"
        else:
            res["A"]["pass_disconnect"] = False
        w.kill()
        res["A"]["console_errors"] = errs[:5]
        pg.close()

        # Case B: wallet with a wrong pairing secret
        pg = b.new_page()
        pg.goto(page_url, wait_until="domcontentloaded", timeout=60000)
        pg.click("#connect")
        pg.wait_for_selector("#wc-uri", timeout=20000)
        uri = pg.input_value("#wc-uri")
        w, first = start_wallet(uri, True, 40)
        st, secs = wait_state(pg, "connected", 30)
        res["B"] = {"state_after_30s": st, "reached_connected_after": secs, "pass": st != "connected"}
        w.kill()
        pg.close()
        b.close()
except Exception as e:  # harness problem, not a verdict
    res["harness_error"] = str(e)[:300]
    print(json.dumps(res, indent=1))
    sys.exit(3)

print(json.dumps(res, indent=1))
ok = res["A"]["pass_connect"] and res["A"]["pass_disconnect"] and res["B"]["pass"]
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
