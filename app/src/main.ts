import './style.css';
import { netFromUrl, urlForNet, NETWORKS, PRIZE_ADDRESS, type NetName } from './config';
import { fetchPools, summarize, formatUnits, type Pool } from './pools';
import { WalletLink, type LinkState } from './wallet';
import { qrSvg } from './qr';
import { scanWallet, addressOf, GAP_LIMIT, type ScanResult, type FoundUtxo } from './utxos';
import { withElectrum, sendChecked, utxosAt } from './chain';
import { parsePayRequest, bestQuote, freshQuote, payLink, checkMerchantAddress, parseAmount, MEMO_MAX,
  type PayRequest, type Quote } from './quote';
import { buildPayment, checkSigned, wcRequest, txidOf, poolAddress, livePoolsOf, MERCHANT_DUST, type PayTx } from './paytx';
import { ElectrumNetworkProvider, Network } from 'cashscript';
import { STABLES, readThorState, chainStatus, thorUnits, formatThor, type ThorState, type QuoteResult } from './thor';
import { quoteOut, quoteIn, bchDestination, evmDestination } from './bridge';

const net = netFromUrl(location.search);
const prefix = net.name === 'chipnet' ? 'bchtest' : 'bitcoincash';

// Shared between the payment card and the wallet card: the buyer's spendable coins (with their wallet
// paths, build rule 8), an unused change address, and the BCH the current quote needs. Either side
// redraws the "enough?" line and the Pay button when its half changes.
let funds: { sats: bigint; coins: FoundUtxo[]; changeAddress: string } | null = null;
let walletLink: WalletLink | null = null;
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
  walletLink = link;
  rescan = () => { const c = document.getElementById('coins'); if (c) void scanCoins(c); };

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
    // Change goes to the first unused change address (a fresh address per payment, TG #3069); a wallet
    // that did not share its change chain gets it on its first unused receive address.
    const chain = r.chains.change.stopped === 'no-xpub' ? 'receive' : 'change';
    const pub = link.pubkeyAt(chain === 'change' ? 1 : 0, BigInt(r.chains[chain].lastUsed + 1));
    funds = pub ? { sats: r.spendableSats, coins: r.spendable, changeAddress: addressOf(pub, prefix) } : null;
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

