/**
 * Backfill: rebuilds wallet intelligence for tokens already in the dataset from on-chain history,
 * so new features can be evaluated on days of past data instead of waiting for the live bot.
 *
 *   npm run backfill -- fetch    download each dataset token's trades (resumable)
 *   npm run backfill -- replay   replay them through the tracker + wallet book, write features
 *
 * fetch uses Helius getTransactionsForAddress (BACKFILL_RPC_URL, else SOLANA_RPC_URL), limited to
 * the window the live bot tracked each token. It shares the key's rate limit with the live bot,
 * so keep BACKFILL_RPS below the plan's limit (default 4).
 *
 * replay walks every trade of every token in time order. A token's positions enter the wallet book
 * only when its tracking window ends, exactly as live, so a snapshot never sees its own token's
 * outcome. Output: data/backfill/features.jsonl (one row per dataset snapshot) and
 * data/backfill/wallets.json (a wallet book that can seed the live one).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { computeFeatures, type FeatureContext } from '../analysis/features.js';
import { WalletBook } from '../analysis/walletBook.js';
import { decodePumpLogs } from '../feeds/pumpChain.js';
import { TokenState } from '../state/tracker.js';
import type { Features } from '../types.js';
import { appendJsonl, dataPath, listDataFiles, readJsonl } from '../utils/files.js';
import { RateLimiter } from '../utils/limiter.js';

const OUT_DIR = dataPath('backfill');
const TRADES_FILE = path.join(OUT_DIR, 'trades.jsonl');
const FEATURES_FILE = path.join(OUT_DIR, 'features.jsonl');
const WALLETS_FILE = path.join(OUT_DIR, 'wallets.json');

/** Start the history window a little before the bot saw the launch: PumpPortal can lag the chain. */
const LEAD_SEC = 120;
const PAGE_LIMIT = 1000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 5;

interface DatasetRow {
  mint: string;
  createdAt: number;
  droppedAt: number;
  snapshots: { ageSec: number; features: { uniqueBuyers: number } }[];
}

/** Helius bills full transactions at 10 credits per 100 returned, minimum 10 per request. */
const pageCredits = (n: number) => Math.max(10, Math.ceil(n / 100) * 10);

/** [slot, txIndex, blockTimeSec, wallet, isBuy, sol, tokens, vSol, vTokens] */
type CompactTrade = [number, number, number, string, 0 | 1, number, number, number, number];

interface TokenTrades {
  mint: string;
  createSlot: number | null;
  createTime: number | null;
  /** Fee payer of the create transaction, i.e. the creator. */
  creator: string | null;
  trades: CompactTrade[];
  txs: number;
  error?: string;
}

function datasetTokens(): DatasetRow[] {
  const byMint = new Map<string, DatasetRow>();
  for (const f of listDataFiles('dataset-')) for (const r of readJsonl<DatasetRow>(f)) byMint.set(r.mint, r);
  return [...byMint.values()].sort((a, b) => a.createdAt - b.createdAt);
}

// ── fetch ──────────────────────────────────────────────────────────────

interface RpcTx {
  slot: number;
  transactionIndex: number;
  blockTime: number | null;
  meta: { err: unknown; logMessages?: string[] } | null;
  transaction: { message: { accountKeys: ({ pubkey: string } | string)[] } };
}

