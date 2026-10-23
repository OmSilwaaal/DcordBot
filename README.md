# meme-signal-discord v2

Real-time pump.fun signal generator for Discord. It is a rewrite of [MbotixTech/meme-coins-signal](https://github.com/MbotixTech/meme-coins-signal).

**Signals only.** The bot never touches a wallet. Each signal carries a trade plan (stop, target, time stop), and the bot forward-tests that plan, so you can measure whether the signals have edge before you automate anything. If you want to add execution later, `engine.on('signal', rec => …)` is the hook for it.

## Pipeline

```
PumpPortal WS ──create──► track token, subscribe to its trades
Solana logs   ──trade───► update holders / flow / dev / snipers (every trade)
(or PumpPortal, with a funded API key)
                           │
      every 2s ────────────┤ features → hard gates → score
                           │   (fail = "not yet", re-checked next trade,
                           │    except dev-sold / copycat = permanent)
                           ▼
                verify: socials → on-chain (authorities, Token-2022
                extensions, real top holders) → RugCheck
                           ▼
                re-check on fresh state → Discord alert
                           ▼
           forward test 60m → edit alert with result → signals.jsonl
```

### Where trades come from

PumpPortal only streams trades to connections with an API key funded with at least 0.02 SOL. Launches and migrations are still free there, so the bot always takes those from PumpPortal. Trades come from one of two places:

- **`chain` (default):** the bot subscribes to the pump.fun program's logs on a Solana websocket (`SOLANA_WS_URL`, default the free public endpoint) and decodes each `TradeEvent` itself. Holder balances are counted from every trade since launch, because the on-chain event doesn't include them. The stream is about 40 MB/min, mostly failed bot transactions, so a metered RPC plan (including Helius free) can run out of credits fast. Keep `SOLANA_RPC_URL` on Helius for the holder checks and leave this on the public endpoint. The public endpoint drops each connection every 30s or so, so the bot keeps 3 overlapping connections (`SOLANA_WS_CONNECTIONS`) and de-duplicates by transaction signature. In a live test that cut missed trades from about 4% with one connection to about 0.3%.
- **`pumpportal`:** set `PUMPPORTAL_WS=wss://pumpportal.fun/api/data?api-key=YOUR_KEY` with a funded key. The bot switches to it automatically when the URL has an API key, or force either with `TRADE_SOURCE`.

Every tracked token is also snapshotted at 60s, 180s and 300s. Each snapshot is labelled with what happened next and written to `data/dataset-*.jsonl`. `npm run analyze` reads these files to show which features actually predict outcomes.

## What changed vs. the original

| Original | v2 |
|---|---|
| DexScreener keyword search (misses most launches) | PumpPortal websocket: every pump.fun launch and every trade |
| "LP lock" = `dexId === 'pumpfun'` | Real on-chain checks: mint/freeze authority, sell-blocking Token-2022 extensions, top holders excluding the curve |
| RugCheck fails open (error ⇒ safe) | Error ⇒ `unavailable`, shown in the alert; `danger` flags always reject |
| Rejected tokens re-queried every 3s, uncached | Verification runs only for candidates, is cached and rate-limited, and backs off on retries |
| Token marked "seen" before the final filter, never re-checked | Thresholds are "not yet" states, re-evaluated on every trade |
| `setInterval` async loop overlaps → duplicate alerts | Tick guard + per-token status machine; one signal per token |
| $300 liq / $50 volume gates | Gates on buyers, flow, distribution, dev behaviour, snipers, and churn |
| No exits, no outcome tracking | Plan forward-tested per signal; `/stats` reports real hit rates |
| `ecosystem.config.js` breaks under ESM | `.cjs` |

## Features and gates

| Feature | Why it matters | Gate (default) |
|---|---|---|
| Dev sold % of bag | Most direct rug signal on pump.fun | any sell ⇒ **permanent reject** |
| Copycat ticker | Clones of a trending ticker rarely beat the original | >3 earlier same-ticker launches in 60m ⇒ never tracked |
| Age | First ~45s is sniper and bundle noise | ≥45s |
| Curve progress | Too early = no demand yet; too late = graduation dump risk | 8–85% |
| Unique buyers / 5m buyers | Breadth of demand | ≥25 / ≥15 |
| Buy share 5m (count) | Buy-side pressure | ≥55% |
| Net SOL flow 5m | Capital actually entering | ≥2 SOL |
| Top10 / max holder (stream) | Overhang that can dump | ≤30% / ≤8% |
| Top10 / max holder (on-chain) | Catches supply moved by transfer, which the stream can't see | ≤35% / ≤10% |
| Dev holding | Overhang from the creator | ≤8% |
| Sniper share | Wallets that bought in the first 3s and still hold | ≤15% |
| Top-3 wallet volume share | Volume driven by a few wallets = fake demand | ≤50% |
| Churn share | Wallets with ≥2 buys and ≥2 sells (wash) | ≤30% |
| Drawdown from peak | Don't signal something already dumping | ≤35% |
| Mint/freeze authority, Token-2022 extensions | Can mint, freeze, block sells, or tax you | any ⇒ permanent reject |

**Extra data (logged on every signal, gates off by default):**

| Feature | Source | What it catches |
|---|---|---|
| Creator history: prior launches, launches in 24h, prior graduations, best prior peak | Every launch the bot sees, saved to `data/creators.json` | Serial launchers and rug farms; devs with a real track record. Gets better the longer the bot runs |
| Fresh-wallet %, low-activity % | RPC: transaction history of ~20 top holders and earliest buyers | One actor posing as many "unique buyers" |
| Funding clusters, cluster-held %, dev-funded buyers | RPC: who sent each of those wallets its first SOL (exchanges ignored) | Bundles, and devs buying their own token through side wallets |
| Launch-block wallets and their holdings, wallets in the first 2 blocks, same-block buyer groups | Trade stream (block number of every trade, chain feed only) | Bundled launches: several wallets buying in the creation block is coordination, not demand |
| First buyers sold % | Trade stream | The first 20 buyers selling into later buyers |
| Flipper / serial-sniper / habitual-loser holdings, losers buying in the last minute, profitable-wallet buyers, known-buyer % | Wallet book: every wallet's past positions on tracked tokens, saved to `data/wallets.json` | Who is buying, by track record. Gets better the longer the bot runs |
| Repeated trade sizes | Trade stream | Fixed-size volume bots |
| Launches/min, graduations/1h, SOL 1h change | Trade stream + SOL price | Hot vs. dead market |
| Paid DexScreener profile / boosts / ads / takeover | DexScreener orders endpoint | Money spent on promotion (commitment, or a planned pump) |
| X posts mentioning the contract address, unique authors, median followers, new-account % | Official X API (optional, `X_BEARER_TOKEN`) | Attention arriving, filtered for bot accounts |

The wallet book records a position for every wallet (creator excluded) when its token leaves tracking, valuing anything still held at the last price. A wallet with at least `WALLET_MIN_POSITIONS` positions is classified, in this order: **serial sniper** if it first bought within 2 blocks of launch on ≥50% of positions; **flipper** if it sold within 2 minutes of buying on ≥50%; **profitable** if it has ≥5 positions, a ≥50% win rate and ≥1 SOL total profit; **habitual loser** if it has ≥5 positions, a win rate under 30% and a net loss. In the Oct 21 backfill, profitable wallets buying predicted *worse* outcomes (they profit by selling to later buyers), so their gate is a maximum, not a minimum. These features exist for every tracked token, so they land in the dataset, and every dataset row and signal now also stores its price path in 15-second buckets so exits can be backtested.

**Backfill.** `npm run backfill -- fetch` downloads the on-chain trades of tokens already in the dataset (Helius `getTransactionsForAddress`, resumable; scope it with `BACKFILL_DAY`, `BACKFILL_MIN_BUYERS`, `BACKFILL_MAX_CREDITS`), and `npm run backfill -- replay` replays them through the tracker and wallet book in time order. It writes `data/backfill/features.jsonl` (wallet features for every dataset snapshot, no look-ahead) and `data/backfill/wallets.json`, which can seed the live wallet book. Active tokens cost roughly 70 Helius credits each.

Wallet forensics costs roughly 20–45 RPC calls per candidate (per-wallet results are cached for 6h, and repeat sniper wallets hit the cache). Watch your Helius usage; if your plan allows more requests per second, raise `RPC_RPS`. Set `WALLET_ANALYSIS=false` to turn it off.

X only runs on candidates that passed every other check, at most one search every 5 seconds, capped per day. There are two sources:

- **Official API** (`X_BEARER_TOKEN`): stable and allowed, billed per post read. Default cap 20 searches/day.
- **Scraping** (`X_SCRAPE_API_KEY`, via [rettiwt-api](https://www.npmjs.com/package/rettiwt-api)): free, but it logs in as an X account, which is against X's terms. Use a **throwaway account**, never your personal one: the key is equivalent to that account's login, and X can limit or suspend it at any time. To get the key, log into the throwaway account in a browser and follow rettiwt-api's README to generate an `API_KEY`. Default cap 150 searches/day. After 3 failures in a row the bot pauses X lookups (15 min, doubling up to 6h) instead of hammering a flagged account, and `/status` shows the pause and the last error.

After a week or two, `npm run analyze` splits finished signals at each feature's median and compares plan returns above vs. below. Promote a feature to a gate only if the gap holds up week after week: `MAX_FRESH_WALLET_PCT`, `MAX_CLUSTER_HOLD_PCT`, `MAX_DEV_FUNDED_BUYERS`, `MAX_CREATOR_LAUNCHES_24H`, and the wallet-intelligence gates `MAX_LAUNCH_BLOCK_HOLD_PCT`, `MAX_SLOT_CLUSTER_HOLD_PCT`, `MAX_EARLY_BUYERS_SOLD_PCT`, `MAX_FLIPPER_HOLD_PCT`, `MAX_SERIAL_SNIPER_HOLD_PCT`, `MAX_PROFITABLE_BUYERS`, `MAX_LOSER_BUYERS_1M`.

**Score (0–100):** buyer velocity 25, net flow relative to market cap 20, SOL-weighted buy pressure 15, distribution 20, organic flow 10, socials 5, ticker originality 5. A token signals at ≥60. Tier A is ≥80 and tier B is ≥70. Every threshold is an env var (see `.env.example`).

> **These weights and thresholds are priors, not fitted values.** Nobody can hand you edge in this market. What this gives you is features grounded in how pump.fun tokens actually rug and run, plus the measurement loop to tune them. Run the bot for a few days, then run `npm run analyze` and re-weight toward the features that show lift.

## Setup

1. **Discord bot.** Create an application at <https://discord.com/developers/applications> and add a bot to get the token. Invite it with scopes `bot` and `applications.commands`, and permissions *Send Messages*, *Embed Links*, *Read Message History*. Then right-click the channel → Copy Channel ID (requires Developer Mode).
2. **RPC.** Get a free key from Helius or QuickNode. The public RPC often refuses `getTokenLargestAccounts`, and with `REQUIRE_ONCHAIN=true` that means no signals.
3. **Run:**

```bash
cp .env.example .env    # fill DISCORD_TOKEN, DISCORD_CHANNEL_ID, DISCORD_GUILD_ID, SOLANA_RPC_URL
npm install
npm run build
npm start
```

Or with Docker / PM2:

```bash
docker build -t meme-signal . && docker run -d --env-file .env -v $(pwd)/data:/app/data meme-signal
npm run build && pm2 start ecosystem.config.cjs
```

### Deploying on Railway

The repo is Railway-ready: `railway.json` builds from the Dockerfile, health-checks `/health`, and restarts on crash.

1. Push this folder to a **private** GitHub repo. `.env` is gitignored; never commit your tokens.
2. In Railway, create a new project → **Deploy from GitHub repo** → pick the repo.
3. Right-click the service → **Attach volume**, with mount path **`/app/data`**. Without a volume, forward-test results and the dataset are wiped on every redeploy.
4. Under **Variables**, add everything from `.env.example` you want to change, plus:
   - `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, `DISCORD_GUILD_ID`, `SOLANA_RPC_URL` (required)
   - `RAILWAY_RUN_UID=0` (required: Railway mounts volumes as root, and the image runs as a non-root user)
5. Deploy and watch the logs for the `[status]` line every 60s. `ws=up` and a climbing `created=` count mean launches are arriving. Then run `/status` in Discord: the **Trade stream** line must show trades on tracked tokens, or nothing can ever signal.

Keep it at **1 replica**. Two instances would double-post every signal, and PumpPortal asks for one connection per client.

Expected cost on the Hobby plan: roughly 200–400 MB of RAM and a fraction of a vCPU, which lands around the $5 included usage. Check the **Metrics** tab after the first day.

## Discord commands

- `/stats [hours]`: plan hit rates (TP / SL / time), average and median return after slippage and costs, peak distribution, and results by tier.
- `/recent`: the last 10 signals with live or final results.
- `/filters`: the active thresholds and trade plan.
- `/status`: live self-test. It checks the PumpPortal feed, launch flow, the trade stream, SOL price, the Solana RPC holder check (run on a real token the bot is tracking), RugCheck, DexScreener and storage, then lists the 5 tokens closest to signaling and what each is waiting on.
- `/funnel`: where tokens get filtered out since boot. It shows launches → matured → passed every gate → verify → signals, the **near misses** (tokens blocked by exactly one gate, which tells you which gate to loosen), verify-stage outcomes, and permanent rejections.
- `/test`: posts a clearly-labelled fake signal to the signals channel, to confirm permissions and see what alerts look like.

On every boot the bot also posts "🟢 Memecoin radar online" to the channel. Set `STARTUP_MESSAGE=false` to turn that off.

When a signal's 60-minute window ends, the bot edits the original alert in place with its result.

## Data

| File | Contents |
|---|---|
| `data/signals-active.json` | Signals currently being forward-tested (survives restarts) |
| `data/signals.jsonl` | Finished signals with features, checks, and outcome |
| `data/dataset-YYYY-MM-DD.jsonl` | Snapshots of every tracked token with labels |

## Honest limitations

- **Fills.** The forward test assumes take-profit fills at the target and stop-loss fills at the observed price, which usually gaps below the stop. Entry includes 5% slippage, and 3% round-trip costs are applied. Real fills on thin curves can be worse.
- **Missed trades.** Trades that land in the same block as the token's creation can arrive before the trade subscription is active. The on-chain holder check at signal time covers that gap for distribution, but not for flow.
- **Peak multiples are not returns.** `/stats` reports the plan's return separately for this reason.
- **Base rate.** The overwhelming majority of pump.fun launches never graduate. Gates shrink that pool; they don't remove the risk.
- **PumpPortal.** It's a third-party feed and asks for a single connection per client. If they change their schema, update `feeds/pumpportal.ts`.
- **Chain trade decoding.** `feeds/pumpChain.ts` decodes pump.fun's `TradeEvent` layout directly. If pump.fun changes that event, trades stop decoding and `/status` shows 0 trades on tracked tokens. Balances counted from trades miss plain token transfers between wallets; the on-chain holder check at verify time is the source of truth.

MIT licensed. Not financial advice.
