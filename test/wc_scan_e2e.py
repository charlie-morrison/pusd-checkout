"""End-to-end check of the QR code and the wallet coin scan (build rule 8), over the live relay and
live chipnet Fulcrum.

Usage: WC_TEST_SEED_HEX=<hex> python3 test/wc_scan_e2e.py <page url> <node binary> --jsqr <jsQR.js>
         --expect-sats N --expect-paths receive/3,change/2 [--chromium PATH]

  QR    the QR the page draws is rasterised in the browser and decoded with jsQR; the decoded text
        must equal the relay's qrUri (upper-case, alphanumeric set) and decode to the same keys as the
        paste link. The test wallet then connects with the DECODED text, i.e. as a phone that scanned it.
  SCAN  the seeded test wallet (coins on receive/3 and change/2, none on receive/0) -> the page must find
        exactly N sat on exactly those paths.
  CTRL  a fresh random wallet (no coins) -> the page must report 0 sat.
Exit 0 = all pass, 1 = a case failed, 3 = harness error.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

page_url, node = sys.argv[1], sys.argv[2]
arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
chromium = arg("--chromium") or shutil.which("chromium") or shutil.which("chromium-browser")
jsqr = arg("--jsqr")
expect_sats = int(arg("--expect-sats"))
expect_paths = sorted(p for p in arg("--expect-paths", "").split(",") if p)
repo = Path(__file__).resolve().parent.parent
wallet_js = repo / "test" / "wc_fake_wallet.mjs"
net = "chipnet" if "net=chipnet" in page_url else "mainnet"
res = {"url": page_url, "net": net}

DECODE_QR = """async () => {
  const svg = document.querySelector('#wc-qr svg');
  const xml = new XMLSerializer().serializeToString(svg);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = 600;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, 600, 600);
  const d = g.getImageData(0, 0, 600, 600);
  const r = jsQR(d.data, 600, 600);
  return r ? { text: r.data, version: r.version } : null;
}"""


def start_wallet(uri, seconds, seeded):
    cmd = [node, str(wallet_js), uri, "--seconds", str(seconds)] + (["--seed-from-env"] if seeded else [])
    env = dict(os.environ) if seeded else {k: v for k, v in os.environ.items() if k != "WC_TEST_SEED_HEX"}
    p = subprocess.Popen(cmd, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
    return p, json.loads(p.stdout.readline())


def wait_ds(pg, sel, want, timeout_s):
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        st = pg.eval_on_selector(sel, "e => e.dataset.state") if pg.query_selector(sel) else None
        if st == want:
            return st, round(time.time() - t0, 1)
        pg.wait_for_timeout(500)
    return (pg.eval_on_selector(sel, "e => e.dataset.state") if pg.query_selector(sel) else None), None


def connect_and_scan(b, seeded, use_qr, shot):
    pg = b.new_page()
    errs = []
    pg.on("console", lambda m: errs.append(m.text[:160]) if m.type == "error" else None)
    pg.goto(page_url, wait_until="domcontentloaded", timeout=60000)
    pg.click("#connect")
    pg.wait_for_selector("#wc-qr svg", timeout=20000)
    out = {}
    uri = pg.input_value("#wc-uri")
    if use_qr:
        pg.add_script_tag(path=jsqr)
        dec = pg.evaluate(DECODE_QR)
        qr_attr = pg.eval_on_selector("#wc-qr", "e => e.dataset.qr")
        out["qr"] = {"decoded": bool(dec), "version": dec and dec["version"],
                     "equals_qrUri": bool(dec) and dec["text"] == qr_attr,
                     "upper_alnum": bool(dec) and dec["text"] == dec["text"].upper() and "?" not in dec["text"],
                     "same_link_lowercased": bool(dec) and dec["text"].lower().replace("%3f", "?").replace("%3d", "=").replace("%26", "&") == uri}
        uri = dec["text"] if dec else uri
    w, first = start_wallet(uri, 120, seeded)
    st, secs = wait_ds(pg, "#wallet", "connected", 45)
    out["connected"] = {"state": st, "seconds": secs}
    if st == "connected":
        cs, csecs = wait_ds(pg, "#coins", "done", 90)
        out["scan"] = {"state": cs, "seconds": csecs}
        if cs == "done":
            out["scan"]["sats"] = int(pg.eval_on_selector("#coins", "e => e.dataset.sats"))
            out["scan"]["paths"] = sorted(t.strip() for t in pg.eval_on_selector_all("#coins-list code", "es => es.map(e => e.textContent)"))
            out["scan"]["text"] = pg.inner_text("#coins")[:400]
    pg.screenshot(path=str(repo / "scratch" / shot), full_page=True)
    out["console_errors"] = errs
    try:
        pg.click("#disconnect", timeout=3000)
    except Exception:
        pass
    pg.wait_for_timeout(2500)
    w.kill()
    pg.close()
    return out


try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True, executable_path=chromium,
                               args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        res["SCAN"] = connect_and_scan(b, True, True, f"wc-scan-{net}.png")
        res["CTRL"] = connect_and_scan(b, False, False, f"wc-scan-ctrl-{net}.png")
        b.close()
except Exception as e:
    res["harness_error"] = str(e)[:300]
    print(json.dumps(res, indent=1))
    sys.exit(3)

q = res["SCAN"].get("qr", {})
s = res["SCAN"].get("scan", {})
c = res["CTRL"].get("scan", {})
res["pass"] = {
    "QR": all(q.get(k) for k in ("decoded", "equals_qrUri", "upper_alnum", "same_link_lowercased"))
          and res["SCAN"]["connected"]["state"] == "connected",
    "SCAN": s.get("state") == "done" and s.get("sats") == expect_sats and s.get("paths") == expect_paths,
    "CTRL": c.get("state") == "done" and c.get("sats") == 0,
}
print(json.dumps(res, indent=1))
sys.exit(0 if all(res["pass"].values()) else 1)
