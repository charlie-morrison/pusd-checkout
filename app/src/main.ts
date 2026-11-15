import './style.css';
import { netFromUrl, urlForNet, NETWORKS, PRIZE_ADDRESS, type NetName } from './config';
import { fetchPools, summarize, formatUnits } from './pools';
import { WalletLink, type LinkState } from './wallet';
import { qrSvg } from './qr';
import { scanWallet, GAP_LIMIT, type ScanResult } from './utxos';
import { withElectrum } from './chain';
import { parsePayRequest, bestQuote, payLink, checkMerchantAddress, parseAmount, MEMO_MAX, type PayRequest } from './quote';

const net = netFromUrl(location.search);
const prefix = net.name === 'chipnet' ? 'bchtest' : 'bitcoincash';

// Shared between the payment card and the wallet card: the buyer's spendable coins and the BCH the
// current quote needs. Either side redraws the "enough?" line when its half changes.
let funds: { sats: bigint } | null = null;
let needSats: bigint | null = null;
const fundsListeners: (() => void)[] = [];
const fundsChanged = () => fundsListeners.forEach((f) => f());

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderNetSwitch(root: HTMLElement) {
  const nav = el('nav', { class: 'netswitch', 'aria-label': 'Network' });
  for (const name of Object.keys(NETWORKS) as NetName[]) {
    const cfg = NETWORKS[name];
    const a = el('a', { href: urlForNet(location.href, name) }, cfg.label);
    if (name === net.name) {
      a.classList.add('active');
      a.setAttribute('aria-current', 'page');
    }
    nav.append(a);
  }
  root.append(nav);
}

async function renderPools(root: HTMLElement) {
  const box = el('section', { class: 'card', id: 'pools' });
  box.append(el('h2', {}, `${net.token.symbol} liquidity on ${net.label}`));
  const status = el('p', { class: 'muted' }, 'Reading Cauldron pools…');
  box.append(status);
  root.append(box);
  try {
    const pools = await fetchPools(net.indexer, net.token.category);
    const s = summarize(pools, net.token.decimals);
    status.remove();
    const dl = el('dl');
    const row = (k: string, v: string) => dl.append(el('dt', {}, k), el('dd', {}, v));
    row('Active pools', String(s.count));
    row(`${net.token.symbol} in pools`, formatUnits(s.tokenUnits, net.token.decimals));
    row('BCH in pools', formatUnits(s.sats, 8));
    row(`Cheapest pool price`, s.bestSatsPerToken === null ? '—'
      : `${Math.round(s.bestSatsPerToken).toLocaleString('en-US')} sat per ${net.token.symbol}`);
    box.append(dl);
    box.append(el('p', { class: 'muted small' },
      `Source: ${net.indexer} (read ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC).`));
  } catch (e) {
    status.textContent = `Could not read pools: ${String(e).slice(0, 200)}`;
    status.classList.add('error');
  }
}