let rescan: () => void = () => undefined;


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
  const payBtn = el('button', { type: 'button', id: 'pay-go', disabled: '' }, 'Pay') as HTMLButtonElement;
  const cancelBtn = el('button', { type: 'button', id: 'pay-cancel', class: 'secondary', hidden: '' }, 'Cancel');
  const result = el('div', { id: 'pay-result', 'aria-live': 'polite' });
  box.append(q, enough, payBtn, cancelBtn, result);
  box.append(el('p', { class: 'muted small' },
    'The quote refreshes every 30 seconds. Right before your wallet signs, the page quotes again on the current pool; if the ' +
    'price went up, you see the new price first. The page sends only a transaction it has checked against what you saw.'));
  root.append(box);

  let shown: Quote | null = null;
  let busy = false;
  // Build rule 10, second half (measured 18.11 with the real Cashonize): the indexer lags the chain on the
  // pool's PRICE too, not only on a spent outpoint. After a chain-read "price-up" the 30 s requote put the
  // indexer's older, lower price back on the card, so every later press said "price-up" again. Pools read
  // from the chain win over the indexer's entry for the same owner for LIVE_MS.
  const live = new Map<string, { pools: Pool[]; at: number }>();
  const LIVE_MS = 10 * 60 * 1000;
  const overlay = (pools: Pool[]): Pool[] => {
    const now = Date.now();
    let out = pools;
    for (const [owner, v] of live) {
      if (now - v.at > LIVE_MS) { live.delete(owner); continue; }
      out = [...out.filter((p) => (p.owner_pkh ?? '') !== owner), ...v.pools];
    }
    return out;
  };
  const drawFunds = () => {
    // After a payment the rescan shows what is left; a red "not enough" under "Paid" reads as a failure.
    payBtn.hidden = box.dataset.state === 'paid';
    if (box.dataset.state === 'paid') { enough.textContent = ''; payBtn.disabled = true; return; }
    if (needSats === null) { enough.textContent = ''; payBtn.disabled = true; return; }
    if (!funds) { enough.textContent = 'Connect a wallet below to check your balance.'; enough.className = 'small muted'; box.dataset.funds = 'unknown'; payBtn.disabled = true; return; }
    const ok = funds.sats >= needSats;
    box.dataset.funds = ok ? 'enough' : 'short';
    enough.className = ok ? 'small ok' : 'small error';
    enough.textContent = ok ? `Your wallet has enough: ${fmtBch(funds.sats)}.`
      : `Not enough in this wallet: it has ${fmtBch(funds.sats)}, the payment needs about ${fmtBch(needSats)}.`;
    payBtn.disabled = busy || !ok || !shown;
  };
  fundsListeners.push(drawFunds);

  const drawQuote = (qt: Quote, poolCount: number) => {
    shown = qt;
    // The buyer also pays the BCH that rides on the merchant's token output (MERCHANT_DUST). Measured 17.11:
    // without it the card said 9,253 sat while the wallet asked for 10,408 for the same payment.
    const total = qt.poolSats + MERCHANT_DUST + qt.networkFeeSats;
    needSats = total;
    box.dataset.totalSats = String(total);
    q.replaceChildren();
    const head = el('p', { id: 'pay-total' });
    head.append('You pay about ', el('strong', {}, fmtBch(total)));
    q.append(head);
    const dl = el('dl', { class: 'small' });
    const row = (k: string, v: string) => dl.append(el('dt', {}, k), el('dd', {}, v));
    row('Into the pool', `${fmtSat(qt.poolSats)} (includes the 0.3% pool fee, ${fmtSat(qt.lpFeeSats)})`);
    row('With the tokens', `${fmtSat(MERCHANT_DUST)} (a token output must carry some BCH; it goes to the merchant with the ${net.token.symbol})`);
    row('Network fee', `about ${fmtSat(qt.networkFeeSats)} (more if your coins sit on several addresses)`);
    row('Merchant receives', `${req.display} ${net.token.symbol}`);
    row('Pool', `${qt.pool.txid.slice(0, 10)}… (the cheapest single pool of ${poolCount})`);
    q.append(dl);
  };

  async function requote() {
    if (busy) return; // never swap the quote under a sign request
    try {
      const pools = overlay(await fetchPools(net.indexer, net.token.category));
      const qt = bestQuote(pools, req.units);
      if (busy) return;
      if (!qt) {
        box.dataset.state = 'no-liquidity';
        needSats = null; shown = null;
        q.replaceChildren(el('p', { class: 'error' }, `No single ${net.token.symbol} pool can fill ${req.display} right now. Try a smaller amount.`));
      } else {
        drawQuote(qt, pools.length);
        if (!['paid', 'refused', 'rejected', 'send-error', 'price-up', 'build-error'].includes(box.dataset.state ?? '')) box.dataset.state = 'quoted';
      }
    } catch (e) {
      if (busy) return;
      box.dataset.state = 'error';
      shown = null;
      q.replaceChildren(el('p', { class: 'error' }, `Could not read pools: ${String(e).slice(0, 160)}`));
    }
    drawFunds();
  }

  let abort: AbortController | null = null;
  const say = (state: string, cls: string, ...parts: (string | Node)[]) => {
    box.dataset.state = state;
    const p = el('p', { class: cls, id: 'pay-message' });
    p.append(...parts);
    result.replaceChildren(p);
  };
  const finish = () => { busy = false; abort = null; cancelBtn.hidden = true; drawFunds(); };
  cancelBtn.addEventListener('click', () => abort?.abort('The buyer cancelled the payment on the page.'));

  async function pay() {
    const dm = walletLink?.manager;
    if (busy || !shown || !funds || !dm || walletLink?.state.kind !== 'connected') return;
    busy = true; payBtn.disabled = true;
    try {
      say('preparing', 'muted small', 'Checking the pool again before your wallet signs…');
      // Build rule 5: the pool UTXO changes with every trade, so quote on the current pool right now, and
      // take the pool's outpoint from the chain: the indexer can still list an outpoint that is spent.
      const provider = new ElectrumNetworkProvider(net.name === 'chipnet' ? Network.CHIPNET : Network.MAINNET, { manualConnectionManagement: true });
      let pools = overlay(await fetchPools(net.indexer, net.token.category));
      let fresh = freshQuote(shown, pools);
      const checked = new Set<string>();
      for (let i = 0; i < 4 && fresh.ok && !checked.has(fresh.quote.pool.owner_pkh ?? ''); i++) {
        const owner = fresh.quote.pool;
        checked.add(owner.owner_pkh ?? '');
        const read = livePoolsOf(owner, await utxosAt(net.name, poolAddress(owner, provider)));
        live.set(owner.owner_pkh ?? '', { pools: read, at: Date.now() });
        pools = [...pools.filter((p) => p.owner_pkh !== owner.owner_pkh), ...read];
        fresh = freshQuote(shown, pools);
      }
      if (fresh.ok && !checked.has(fresh.quote.pool.owner_pkh ?? '')) {
        return say('gone', 'error', 'The pools are changing too fast to check right now. Press Pay to try again.');
      }
      box.dataset.poolOutpoint = fresh.ok ? `${fresh.quote.pool.txid}:${fresh.quote.pool.tx_pos}` : '';
      if (!fresh.ok) {
        if (fresh.quote) drawQuote(fresh.quote, pools.length); else { shown = null; needSats = null; }
        return say(fresh.reason, 'error', fresh.reason === 'price-up'
          ? `${fresh.error} Press Pay again to pay the new price.` : fresh.error);
      }
      if (fresh.moved) drawQuote(fresh.quote, pools.length);
      const tx: PayTx | string = buildPayment({ pool: fresh.quote.pool, units: req.units, merchant: req.to, coins: funds.coins,
        changeAddress: funds.changeAddress, provider, label: `${req.display} ${net.token.symbol}` });
      if (typeof tx === 'string') return say('build-error', 'error', tx);
      box.dataset.buyerPays = String(tx.buyerPays);
      say('signing', 'small', 'Your wallet is asking you to sign: ', el('strong', {}, tx.userPrompt),
        `. Total ${fmtSat(tx.buyerPays)}: ${fmtSat(tx.poolCost)} into the pool, ${fmtSat(MERCHANT_DUST)} with the merchant's tokens, ${fmtSat(tx.networkFee)} network fee.`,
        // Measured 17.11: 485 sat of change cannot be sent back (below 546), so paytx leaves it to the miners;
        // the wallet showed the true total, the card did not say why it was higher than "about".
        tx.change === 0n && tx.buyerPays > (needSats ?? 0n)
          ? ' Your leftover change was below 546 sat, too small to send back, so it is part of the network fee.' : '');
      abort = new AbortController();
      cancelBtn.hidden = false;
      const wire = wcRequest(tx);
      let resp;
      try {
        resp = await dm.signTransaction({ transaction: wire as never, inputPaths: tx.inputPaths }, { signal: abort.signal });
      } catch (e) {
        return say('rejected', 'error', `The wallet did not sign: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
      }
      cancelBtn.hidden = true;
      if (resp.error || !resp.signedTransaction) return say('rejected', 'error', `The wallet did not sign: ${String(resp.error ?? 'no transaction returned').slice(0, 160)}`);
      const bad = checkSigned(tx, resp.signedTransaction);
      if (bad) return say('refused', 'error', `Not sent: ${bad} The page only sends the transaction you saw, so nothing was spent.`);
      const txid = txidOf(resp.signedTransaction);
      box.dataset.txid = txid;
      say('sending', 'muted small', 'Signed and checked. Sending it to the network…');
      try {
        await sendChecked(net.name, resp.signedTransaction, txid);
      } catch (e) {
        const m = String((e as Error)?.message ?? e);
        const stale = /missing|inputs|conflict|spent|mempool/i.test(m);
        box.dataset.sendError = m.slice(0, 200);
        return say('send-error', 'error', stale
          ? `Another trade used the pool before this payment reached the network, so nothing was spent. Press Pay to try again on a fresh quote. (Node: ${m.slice(0, 120)})`
          : `The network refused the payment, so nothing was spent: ${m.slice(0, 160)}`);
      }
      const a = el('a', { href: net.explorerTx(txid), id: 'pay-txid', target: '_blank', rel: 'noopener' }, txid);
      say('paid', 'ok', `Paid. The merchant receives ${req.display} ${net.token.symbol} in this transaction: `, a);
      rescan();
    } catch (e) {
      say('error', 'error', `Payment stopped: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    } finally {
      finish();
    }
  }
  payBtn.addEventListener('click', () => void pay());

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

const BRIDGE_MAX_USD = 1000;

// Stablecoin Bridge bounty: PUSD on BCH <-> USDT on BSC / USDC on Base through THORChain. Quote only here.
function renderBridge(root: HTMLElement) {
  const box = el('section', { class: 'card', id: 'bridge', 'data-state': 'idle' });
  box.append(el('h2', {}, 'Bridge: PUSD ⇄ USDT / USDC'));
  root.append(box);
  if (net.testCoins) {
    box.dataset.state = 'mainnet-only';
    const p = el('p', { class: 'muted' }, 'The bridge runs on mainnet only: THORChain has no Bitcoin Cash test network. ');
    p.append(el('a', { href: urlForNet(location.href, 'mainnet') }, 'Open it on mainnet'));
    box.append(p);
    return;
  }
  box.append(el('p', { class: 'small' },
    'Move dollars between Bitcoin Cash and another chain. Out: your PUSD is sold on a Cauldron pool and the BCH goes to ' +
    'THORChain, which pays USDT or USDC to your address on the other chain. In: the reverse, ending as PUSD in your BCH wallet. ' +
    'This build shows the live quote for both directions; sending is not live yet.'));
  const status = el('p', { class: 'small muted', id: 'thor-status' }, 'Reading THORChain status…');
  box.append(status);

  const form = el('form', { id: 'bridge-form' });
  const dir = el('fieldset', { class: 'dir' });
  dir.append(el('legend', {}, 'Direction'));
  const radio = (value: string, label: string, checked: boolean) => {
    const l = el('label');
    const r = el('input', { type: 'radio', name: 'dir', value, id: `dir-${value}` });
    (r as HTMLInputElement).checked = checked;
    l.append(r, ` ${label}`);
    dir.append(l);
    return r as HTMLInputElement;
  };
  const rOut = radio('out', 'PUSD → other chain', true);
  radio('in', 'Other chain → PUSD', false);
  form.append(dir);
  form.append(el('label', { for: 'br-chain' }, 'Other chain'));
  const sel = el('select', { id: 'br-chain', name: 'br-chain' }) as HTMLSelectElement;
  for (const st of STABLES) sel.append(el('option', { value: st.chain }, st.label));
  form.append(sel);
  form.append(el('label', { for: 'br-usd' }, 'Amount (USD)'));
  const amt = el('input', { id: 'br-usd', type: 'text', inputmode: 'decimal', value: '5' }) as HTMLInputElement;
  form.append(amt);
  const destLabel = el('label', { for: 'br-dest' });
  const dest = el('input', { id: 'br-dest', type: 'text', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  form.append(destLabel, dest);
  const go = el('button', { type: 'submit', id: 'br-go' }, 'Get quote');
  form.append(go);
  const out = el('div', { id: 'bridge-quote' });
  box.append(form, out);

  const syncDir = () => {
    destLabel.textContent = rOut.checked ? 'Your address on the other chain (0x…)' : 'Your Bitcoin Cash address (the PUSD lands here)';
    dest.placeholder = rOut.checked ? '0x…' : 'bitcoincash:z… or q…';
  };
  form.addEventListener('change', syncDir);
  syncDir();

  let state: ThorState | null = null;
  const drawStatus = () => {
    if (!state) return;
    const parts = ['BCH', ...STABLES.map((x) => x.chain)].map((c) => {
      const s = chainStatus(state!.inbound, c);
      return `${c} ${s.open ? 'open' : 'closed'}`;
    });
    status.textContent = `THORChain right now: ${parts.join(' · ')} (read ${new Date(state.readAt * 1000).toISOString().slice(11, 16)} UTC).`;
    for (const opt of Array.from(sel.options)) {
      const st = STABLES.find((x) => x.chain === opt.value)!;
      const s = chainStatus(state.inbound, st.chain);
      opt.textContent = s.open ? st.label : `${st.label} (closed: ${(s.reason ?? "").replace(/\.$/, "")})`;
    }
    box.dataset.thor = parts.join(',');
  };
  const loadState = async () => {
    try { state = await readThorState(); drawStatus(); }
    catch (e) { status.textContent = `Could not read THORChain status: ${String(e).slice(0, 160)}`; status.className = 'small error'; }
  };

  let timer: number | undefined;
  let run = 0;
  const thorError = (r: QuoteResult) => (r.ok ? '' : r.error);
  async function quote() {
    const mine = ++run;
    out.replaceChildren(el('p', { class: 'muted small' }, 'Quoting…'));
    box.dataset.state = 'quoting';
    const st = STABLES.find((x) => x.chain === sel.value)!;
    const units1e8 = thorUnits(amt.value.trim());
    const pusd = parseAmount(amt.value.trim(), net.token.decimals);
    const fail = (msg: string, kind = 'error') => { if (mine !== run) return; box.dataset.state = kind; out.replaceChildren(el('p', { class: 'error' }, msg)); };
    if (units1e8 === null || typeof pusd === 'string') return fail('Enter an amount in dollars, at most 2 decimals.');
    if (units1e8 > BigInt(BRIDGE_MAX_USD) * 100000000n) return fail(`The amount is above the demo limit of ${BRIDGE_MAX_USD}.`);
    try {
      await loadState();
      if (!state) return fail('THORChain status is unknown, so no quote.');
      const pools = await fetchPools(net.indexer, net.token.category);
      const dl = el('dl', { class: 'small' });
      const row = (k: string, v: string, id?: string) => dl.append(el('dt', {}, k), el('dd', id ? { id } : {}, v));
      const head = el('p', { id: 'bridge-total' });
      let thorQ: QuoteResult;
      if (rOut.checked) {
        const to = evmDestination(dest.value);
        if (!to) return fail('Enter your 0x address on the other chain (40 hex characters).');
        const r = await quoteOut(pools, pusd, st, to, state);
        if (mine !== run) return;
        if (typeof r === 'string') return fail(r);
        thorQ = r.thor;
        if (!r.thor.ok) return fail(thorError(r.thor), `thor-${r.thor.kind}`);
        const q = r.thor.q;
        const cost = 100 * (1 - Number(q.expectedOut) / Number(units1e8));
        head.append(`You send ${amt.value.trim()} PUSD and receive about `, el('strong', {}, `${formatThor(q.expectedOut)} ${st.symbol}`), ` on ${st.chain}.`);
        row('1. Cauldron buys your PUSD', `${fmtBch(r.sell.sats)} (after the 0.3% pool fee, ${fmtSat(r.sell.lpFee)})`);
        row('2. BCH network fees', `${fmtSat(r.swapFee)} swap + ${fmtSat(r.sendFee)} send to THORChain`);
        row('3. Sent to THORChain', fmtBch(r.toThor));
        row('4. THORChain fees', `${formatThor(q.fees.total)} ${st.symbol} in total (${q.fees.totalBps} bps; liquidity ${formatThor(q.fees.liquidity)}, outbound ${formatThor(q.fees.outbound)}, slippage ${q.fees.slippageBps} bps)`);
        row('End-to-end cost', `${cost.toFixed(2)}%`, 'bridge-cost');
        row('THORChain minimum', `${formatThor(q.minIn, 8)} BCH into the vault`);
        row('Time', `about ${Math.round(q.seconds / 60)} min (THORChain waits for a BCH confirmation)`);
        row('Vault', `${q.inboundAddress} (an active THORChain vault; the memo pays your address)`);
      } else {
        const d = bchDestination(dest.value);
        if (typeof d === 'string') return fail(d);
        const r = await quoteIn(pools, units1e8, st, d.thor, state);
        if (mine !== run) return;
        thorQ = r.thor;
        if (!r.thor.ok) return fail(thorError(r.thor), `thor-${r.thor.kind}`);
        const q = r.thor.q;
        if (!r.buy) return fail('THORChain would deliver too little BCH to buy any PUSD.');
        const got = r.buy.units;
        const cost = 100 * (1 - Number(got) / Number(pusd));
        head.append(`You send ${amt.value.trim()} ${st.symbol} on ${st.chain} and end with about `, el('strong', {}, `${formatUnits(got, net.token.decimals)} PUSD`), '.');
        row('1. THORChain delivers', `${fmtBch(q.expectedOut)} to ${d.thor.slice(0, 12)}…`);
        row('2. THORChain fees', `${fmtBch(q.fees.total)} in total (${q.fees.totalBps} bps; liquidity ${fmtSat(q.fees.liquidity)}, outbound ${fmtSat(q.fees.outbound)}, slippage ${q.fees.slippageBps} bps)`);
        row('3. Cauldron sells you PUSD', `${formatUnits(got, net.token.decimals)} PUSD for ${fmtSat(r.buy.poolSats)} (incl. the 0.3% pool fee) + ${fmtSat(r.swapFee)} network fee`);
        row('PUSD goes to', d.token);
        row('End-to-end cost', `${cost.toFixed(2)}%`, 'bridge-cost');
        row('THORChain minimum', `${formatThor(q.minIn)} ${st.symbol}`);
        row('Time', `about ${Math.max(1, Math.round(q.seconds / 60))} min for THORChain, then one BCH transaction`);
        row('Deposit', `approve the router ${q.router?.slice(0, 10)}… for exactly the amount, then depositWithExpiry to vault ${q.inboundAddress.slice(0, 10)}…`);
      }
      const q = thorQ.ok ? thorQ.q : null;
      if (q) {
        const left = el('dd', { id: 'bridge-expiry' });
        const tick = () => {
          const s = q.expiry - Math.floor(Date.now() / 1000);
          left.textContent = s > 0 ? `${Math.floor(s / 60)} min ${s % 60} s (THORChain: do not send after it)` : 'expired, ask again';
        };
        tick();
        dl.append(el('dt', {}, 'Quote valid for'), left);
        const iv = setInterval(() => { if (mine !== run) clearInterval(iv); else tick(); }, 1000);
        box.dataset.expectedOut = String(q.expectedOut);
        box.dataset.memo = q.memo;
        box.dataset.amountIn = String(q.req.amountIn);
      }
      box.dataset.state = 'quoted';
      out.replaceChildren(head, dl, el('p', { class: 'muted small' },
        'Live quote from THORChain and Cauldron; it refreshes every 30 seconds. Rates are never promised: THORChain prices BCH by its own pools.'));
      clearTimeout(timer);
      timer = window.setTimeout(() => { if (!document.hidden && mine === run) void quote(); }, 30000);
    } catch (e) {
      fail(`Could not get a quote: ${String(e).slice(0, 160)}`);
    }
  }
  form.addEventListener('submit', (ev) => { ev.preventDefault(); void quote(); });
  void loadState();
}

function render() {
  const app = document.getElementById('app')!;
  const header = el('header', { class: 'banner' });
  // Organizer, BLAZE chat 18.11: say what the app is in five seconds, in big letters, with a picture of the main idea.
  header.append(el('h1', { class: 'hero' }, 'Price it in dollars. Get paid in PUSD.'));
  header.append(el('p', { class: 'hero-sub' },
    'Your buyer pays BCH from their own wallet. One Bitcoin Cash transaction swaps it on a Cauldron pool, ' +
    'so you receive PUSD, a dollar stablecoin.'));
  const flow = el('div', { class: 'flow', 'aria-label': 'One transaction: buyer pays BCH, a Cauldron pool swaps it, the merchant gets PUSD' });
  const step = (big: string, small: string) => { const d = el('div', { class: 'step' }); d.append(el('strong', {}, big), el('span', {}, small)); return d; };
  flow.append(step('Buyer', 'pays BCH'), el('span', { class: 'arrow' }, '→'), step('Cauldron pool', 'swaps it'),
    el('span', { class: 'arrow' }, '→'), step('Merchant', 'gets PUSD'));
  header.append(flow);
  header.append(el('p', { class: 'flow-note small muted' }, 'All three in one transaction: nobody holds the money in between.'));
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
    'on Bitcoin Cash. The page holds no keys: your wallet signs, and the page checks the signed transaction before it sends it.'));
  app.append(intro);

  const pay = parsePayRequest(location.search, prefix, net.token.decimals);
  if (pay.ok) renderPayment(app, pay.req);
  else renderGenerator(app, pay.error);
  renderWallet(app);
  renderBridge(app);
  void renderPools(app);
}

render();
