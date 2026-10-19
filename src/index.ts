import { config } from './config.js';
import { DiscordNotifier } from './discord/bot.js';
import { PumpPortalFeed } from './feeds/pumpportal.js';
import { SolPriceFeed } from './feeds/solPrice.js';
import { SignalEngine } from './signals/engine.js';
import { PerformanceTracker } from './signals/performance.js';
import { ensureDir } from './utils/files.js';
import { startHealthServer } from './utils/health.js';
import { log } from './utils/logger.js';

async function main(): Promise<void> {
  ensureDir();
  log.info('meme-signal-discord v2 starting');

  const sol = new SolPriceFeed();
  await sol.start();
  log.info(`[sol] $${sol.value?.toFixed(2) ?? 'unknown (will retry)'}`);

  const perf = new PerformanceTracker();
  const discord = new DiscordNotifier(perf);
  await discord.start();

  const feed = new PumpPortalFeed(config.feeds.pumpPortalWs, config.feeds.allowedPools);
  const engine = new SignalEngine(feed, sol, perf, discord);
  perf.on('finalized', (r) => void discord.updateSignal(r));
  engine.start();
  feed.start();

  startHealthServer(config.healthPort, () => ({
    websocket: feed.connected ? 'up' : 'down',
    tracked: engine.tracker.size,
    subscriptions: feed.subscriptionCount,
    forwardTesting: perf.active.size,
    solUsd: sol.value,
    ...engine.stats,
  }));

  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down…');
    engine.stop();
    feed.stop();
    sol.stop();
    perf.markDirty();
    perf.save();
    await discord.stop().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  // State is persisted, so crash → save → let pm2/Docker restart us cleanly
  // instead of limping on in an unknown state.
  process.on('uncaughtException', (e) => {
    log.error('uncaught exception', e.stack ?? e);
    void shutdown(1);
  });
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));
}

main().catch((e) => {
  log.error('fatal', e);
  process.exit(1);
});