function renderWallet(root: HTMLElement) {
  const box = el('section', { class: 'card', id: 'wallet', 'data-state': 'idle' });
  box.append(el('h2', {}, 'Buyer wallet'));
  const body = el('div');
  box.append(body);
  root.append(box);

  const link = new WalletLink(prefix, (s) => {
    if (s.kind !== 'connected') { funds = null; fundsChanged(); }
    draw(s);
  });

  function draw(s: LinkState) {
    box.dataset.state = s.kind;
    body.replaceChildren();
    if (s.kind === 'idle' || s.kind === 'error') {
      if (s.kind === 'error') body.append(el('p', { class: 'error' }, s.message));
      body.append(el('p', { class: 'muted' },
        'Connect a WizardConnect wallet (Cashonize, Paytaca). The page never sees your keys; the wallet signs on its side.'));
      const b = el('button', { type: 'button', id: 'connect' }, 'Connect wallet');
      b.addEventListener('click', () => link.start());
      body.append(b);
    } else if (s.kind === 'waiting') {
      body.append(el('p', {}, 'Scan with a phone wallet, or paste the link below into a desktop wallet.'));
      const qrBox = el('figure', { class: 'qrbox', id: 'wc-qr', 'data-qr': s.qrUri });
      qrBox.append(qrSvg(s.qrUri, 'WizardConnect QR code'));
      body.append(qrBox);
      body.append(el('p', {}, 'Paste this link into your wallet (Cashonize: Connect; Paytaca: WizardConnect → Paste URL):'));
      const row = el('div', { class: 'urirow' });
      const input = el('input', { type: 'text', readonly: '', id: 'wc-uri', value: s.uri, 'aria-label': 'WizardConnect link' });
      const copy = el('button', { type: 'button', id: 'copy' }, 'Copy');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(s.uri); copy.textContent = 'Copied'; } catch { input.select(); }
      });
      row.append(input, copy);
      body.append(row);
      body.append(el('p', { class: 'muted small', id: 'wc-status' },
        'Waiting for the wallet. It counts as connected only after the encrypted key exchange completes.'));
      const cancel = el('button', { type: 'button', class: 'secondary' }, 'Cancel');
      cancel.addEventListener('click', () => link.stop());
      body.append(cancel);
    } else {
      const dl = el('dl');
      dl.append(el('dt', {}, 'Wallet'), el('dd', { id: 'wc-name' }, s.walletName));
      const addr = el('dd', { id: 'wc-address' });
      addr.append(el('code', {}, s.firstAddress));
      dl.append(el('dt', {}, 'First receive address'), addr);
      body.append(el('p', { class: 'ok' }, 'Connected.'), dl);
      const coins = el('div', { id: 'coins', 'data-state': 'scanning' });
      body.append(coins);
      const d = el('button', { type: 'button', id: 'disconnect', class: 'secondary' }, 'Disconnect');
      d.addEventListener('click', () => link.stop());
      body.append(d);
      void scanCoins(coins);
    }
  }
  // Build rule 8: read every address the wallet may have used, not just receive/0.
  let scanRun = 0;
  async function scanCoins(box: HTMLElement) {
    const run = ++scanRun;
    box.dataset.state = 'scanning';
    box.replaceChildren(el('p', { class: 'muted small' },
      `Looking for your coins on the wallet's receive and change addresses (stops after ${GAP_LIMIT} unused in a row)…`));
    try {
      const r = await withElectrum(net.name, (reader) => scanWallet(link.pubkeyAt, prefix, reader));
      if (run !== scanRun || link.state.kind !== 'connected') return;
      drawCoins(box, r);
    } catch (e) {
      if (run !== scanRun) return;
      box.dataset.state = 'error';
      box.replaceChildren(el('p', { class: 'error' }, `Could not read your coins: ${String(e).slice(0, 200)}`));
      const again = el('button', { type: 'button', class: 'secondary' }, 'Try again');
      again.addEventListener('click', () => void scanCoins(box));
      box.append(again);
    }
  }

  function drawCoins(box: HTMLElement, r: ScanResult) {
    funds = { sats: r.spendableSats };
    fundsChanged();
    box.dataset.state = 'done';
    box.dataset.sats = String(r.spendableSats);
    box.dataset.coins = String(r.spendable.length);
    box.replaceChildren();
    const used = new Set(r.spendable.map((u) => `${u.chain}/${u.index}`));
    const head = el('p', { id: 'coins-total' });
    head.append(el('strong', {}, `${formatUnits(r.spendableSats, 8)} BCH`),
      ` spendable in ${r.spendable.length} coin${r.spendable.length === 1 ? '' : 's'} on ${used.size} address${used.size === 1 ? '' : 'es'}.`);
    box.append(head);
    const sum = (c: 'receive' | 'change') => {
      const x = r.chains[c];
      return x.stopped === 'no-xpub' ? `${c}: not shared by the wallet`
        : `${c} 0–${x.checked - 1} (last used ${x.lastUsed < 0 ? 'none' : x.lastUsed})`;
    };
    box.append(el('p', { class: 'muted small' }, `Checked ${sum('receive')}; ${sum('change')}.` +
      (r.tokenUtxos ? ` ${r.tokenUtxos} token coin${r.tokenUtxos === 1 ? '' : 's'} left alone (spending them as BCH would burn the tokens).` : '')));
    if (r.spendable.length) {
      const ul = el('ul', { class: 'small', id: 'coins-list' });
      for (const u of r.spendable) {
        const li = el('li');
        li.append(el('code', {}, `${u.chain}/${u.index}`), ` ${formatUnits(u.satoshis, 8)} BCH`);
        ul.append(li);
      }
      box.append(ul);
    }
    const again = el('button', { type: 'button', class: 'secondary', id: 'rescan' }, 'Rescan');
    again.addEventListener('click', () => void scanCoins(box));
    box.append(again);
  }

  draw(link.state);
  addEventListener('pagehide', () => link.stop(false));
}

