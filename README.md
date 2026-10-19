# meme-signal-discord v2

Real-time pump.fun signal generator for Discord. It is a rewrite of [MbotixTech/meme-coins-signal](https://github.com/MbotixTech/meme-coins-signal).

**Signals only.** The bot never touches a wallet. Each signal carries a trade plan (stop, target, time stop), and the bot forward-tests that plan, so you can measure whether the signals have edge before you automate anything. If you want to add execution later, `engine.on('signal', rec => …)` is the hook for it.

## Pipeline

```
PumpPortal WS ──create──► track token, subscribe to its trades
              ──trade───► update holders / flow / dev / snipers (every trade)
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

## Discord commands

- `/stats [hours]`: plan hit rates (TP / SL / time), average and median return after slippage and costs, peak distribution, and results by tier.
- `/recent`: the last 10 signals with live or final results.
- `/filters`: the active thresholds and trade plan.

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

MIT licensed. Not financial advice.
