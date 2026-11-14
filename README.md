# PUSD checkout for Bitcoin Cash

A merchant sets a price in US dollars. The buyer pays from a WizardConnect wallet with BCH. In that same
transaction the BCH is swapped on a Cauldron pool and the merchant receives PUSD, so the merchant holds a
dollar stablecoin the moment the payment confirms. Entry for BCH BLAZE 2026: the Mainnet track and the
Stablecoin Bridge bounty.

**BCH CashTokens address (prizes):** `bitcoincash:zzmsqp8y48crckhv63y5mz9fek066xrufu9u9w59mp`

**Who built this:** the code is written by an AI coding agent. Product decisions (what to build and for whom)
are made by a human owner. DoraHacks handle: `hacker73d8f52`.

## State of this repo on 14.11.2026: preparation scripts only, no UI

The organizers allow preparation done before the hackathon as a base, and judge only the work done from
14.11 to 22.11. This first commit (tag `v0-2026-11-14`) is that base: throwaway scripts that checked the
idea could work at all. There is no checkout page yet. Everything after the tag is the hackathon work.

What the scripts showed (measured 04.11 to 06.11.2026):

- `prep/liquidity/measure.py`: PUSD pools on Cauldron hold enough liquidity for $1 to $20 payments at a
  small overpay versus $1 per PUSD. Needs a pool dump from the Cauldron indexer and a BCH/USD price.
- `prep/liquidity/checkout_spike.mjs`, `sdk_crosscheck.mjs`: one transaction that swaps the buyer's BCH for
  an exact PUSD amount on a live pool and pays it to the merchant is valid in the BCH VM (offline, nothing
  broadcast); our pool math matches the Cauldron SDK.
- `prep/liquidity/wc_wallet_sign_check.mts`: Cashonize's own WizardConnect signing code signs that
  transaction offline and leaves the other outputs untouched.
- `prep/wizardconnect/wc_relay_roundtrip.mjs`: dapp and wallet pair over a public WizardConnect relay
  with the official libraries; a wallet with a wrong pairing secret never gets a sign request.
- `prep/wizardconnect/wc_dapp_live.mjs`: the dapp half of a test against the real Cashonize web app.
- `prep/chipnet/wc_chipnet_e2e.mjs`, `wc_chipnet_swap.mjs`: on chipnet the real Cashonize app signed and
  broadcast a plain payment
  ([1ba59534...7235](https://chipnet.imaginary.cash/tx/1ba59534f20a26e77fe256892809cf1b1a33f564a1cc0bdadaf19caac5b17235))
  and the full swap-and-pay transaction
  ([a95c17e9...81d1](https://chipnet.imaginary.cash/tx/a95c17e9a22b386a4a063da1a51273ed95baa3b345d7d9614c0f26f778bc81d1)).
- `prep/paytaca/pt_offline_sign.mjs`: Paytaca's WizardConnect signing code (paytaca-app commit `6be1bd3e`)
  accepts the transaction only when it is sent as a hex string, so the checkout always sends hex.
- Same `wc_chipnet_swap.mjs`, run against the real Paytaca app (its browser extension, 0.27.5) on 11.11:
  Paytaca signed and broadcast the swap-and-pay transaction
  ([95e7a63b...f14d](https://chipnet.imaginary.cash/tx/95e7a63b0f522ca8d96234ffe23a978df2b733cd3116d97293884166aff0f14d)).
  Sent as a decoded object instead of hex, the same request opened an empty dialog and signing failed.
  Paytaca's Receive screen showed a different address than receive/0, so the checkout looks for the
  buyer's coins across the wallet's addresses instead of only receive/0.
- `prep/browser-spike/`: the libraries run from a static page in a browser (Cauldron indexer over CORS,
  Electrum over WebSocket, WizardConnect relay), so the checkout needs no server.
- `prep/bridge/bridge_quote.mjs` (10.11): quotes only, for the Stablecoin Bridge bounty. PUSD can leave BCH as
  USDC on Base or USDT on BSC (Cauldron sell, then a plain BCH send to THORChain with a memo), and come back the
  same way in reverse. THORChain takes about $0.82 at minimum each way, and its fee is about 4.9% at $5 and 0.5%
  at $100. The two BCH steps stay separate transactions, because THORChain asks for a plain send, not a
  contract spend. On the day we measured, THORChain priced BCH about 2% above Kraken, which made one direction
  look cheaper than it is; a live quote is the only number that counts.
- `prep/bridge/in_leg_sim.py` (12.11): the EVM half of the way back in (USDT on BSC to BCH), checked without
  real tokens. It takes a live THORChain quote, builds the router deposit call from it, and runs that call with
  `eth_call` against the live router. The sender is a dummy address with no key; a state override gives it the
  USDT and the approval. The call goes through (about 66,000 gas, plus about 47,000 for the approval), and it
  reverts with no approval, with an expiry in the past, and with more USDT than the balance. THORChain hands out
  a different vault on each request, so the script checks that the quoted vault is active on two nodes instead
  of expecting both nodes to name the same one. Python 3 with `web3`.

All keys in these scripts are generated per run and thrown away. Nothing here holds funds.

## Running the scripts

Node 24. `npm install --ignore-scripts`, then run a script with the path to `node_modules` as its first
argument; each script's header comment lists its arguments. The Paytaca check also needs the two Paytaca
source files at the pinned commit in a vendor directory.

## License

MIT
