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

What the scripts showed (measured 04.11 to 12.11.2026):

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

## After the tag (hackathon work, from 14.11)

- Live page: https://charliemorrison.dev/pusd-checkout/ (built from `main` by GitHub Actions). Add `?net=chipnet`
  to use chipnet test coins; every other query parameter stays when you switch networks.
- The page as it was on 14.11 (the README above, before any UI):
  [web.archive.org snapshot](https://web.archive.org/web/20261114111613/https://charliemorrison.dev/pusd-checkout/)
  and the code at tag [`v0-2026-11-14`](https://github.com/charlie-morrison/pusd-checkout/tree/v0-2026-11-14).
- 14.11: page skeleton with the prize address in the header, the mainnet/chipnet switch, and live Cauldron pool data
  for the merchant's token (PUSD on mainnet, a test token on chipnet).
- 14.11, later: WizardConnect wallet connection (paste the link into Cashonize or Paytaca). The page counts the wallet
  as connected only after the encrypted key exchange completes, because a wallet with the wrong pairing secret still
  sends its "ready" message. Disconnect tells the wallet before closing. No payment yet.
  `test/wc_connect_e2e.py` checks it over the live relay with a throwaway wallet built on the official
  `@wizardconnect/wallet` library: the right wallet connects and the page shows exactly its first receive address;
  a wallet with a wrong secret stays unconnected. A build that trusts the "ready" message alone fails that test.
- 15.11: a QR code of the connection link for phone wallets. It uses the link's upper-case form, which fits the
  compact alphanumeric QR mode. After connecting, the page finds the buyer's coins on every address the wallet may
  have used, not only the first one. HD wallets such as Paytaca move to a new receive address after each payment
  and keep change on a second chain. The page walks both chains from the keys the wallet shared and stops after 20
  unused addresses in a row. An address that was paid and later emptied still counts as used, so the walk does not
  stop early. Coins that carry tokens are listed but never spent as plain BCH, because that would burn the tokens.
  - `test/scan_unit.mjs` checks the walk against a fake chain in 7 cases. Four broken copies fail it: one that
    reads only the first address, one that counts the gap wrong, one that spends token coins, and one that treats
    an emptied address as unused.
  - `test/wc_scan_e2e.py` runs against live chipnet. It decodes the QR from the page, and a test wallet connects
    with the decoded text, the way a phone would. The wallet has coins on receive/3 and change/2 and none on the
    first address, and the page has to find exactly those two. A fresh wallet has to show 0.
- 15.11, later: merchant payment links. Without parameters the page offers a form: the merchant enters a
  token-aware address of the network, an amount and an optional memo, and gets a link and a QR code. A link
  (`?to=<address>&usd=12.50&memo=…`) opens a payment card with a live quote: the cheapest single Cauldron pool that
  can deliver exactly that amount, the 0.3% pool fee, and an estimated network fee. It refreshes every 30 seconds.
  Once a wallet is connected, the card says whether the wallet holds enough. Addresses that cannot receive tokens,
  addresses of the other network, and malformed amounts are rejected. (Paying went live on 17.11, see below.)
  - `test/quote_unit.mjs`: 16 cases then, 18 now. The quote must equal the Cauldron SDK's own optimiser limited to
    one pool, checked against live mainnet pools. Four broken copies fail it: one picks the priciest pool, one
    accepts any address type, one skips the network check, one lets a pool sell its last token.
  - Corrected 22.11: "equal to the SDK's optimiser" was the wrong check. With one pool allowed, the SDK splits the
    buy across all pools, keeps the pool with the largest share and solves again, so its pick can cost more than
    the cheapest pool. That made the test fail on live pools on 18.11 and 21.11 while the page quoted correctly.
    Now the quote must be the cheapest pool by brute force and never cost more than the SDK's pick. On 20,000
    random pool sets ours was cheaper 298 times and never dearer; one of those sets is now a fixed test case.
  - `test/pay_e2e.py`: the generator's link carries every field and keeps the network. The page's total matches an
    independent quote. The test wallet reads "enough" for 40 TEST and "short" for 900 TEST. A link to a non-token
    address is refused, and a mainnet link for 12.50 PUSD is quoted.
- 16.11: the bridge quote (for the Stablecoin Bridge bounty). On mainnet the page quotes both directions between
  PUSD and a dollar stablecoin on another chain, through THORChain: USDT on BNB Smart Chain or USDC on Base.
  - Out: a Cauldron pool buys your PUSD, the BCH goes to a THORChain vault with a memo, and THORChain pays the
    stablecoin to your 0x address. You need no wallet on the other chain. These are two BCH transactions, because
    THORChain's own instructions forbid sending from a covenant script such as a Cauldron pool.
  - In: you deposit the stablecoin through THORChain's router, THORChain sends BCH to your address, and a Cauldron
    pool sells you PUSD. The page takes either address form; THORChain gets the plain one without the
    `bitcoincash:` prefix, which it cannot parse, and the PUSD goes to the token-aware form of the same key.
  - The page shows each fee on its own line, THORChain's minimum, the time estimate and a countdown to the quote's
    expiry. It never promises a rate.
  - Before quoting, it reads THORChain's status and says which chains are closed. On 16.11 THORChain had halted
    Base, so the page offered only BSC; a quote for a closed chain is never requested.
  - It accepts a THORChain quote only if the memo pays the asset and address you entered, the vault is one of
    THORChain's active vaults (it runs six for BCH, and quotes name different ones), the router is active, the
    quote lives at least another minute, and the amount clears THORChain's minimum.
  - Sending is not live yet.
  - Re-quote before signing (`freshQuote`, for the signing step that comes next): the payment is rebuilt on the
    pools as they are at that moment, because every trade replaces a pool's coin. If the price rose by more than
    0.5% since the buyer saw it, the buyer has to see the new price first.
  - `test/thor_unit.mjs`: 43 cases on THORChain answers saved on 16.11 and on altered copies of them (memo to
    another address or asset, inactive vault or router, expiring quote, fees in another asset, a memo too long for
    an OP_RETURN). Eight broken copies fail it, each on its own case: one ignores a halted chain, and the others
    skip the destination, vault, expiry, price or router check, keep the address prefix, or buy one token too many.
  - `test/bridge_e2e.py` runs against live THORChain and Cauldron. The page's status line must match THORChain.
    Both directions must produce a memo that pays the entered address, and an output equal to an independent
    THORChain quote within 1%. A closed chain must show its reason, bad addresses must be refused, and chipnet must
    say that the bridge runs on mainnet only.
- 16.11, later: the payment transaction, not on the page yet. `app/src/paytx.ts` builds it from the coins the scan
  found. Input 0 is the Cauldron pool, which the page unlocks. Inputs 1 and up are the buyer's coins, largest first,
  and each one tells the wallet its own path (receive or change, and the index). The outputs are the pool, the
  merchant's tokens on 1,000 sat, and the buyer's change. The network fee is sized for the signed transaction, and
  change too small to send goes to the miner. The prompt the wallet shows says what the buyer pays and to whom.
  `checkSigned` rejects a signed transaction unless only signatures were added: same inputs, same outputs byte for
  byte, and the pool's unlock untouched.
  - `test/paytx_unit.mjs`: 24 cases. A test wallet with a random seed signs the buyer's inputs at the paths the page
    asks for, and the BCH 2025 virtual machine must accept the result: the pool covenant plus both signatures. A
    signature from the wrong key gets past `checkSigned`, because signatures are the wallet's job, and the VM refuses
    it. Changed outputs, an extra output, a changed pool unlock, a moved input and an unsigned input are all rejected.
    Eight broken copies fail it.
- 17.11: paying is live. The card gets a Pay button once a wallet is connected, its coins are found and it holds
  enough. When you press it, the page:
  - quotes again on the pools as they are now. The pool's coin comes from a Fulcrum node, not from the pool indexer:
    on chipnet the indexer was still listing a pool coin five minutes after our own payment had spent it, and the
    node refused the next payment built on it;
  - shows you the new price and waits for a second press if the price rose by more than 0.5%;
  - builds the transaction and sends the sign request with the transaction as hex, the cost in the prompt, and
    `broadcast: false`. The wallet hands the signed transaction back, and the page sends it only after
    `checkSigned` passes, so a transaction you did not see never reaches the network;
  - shows the transaction id, or says in plain words why nothing was spent: you rejected it, the wallet changed it,
    or the pool moved before it reached the network.
  - The card's total now includes the 1,000 sat that go to the merchant with the tokens. Before 17.11 it left them
    out, and the 15.11 test checked it against a reference that left them out too.
  - If the change would be below 546 sat, it cannot be sent back and goes to the miners; the signing line says so.
  - `test/wc_sign_unit.mjs`: 10 cases, offline. The sign request goes through JSON as it would over the relay, the
    test wallet signs both buyer inputs (receive/3 and change/2), and the BCH 2025 VM accepts the result. A wallet
    that changes an output after signing is caught by `checkSigned`. The wallet refuses a path that is not its own
    and a transaction that is not hex.
  - `test/pay_wc_e2e.py`, chipnet, live relay, the test wallet from the scan test:
    - a wallet that takes 1,000 sat off an output after signing gets "Not sent", and its transaction is not on chain;
    - an honest payment of 78 TEST spends receive/3 and change/2 and pays exactly 78 TEST to the merchant
      ([4cc1030c…](https://chipnet.imaginary.cash/tx/4cc1030c0e53494da7ead827ed97036832401bddf80ccd9427b6752e30d7a69d));
    - 40 TEST spends the change of that payment on change/3, on the pool coin the node reported while the indexer
      still listed the old one
      ([100cde84…](https://chipnet.imaginary.cash/tx/100cde842c4a1eab52d2d9fc5141a9d049f43f40ddbe58377194bcdd02afaff2));
    - 15 TEST: the price had moved 0.83%, so the page showed the new price, the second press paid it
      ([4d869d9d…](https://chipnet.imaginary.cash/tx/4d869d9dd59c0370689b71dc470ac34229d0f06c4c88268c1c5bd408e4b353d2)).
  - Real wallets on this exact flow (Cashonize, Paytaca) are the next step. Both have signed and sent this
    transaction shape from a script before: Cashonize on 06.11, Paytaca (hex form) on 11.11.

- 18.11: a real Cashonize wallet paid through the published page on chipnet (15 TEST,
  [4f7438d3…](https://chipnet.imaginary.cash/tx/4f7438d36fd5fb5f2c34e13d23e676070eeb6abbd4472aecbfd9004a0a008670)).
  The pool indexer lags the chain on price as well as on spent coins, so a price read from the chain now wins over
  the indexer for ten minutes.
- 19.11: the first mainnet payments, Cashonize through the published page. $1
  ([5dfe7ecd…](https://blockchair.com/bitcoin-cash/transaction/5dfe7ecd8cd6c039a6cfa99f0d2a48d6283ba2bf9607a3bf14782f36bd124e4e))
  and $3 ([1ebc3e45…](https://blockchair.com/bitcoin-cash/transaction/1ebc3e45b4fe1ebffe7798b9d49698e2b79530425b2cb5693f1521ccc09bc156)):
  the merchant got exactly 1.00 and 3.00 PUSD in the buyer's transaction. A mainnet pool made the transaction a few
  bytes longer than on chipnet, and the first build failed the 1 sat/byte floor; fixed. Once, another trade spent the
  pool while the wallet dialog was open. The node refused our transaction, and the page said nothing was spent and
  asked for one more press.
- 20.11: the bridge sends out. With a quote for PUSD → USDT on BNB Smart Chain on screen and a wallet holding the
  PUSD, the card shows Send. It takes two signatures:
  1. The PUSD is sold on one Cauldron pool. The pool is read from the chain first, and the BCH lands on the wallet's
     own change address.
  2. That BCH goes to the THORChain vault, with the memo in OP_RETURN. The vault comes first, the memo is under 80
     bytes, and any change goes back to the sending address, because THORChain refunds there.

  Before step 1 the page asks THORChain for a quote on what the sale will yield, so a halted chain or an amount under
  THORChain's minimum stops the send before any PUSD is sold. Before step 2 it reads THORChain again and gets a quote
  for the exact amount. If step 1 went out and step 2 did not, the card keeps the sale and offers to send the BCH only.
  - First mainnet run, Cashonize: 4 PUSD sold in
    [a5aa6ffe…](https://blockchair.com/bitcoin-cash/transaction/a5aa6ffe51805cc2732e9a6274a212374ef5479a896e1c7e1a194e71d058ccc6)
    for 1,981,389 sat, then 1,980,537 sat to the vault with `=:BSC.USDT:0x435a…AEd0` in
    [235d42af…](https://blockchair.com/bitcoin-cash/transaction/235d42afcd6925d47042ea9961b3f3e37a721992d83666dc7de2fda4d164cc33).
    The quote said about 3.72 USDT.
  - `test/bridgetx_unit.mjs`: 24 cases. The BCH 2025 VM accepts both signed transactions. The pool output matches the
    Cauldron SDK's sell math, no token is burned, and unsold PUSD comes back as token change. Refused: a memo over
    80 bytes, change to another address, a chipnet or script vault, and an amount the coin cannot carry.
  - The coin scan failed twice on the default Fulcrum server and worked on the third press, so every connection now
    falls back to three other servers.
- 22.11: Paytaca through the published page. The Paytaca browser extension (0.27.5, built from the same code as the
  phone app) paired over WizardConnect, signed the page's request, and the page checked and sent it on chipnet: 15 TEST
  to the merchant in
  [a1329b46…](https://chipnet.imaginary.cash/tx/a1329b4698561a1927774e15956841fb5c8f6936cbf0b28ab24305f01ca707cd).
  The faucet coin sat on Paytaca's receive/1, not receive/0, and the page's address scan found it. Paytaca showed the
  cost line the page puts in the request ("Pay 3,154 sat … for 15 TEST") and listed the same pool, inputs and outputs.

Build: Node 24, `npm ci --ignore-scripts`, `npm run build` (output in `dist/`), `npm run dev` for a local server.

## Running the scripts

Node 24. `npm install --ignore-scripts`, then run a script with the path to `node_modules` as its first
argument; each script's header comment lists its arguments. The Paytaca check also needs the two Paytaca
source files at the pinned commit in a vendor directory.

## License

MIT
