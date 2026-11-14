import './style.css';
import { netFromUrl, urlForNet, NETWORKS, PRIZE_ADDRESS, type NetName } from './config';
import { fetchPools, summarize, formatUnits } from './pools';
import { WalletLink, type LinkState } from './wallet';

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

  const link = new WalletLink(net.name === 'chipnet' ? 'bchtest' : 'bitcoincash', (s) => draw(s));

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
      const d = el('button', { type: 'button', id: 'disconnect', class: 'secondary' }, 'Disconnect');
      d.addEventListener('click', () => link.stop());
      body.append(d);
    }
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