async function rpcPage(url: string, mint: string, from: number, to: number, token: string | null): Promise<{ data: RpcTx[]; next: string | null }> {
  const params: Record<string, unknown> = {
    transactionDetails: 'full',
    maxSupportedTransactionVersion: 1,
    limit: PAGE_LIMIT,
    sortOrder: 'asc',
    filters: { status: 'succeeded', blockTime: { gte: from, lte: to } },
  };
  if (token) params.paginationToken = token;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransactionsForAddress', params: [mint, params] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 429) throw Object.assign(new Error('rate limited'), { rateLimited: true });
  const j = (await res.json()) as { result?: { data: RpcTx[]; paginationToken: string | null }; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  if (!j.result) throw new Error(`HTTP ${res.status}`);
  return { data: j.result.data, next: j.result.paginationToken };
}

const spend = { credits: 0 };

async function fetchToken(url: string, limiter: RateLimiter, row: DatasetRow): Promise<TokenTrades> {
  const from = Math.floor(row.createdAt / 1000) - LEAD_SEC;
  const to = Math.ceil(row.droppedAt / 1000);
  const out: TokenTrades = { mint: row.mint, createSlot: null, createTime: null, creator: null, trades: [], txs: 0 };
  let token: string | null = null;
  do {
    let page: { data: RpcTx[]; next: string | null } | null = null;
    for (let attempt = 1; !page; attempt++) {
      await limiter.take();
      try {
        page = await rpcPage(url, row.mint, from, to, token);
      } catch (e) {
        if ((e as { rateLimited?: boolean }).rateLimited) limiter.pause(2_000);
        if (attempt >= MAX_RETRIES) throw e;
        await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
      }
    }
    spend.credits += pageCredits(page.data.length);
    for (const tx of page.data) {
      out.txs++;
      if (tx.meta?.err || !tx.meta?.logMessages || tx.blockTime === null) continue;
      const { trades, created } = decodePumpLogs(tx.meta.logMessages);
      if (created.has(row.mint) && out.createSlot === null) {
        out.createSlot = tx.slot;
        out.createTime = tx.blockTime;
        const payer = tx.transaction.message.accountKeys[0];
        out.creator = typeof payer === 'string' ? payer : payer?.pubkey ?? null;
      }
      for (const t of trades) {
        if (t.mint !== row.mint) continue;
        out.trades.push([tx.slot, tx.transactionIndex, tx.blockTime, t.wallet, t.isBuy ? 1 : 0, t.sol, t.tokens, t.vSol, t.vTokens]);
      }
    }
    // A short page is the last one even when a pagination token comes back (checked on a sample of 30
    // tokens): stopping here avoids paying the 10-credit minimum for an empty follow-up page per token.
    token = page.data.length < PAGE_LIMIT ? null : page.next;
  } while (token);
  return out;
}

async function fetchAll(): Promise<void> {
  const url = process.env.BACKFILL_RPC_URL || config.feeds.rpcUrl;
  if (!/api[-_]key=/i.test(url)) throw new Error('Set BACKFILL_RPC_URL (or SOLANA_RPC_URL) to a Helius URL with ?api-key=…');
  const rps = Number(process.env.BACKFILL_RPS || 4);
  const concurrency = Number(process.env.BACKFILL_CONCURRENCY || 16);
  const limiter = new RateLimiter(rps);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const done = new Set(readJsonl<TokenTrades>(TRADES_FILE).filter((t) => !t.error).map((t) => t.mint));
  // Scope: a UTC launch day, a minimum peak buyer count, a token cap, and a hard credit budget.
  const day = process.env.BACKFILL_DAY || '';
  const minBuyers = Number(process.env.BACKFILL_MIN_BUYERS || 0);
  const limit = Number(process.env.BACKFILL_LIMIT || Infinity);
  const maxCredits = Number(process.env.BACKFILL_MAX_CREDITS || Infinity);
  const todo = datasetTokens()
    .filter((r) => !done.has(r.mint))
    .filter((r) => !day || new Date(r.createdAt).toISOString().startsWith(day))
    .filter((r) => Math.max(0, ...r.snapshots.map((s) => s.features.uniqueBuyers)) >= minBuyers)
    .slice(0, limit);
  console.log(
    `${done.size} tokens already fetched, ${todo.length} to go (${rps} req/s, ${concurrency} in flight` +
      `${Number.isFinite(maxCredits) ? `, budget ${maxCredits.toLocaleString()} credits` : ''})`,
  );

  let next = 0;
  let finished = 0;
  let failed = 0;
  let trades = 0;
  const started = Date.now();
  const progress = setInterval(() => {
    const rate = finished / ((Date.now() - started) / 1000);
    const eta = rate > 0 ? (todo.length - finished) / rate / 60 : Infinity;
    console.log(
      `  ${finished}/${todo.length} tokens · ${trades.toLocaleString()} trades · ~${spend.credits.toLocaleString()} credits · ` +
        `${failed} failed · ~${eta.toFixed(0)} min left`,
    );
  }, 30_000);

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      // Leave headroom for requests already in flight (~70 credits per active token), so the run
      // stops at the budget instead of overshooting it.
      while (next < todo.length && spend.credits + concurrency * 70 < maxCredits) {
        const row = todo[next++];
        try {
          const t = await fetchToken(url, limiter, row);
          trades += t.trades.length;
          appendJsonl(TRADES_FILE, t);
        } catch (e) {
          failed++;
          // Failed tokens are retried on the next run: only successful ones count as done.
          appendJsonl(TRADES_FILE, { mint: row.mint, error: e instanceof Error ? e.message : String(e) });
        }
        finished++;
      }
    }),
  );
  clearInterval(progress);
  if (next < todo.length) console.log(`stopped at the credit budget (${maxCredits.toLocaleString()})`);
  console.log(
    `fetched ${finished} tokens, ${trades.toLocaleString()} trades, ~${spend.credits.toLocaleString()} credits, ` +
      `${failed} failed (re-run to retry them)`,
  );
}

// ── replay ─────────────────────────────────────────────────────────────

