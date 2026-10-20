import { config } from '../config.js';
import { onchainCheck } from '../analysis/onchain.js';
import { rugcheck } from '../analysis/rugcheck.js';
import { xUsage } from '../analysis/xMentions.js';
import { getPairs, WSOL } from '../feeds/dexscreener.js';
import type { PumpPortalFeed } from '../feeds/pumpportal.js';
import type { SolPriceFeed } from '../feeds/solPrice.js';
import type { Features } from '../types.js';
import { assertWritable, DATA_DIR } from '../utils/files.js';
import type { SignalEngine } from './engine.js';
import type { PerformanceTracker } from './performance.js';

export interface Check {
  name: string;
  /** true = ok, false = broken, null = warning / not testable yet */
  ok: boolean | null;
  detail: string;
}

export interface DiagReport {
  checks: Check[];
  candidates: { symbol: string; mint: string; score: number; f: Features; reason: string }[];
  uptimeMin: number;
  stats: SignalEngine['stats'];
  forwardTesting: number;
}

const ago = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60_000)}m ago`);

/**
 * Live end-to-end self-test. Every external dependency is actually called,
 * using a real token the bot is tracking right now — not a mock.
 */
export async function runDiagnostics(
  engine: SignalEngine,
  feed: PumpPortalFeed,
  sol: SolPriceFeed,
  perf: PerformanceTracker,
): Promise<DiagReport> {
  const now = Date.now();
  const checks: Check[] = [];

  // 1. Live launch feed
  const silentFor = feed.lastMessageAt ? now - feed.lastMessageAt : Infinity;
  checks.push({
    name: 'PumpPortal feed',
    ok: feed.connected && silentFor < 30_000,
    detail: feed.connected
      ? `connected · last message ${ago(silentFor)} · ${feed.subscriptionCount} trade subscriptions`
      : 'DISCONNECTED — reconnecting with backoff (check logs)',
  });
  const launches = engine.launchesLast5m(now);
  checks.push({
    name: 'Launch flow',
    ok: launches > 0 ? true : feed.connected ? null : false,
    detail: `${launches} new pump.fun tokens in the last 5m · tracking ${engine.tracker.size}`,
  });

  // Launches without trades means every token looks dead and nothing can ever signal.
  const chain = feed.tradeSource;
  const trades = engine.stats.trades;
  const starved = trades === 0 && launches > 0 && now - engine.startedAt > 120_000;
  checks.push({
    name: 'Trade stream',
    ok: chain && !chain.connected ? false : starved ? false : trades > 0 ? true : null,
    detail: chain
      ? `Solana logs · ${chain.connected ? `${chain.connectedCount} sockets up · last message ${ago(now - chain.lastMessageAt)}` : 'DISCONNECTED — reconnecting'}` +
        ` · ${chain.tradesSeen} pump.fun trades decoded · ${trades} on tracked tokens`
      : starved
        ? '0 trades — PumpPortal trade data needs a funded API key in PUMPPORTAL_WS, or set TRADE_SOURCE=chain'
        : `PumpPortal · ${trades} trades on tracked tokens`,
  });

  // 2. SOL price
  checks.push({
    name: 'SOL price',
    ok: sol.value !== null && now - sol.updatedAt < 5 * 60_000,
    detail: sol.value ? `$${sol.value.toFixed(2)} · updated ${ago(now - sol.updatedAt)}` : 'no price yet (CoinGecko + DexScreener both failed)',
  });

  // 3–5. External APIs, exercised on a real tracked token where possible
  const probe = engine.probeToken(now);
  const [oc, rc, dex] = await Promise.all([
    probe ? onchainCheck(probe.mint, probe.bondingCurveKey) : Promise.resolve(null),
    probe ? rugcheck(probe.mint) : Promise.resolve(null),
    getPairs([WSOL]).then((p) => p.length).catch(() => 0),
  ]);

  checks.push(
    !probe
      ? { name: 'Solana RPC', ok: null, detail: 'no token old enough to test yet — try again in a minute' }
      : oc!.ok
        ? {
            name: 'Solana RPC',
            ok: true,
            detail: `holder check worked on $${probe.symbol} · on-chain top10 ${oc!.top10Pct.toFixed(1)}%`,
          }
        : {
            name: 'Solana RPC',
            ok: false,
            detail: `holder check FAILED: ${oc!.error}${
              /not.*(support|available)|method/i.test(oc!.error ?? '') ? ' → use a Helius/QuickNode URL' : ''
            }${config.gates.requireOnchain ? ' · signals are blocked until this works' : ''}`,
          },
  );
  checks.push(
    !rc
      ? { name: 'RugCheck', ok: null, detail: 'waiting for a token to test' }
      : {
          name: 'RugCheck',
          ok: rc.status === 'ok' || rc.status === 'not_found' ? true : null,
          detail:
            rc.status === 'unavailable'
              ? `unreachable — fine, it's optional${config.gates.requireRugcheck ? ' (but REQUIRE_RUGCHECK=true blocks signals)' : ''}`
              : `reachable (${rc.status})`,
        },
  );
  checks.push({
    name: 'DexScreener',
    ok: dex > 0,
    detail: dex > 0 ? 'reachable' : 'unreachable — outcome tracking after graduation will lag',
  });

  const xu = xUsage();
  checks.push({
    name: 'X mentions',
    ok: xu.mode === 'off' ? null : xu.pausedMin > 0 ? false : xu.lastError ? null : true,
    detail:
      xu.mode === 'off'
        ? 'off (set X_BEARER_TOKEN for the official API or X_SCRAPE_API_KEY for scraping)'
        : `${xu.mode} · ${xu.callsToday}/${xu.cap} searches today` +
          (xu.pausedMin > 0 ? ` · PAUSED ${xu.pausedMin.toFixed(0)}m: ${xu.lastError}` : xu.lastError ? ` · last error: ${xu.lastError}` : ''),
  });
  checks.push({
    name: 'Creator history',
    ok: true,
    detail: `${engine.creators.size} creator wallets on record${config.wallets.enabled ? ' · wallet forensics on' : ' · wallet forensics OFF'}`,
  });

  // 6. Persistent storage
  let storage: Check;
  try {
    assertWritable();
    const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    storage = {
      name: 'Storage',
      ok: vol ? true : null,
      detail: vol
        ? `${DATA_DIR} writable · Railway volume at ${vol}`
        : `${DATA_DIR} writable · no Railway volume detected — data is lost on redeploy`,
    };
  } catch (e) {
    storage = { name: 'Storage', ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  checks.push(storage);

  return {
    checks,
    candidates: engine.topCandidates(5, now),
    uptimeMin: (now - engine.startedAt) / 60_000,
    stats: { ...engine.stats },
    forwardTesting: perf.active.size,
  };
}