const fmtBch = (sats: bigint) => `${formatUnits(sats, 8)} BCH`;
const fmtSat = (sats: bigint) => `${sats.toLocaleString('en-US')} sat`;

function renderPayment(root: HTMLElement, req: PayRequest) {
  const box = el('section', { class: 'card pay', id: 'payment', 'data-state': 'quoting' });
  box.append(el('h2', {}, `Pay ${req.display} ${net.token.symbol}`));
  const to = el('p', { class: 'small' });
  to.append('To the merchant: ', el('code', { id: 'pay-to' }, req.to));
  box.append(to);
  if (req.memo) box.append(el('p', { class: 'small', id: 'pay-memo' }, `Memo: ${req.memo}`));
  const q = el('div', { id: 'pay-quote' });
  const enough = el('p', { id: 'pay-funds', class: 'small' });
  box.append(q, enough);
  box.append(el('p', { class: 'muted small' },
    'The quote refreshes every 30 seconds. The final amount is fixed when your wallet signs.'));
  root.append(box);

  const drawFunds = () => {
    if (needSats === null) { enough.textContent = ''; return; }
    if (!funds) { enough.textContent = 'Connect a wallet below to check your balance.'; enough.className = 'small muted'; box.dataset.funds = 'unknown'; return; }
    const ok = funds.sats >= needSats;
    box.dataset.funds = ok ? 'enough' : 'short';
    enough.className = ok ? 'small ok' : 'small error';
    enough.textContent = ok ? `Your wallet has enough: ${fmtBch(funds.sats)}.`
      : `Not enough in this wallet: it has ${fmtBch(funds.sats)}, the payment needs about ${fmtBch(needSats)}.`;
  };
  fundsListeners.push(drawFunds);

  async function requote() {
    try {
      const pools = await fetchPools(net.indexer, net.token.category);
      const qt = bestQuote(pools, req.units);
      q.replaceChildren();
      if (!qt) {
        box.dataset.state = 'no-liquidity';
        needSats = null;
        q.append(el('p', { class: 'error' }, `No single ${net.token.symbol} pool can fill ${req.display} right now. Try a smaller amount.`));
      } else {
        const total = qt.poolSats + qt.networkFeeSats;
        needSats = total;
        box.dataset.state = 'quoted';
        box.dataset.totalSats = String(total);
        const head = el('p', { id: 'pay-total' });
        head.append('You pay about ', el('strong', {}, fmtBch(total)));
        q.append(head);
        const dl = el('dl', { class: 'small' });
        const row = (k: string, v: string) => dl.append(el('dt', {}, k), el('dd', {}, v));
        row('Into the pool', `${fmtSat(qt.poolSats)} (includes the 0.3% pool fee, ${fmtSat(qt.lpFeeSats)})`);
        row('Network fee', `about ${fmtSat(qt.networkFeeSats)}`);
        row('Merchant receives', `${req.display} ${net.token.symbol}`);
        row('Pool', `${qt.pool.txid.slice(0, 10)}… (the cheapest single pool of ${pools.length})`);
        q.append(dl);
      }
    } catch (e) {
      box.dataset.state = 'error';
      q.replaceChildren(el('p', { class: 'error' }, `Could not read pools: ${String(e).slice(0, 160)}`));
    }
    drawFunds();
  }
  void requote();
  setInterval(() => { if (!document.hidden) void requote(); }, 30000);
}