const INTEL_KEYS = [
  'launchBlockBuyers', 'launchBlockHoldPct', 'earlyBlocksHoldPct', 'slotClusterHoldPct', 'earlyBuyersSoldPct',
  'knownBuyerPct', 'profitableBuyers', 'profitableHoldPct', 'flipperHoldPct', 'serialSniperHoldPct',
  'loserHoldPct', 'loserBuyers1m',
] as const satisfies readonly (keyof Features)[];

const TRADE = 0;
const SNAPSHOT = 1;
const END = 2;

function replay(): void {
  const rows = new Map(datasetTokens().map((r) => [r.mint, r]));
  const fetched = new Map<string, TokenTrades>();
  for (const t of readJsonl<TokenTrades>(TRADES_FILE)) if (!t.error && rows.has(t.mint)) fetched.set(t.mint, t);
  console.log(`replaying ${fetched.size} of ${rows.size} dataset tokens`);

  fs.rmSync(WALLETS_FILE, { force: true });
  fs.rmSync(FEATURES_FILE, { force: true });
  const book = new WalletBook(config.walletBook, WALLETS_FILE);
  const plan = config.plan;
  const ctx: FeatureContext = {
    solUsd: null,
    sniperWindowSec: config.tracking.sniperWindowSec,
    creator: () => ({ priorLaunches: 0, launches24h: 0, priorGraduated: 0, bestPriorPeakSol: 0, minSinceLast: -1 }),
    wallet: (w) => book.profile(w),
    market: { launchesPerMin: 0, graduations1h: 0, solChange1hPct: 0 },
  };

  // One time-ordered stream of every trade, snapshot and end-of-tracking across all tokens.
  // [timeMs, kind, tokenIndex, payload, slot, txIndex]
  const tokens = [...fetched.values()];
  const starts: number[] = [];
  const events: [number, number, number, number, number, number][] = [];
  tokens.forEach((t, i) => {
    const row = rows.get(t.mint)!;
    const start = t.createTime !== null ? t.createTime * 1000 : row.createdAt;
    starts[i] = start;
    t.trades.forEach((tr, j) => events.push([tr[2] * 1000, TRADE, i, j, tr[0], tr[1]]));
    for (const s of row.snapshots) events.push([start + s.ageSec * 1000, SNAPSHOT, i, s.ageSec, 0, 0]);
    events.push([start + (row.droppedAt - row.createdAt), END, i, 0, 0, 0]);
  });
  // Block times are whole seconds: order within a second by slot, then position in the block.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[4] - b[4] || a[5] - b[5]);

  const states = new Map<number, TokenState>();
  const balances = new Map<number, Map<string, number>>();
  const stateFor = (i: number): TokenState => {
    let s = states.get(i);
    if (!s) {
      const t = tokens[i];
      s = new TokenState(
        { mint: t.mint, name: '', symbol: '', uri: '', creator: t.creator ?? '', bondingCurveKey: '', pool: 'pump',
          initialBuyTokens: 0, initialBuySol: 0, vTokens: 1_073_000_000, vSol: 30, mcapSol: 0, signature: '', receivedAt: starts[i] },
        0,
      );
      states.set(i, s);
      balances.set(i, new Map());
    }
    return s;
  };

  let rowsOut = 0;
  for (const [time, kind, i, payload] of events) {
    if (kind === TRADE) {
      const t = tokens[i];
      const [slot, , , wallet, isBuy, sol, tok, vSol, vTokens] = t.trades[payload];
      const s = stateFor(i);
      const bal = balances.get(i)!;
      const next = Math.max(0, (bal.get(wallet) ?? 0) + (isBuy ? tok : -tok));
      bal.set(wallet, next);
      s.applyTrade(
        { mint: t.mint, wallet, isBuy: isBuy === 1, tokens: tok, sol, newBalance: next, vTokens, vSol,
          mcapSol: vTokens > 0 ? (vSol / vTokens) * 1_000_000_000 : 0, signature: '', receivedAt: time,
          slot, launchSlot: t.createSlot ?? undefined },
        plan,
      );
    } else if (kind === SNAPSHOT) {
      const f = computeFeatures(stateFor(i), time, ctx);
      const out: Record<string, number | string> = { mint: tokens[i].mint, ageSec: payload, bookSize: book.size };
      for (const k of INTEL_KEYS) out[k] = Math.round(f[k] * 1000) / 1000;
      appendJsonl(FEATURES_FILE, out);
      rowsOut++;
    } else {
      const s = states.get(i);
      if (s) book.recordToken(s, time);
      states.delete(i);
      balances.delete(i);
    }
  }
  book.save();
  console.log(`wrote ${rowsOut} snapshot rows to ${FEATURES_FILE}; wallet book ${book.size} wallets → ${WALLETS_FILE}`);
}

const cmd = process.argv[2];
if (cmd === 'fetch') await fetchAll();
else if (cmd === 'replay') replay();
else {
  console.error('usage: npm run backfill -- fetch | replay');
  process.exit(1);
}
