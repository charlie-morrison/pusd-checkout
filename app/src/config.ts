// Per-network settings. The network comes from the URL (?net=chipnet), so a judge can try the
// whole flow on chipnet with free test coins and the same page runs on mainnet by default.

export type NetName = 'mainnet' | 'chipnet';

export interface NetConfig {
  name: NetName;
  label: string;
  // Cauldron pool indexer for this network (sends CORS for any origin, measured 14.11).
  indexer: string;
  // Token the merchant receives: PUSD on mainnet, a test token with live Cauldron pools on chipnet.
  token: { category: string; symbol: string; decimals: number };
  explorerTx: (txid: string) => string;
  testCoins: boolean;
}

export const NETWORKS: Record<NetName, NetConfig> = {
  mainnet: {
    name: 'mainnet',
    label: 'Mainnet',
    indexer: 'https://indexer.cauldron.quest',
    // ParyonUSD category; 2 decimals per its BCMR record (measured 04.11).
    token: { category: '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544', symbol: 'PUSD', decimals: 2 },
    explorerTx: (txid) => `https://blockchair.com/bitcoin-cash/transaction/${txid}`,
    testCoins: false,
  },
  chipnet: {
    name: 'chipnet',
    label: 'Chipnet (test coins)',
    indexer: 'https://indexer-chipnet.riften.net',
    // Public chipnet test token with live Cauldron pools (used for the 06.11 and 11.11 chipnet runs).
    token: { category: '53636bc8c1afbe35a7ba169eadfac0aebadeacf96954a9a066a483e885580ed4', symbol: 'TEST', decimals: 0 },
    explorerTx: (txid) => `https://chipnet.imaginary.cash/tx/${txid}`,
    testCoins: true,
  },
};

// Where prizes go (BLAZE rule: a BCH CashTokens address in the banner at the top of the demo).
export const PRIZE_ADDRESS = 'bitcoincash:zzmsqp8y48crckhv63y5mz9fek066xrufu9u9w59mp';

export function netFromUrl(search: string): NetConfig {
  const v = new URLSearchParams(search).get('net');
  return v === 'chipnet' ? NETWORKS.chipnet : NETWORKS.mainnet;
}

// Same page, other network; every other query parameter (merchant, amount, memo) is kept.
export function urlForNet(href: string, net: NetName): string {
  const u = new URL(href);
  if (net === 'mainnet') u.searchParams.delete('net');
  else u.searchParams.set('net', net);
  return u.pathname + u.search + u.hash;
}