function renderGenerator(root: HTMLElement, linkError: string | null) {
  const box = el('section', { class: 'card', id: 'generator' });
  box.append(el('h2', {}, 'Create a payment link'));
  if (linkError) box.append(el('p', { class: 'error', id: 'link-error' }, `This payment link is not valid: ${linkError}`));
  box.append(el('p', { class: 'muted small' },
    net.testCoins ? 'Chipnet amounts are whole TEST units (a test token with no value).'
      : 'The amount is in PUSD, a dollar stablecoin: 12.50 means $12.50.'));
  const form = el('form', { id: 'gen-form' });
  const field = (id: string, label: string, attrs: Record<string, string>) => {
    const l = el('label', { for: id }, label);
    const i = el('input', { id, name: id, ...attrs });
    form.append(l, i);
    return i;
  };
  const to = field('gen-to', `Your token-aware address (${prefix}:z…)`, { type: 'text', autocomplete: 'off', spellcheck: 'false' });
  const amt = field('gen-usd', net.testCoins ? 'Amount (TEST)' : 'Amount (USD)', { type: 'text', inputmode: 'decimal' });
  const memo = field('gen-memo', 'Memo (optional)', { type: 'text', maxlength: String(MEMO_MAX) });
  const go = el('button', { type: 'submit' }, 'Make link');
  form.append(go);
  const out = el('div', { id: 'gen-out' });
  box.append(form, out);
  root.append(box);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    out.replaceChildren();
    const addrErr = checkMerchantAddress(to.value.trim(), prefix);
    const units = parseAmount(amt.value.trim(), net.token.decimals);
    const err = addrErr ?? (typeof units === 'string' ? units : null);
    if (err) { out.append(el('p', { class: 'error' }, err)); return; }
    const href = payLink(location.href, to.value.trim(), amt.value.trim(), memo.value.trim());
    const row = el('div', { class: 'urirow' });
    const input = el('input', { type: 'text', readonly: '', id: 'gen-link', value: href, 'aria-label': 'Payment link' });
    const copy = el('button', { type: 'button' }, 'Copy');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(href); copy.textContent = 'Copied'; } catch { input.select(); }
    });
    row.append(input, copy);
    const open = el('a', { href, id: 'gen-open' }, 'Open the payment page');
    const fig = el('figure', { class: 'qrbox' });
    fig.append(qrSvg(href, 'Payment link QR code'));
    out.append(el('p', {}, 'Share this link or show the QR code to the buyer:'), row, fig, open);
  });
}

function render() {
  const app = document.getElementById('app')!;
  const header = el('header', { class: 'banner' });
  header.append(el('h1', {}, 'PUSD checkout for Bitcoin Cash'));
  const addr = el('p', { class: 'addr' });
  addr.append('BCH CashTokens address: ', el('code', {}, PRIZE_ADDRESS));
  header.append(addr);
  header.append(el('p', { class: 'small' },
    'Built by an AI coding agent; product decisions by a human owner. BCH BLAZE 2026 entry.'));
  app.append(header);

  renderNetSwitch(app);
  if (net.testCoins) {
    app.append(el('p', { class: 'note' }, 'Chipnet: test coins only, nothing here has value.'));
  }

  const intro = el('section', { class: 'card' });
  intro.append(el('h2', {}, 'How it works'));
  intro.append(el('p', {},
    'A merchant sets a price in US dollars and shares a link. The buyer pays BCH from a WizardConnect wallet, and in ' +
    'the same transaction the BCH is swapped on a Cauldron pool, so the merchant receives PUSD, a dollar stablecoin ' +
    'on Bitcoin Cash. Paying is not live yet: this build makes the link, quotes it live and finds the buyer\'s coins.'));
  app.append(intro);

  const pay = parsePayRequest(location.search, prefix, net.token.decimals);
  if (pay.ok) renderPayment(app, pay.req);
  else renderGenerator(app, pay.error);
  renderWallet(app);
  void renderPools(app);
}

render();
