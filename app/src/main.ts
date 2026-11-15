import './style.css';
import { netFromUrl, urlForNet, NETWORKS, PRIZE_ADDRESS, type NetName } from './config';
import { fetchPools, summarize, formatUnits } from './pools';
import { WalletLink, type LinkState } from './wallet';
import { qrSvg } from './qr';
import { scanWallet, GAP_LIMIT, type ScanResult } from './utxos';
import { withElectrum } from './chain';

const net = netFromUrl(location.search);

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

  const prefix = net.name === 'chipnet' ? 'bchtest' : 'bitcoincash';
  const link = new WalletLink(prefix, (s) => draw(s));

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
  intro.append(el('h2', {}, 'What this will be'));
  intro.append(el('p', {},
    'A merchant sets a price in US dollars. The buyer pays BCH from a WizardConnect wallet, and in the same ' +
    'transaction the BCH is swapped on a Cauldron pool so the merchant receives PUSD. The pay flow is not built ' +
    'yet; this page connects a wallet and shows live pool data.'));
  app.append(intro);

  renderWallet(app);
  void renderPools(app);
}

render();
