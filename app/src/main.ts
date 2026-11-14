import './style.css';
import { netFromUrl, urlForNet, NETWORKS, PRIZE_ADDRESS, type NetName } from './config';
import { fetchPools, summarize, formatUnits } from './pools';

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
    'yet; this page shows the network switch and live pool data.'));
  app.append(intro);

  void renderPools(app);
}

render();
