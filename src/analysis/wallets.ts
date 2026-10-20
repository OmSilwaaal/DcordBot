import { config } from '../config.js';
import type { WalletAnalysis } from '../types.js';
import { log } from '../utils/logger.js';
import { rpc } from './onchain.js';
import { PUMP } from './features.js';

interface WalletFacts {
  /** Full history fit in the fetch window → first-seen and funder are trustworthy. */
  complete: boolean;
  firstSeen: number | null;
  txCount: number;
  funder: string | null;
  at: number;
}

const factCache = new Map<string, WalletFacts>();
const busyCache = new Map<string, boolean>();
const resultCache = new Map<string, { at: number; res: WalletAnalysis }>();
const FACT_TTL = 6 * 3_600_000;

function remember<K, V>(m: Map<K, V>, k: K, v: V, cap = 50_000): void {
  m.set(k, v);
  if (m.size > cap) m.delete(m.keys().next().value as K);
}

interface Sig {
  signature: string;
  blockTime: number | null;
}

interface ParsedIx {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}

interface ParsedTx {
  transaction?: {
    message?: { accountKeys?: ({ pubkey: string } | string)[]; instructions?: ParsedIx[] };
  };
  meta?: { innerInstructions?: { instructions?: ParsedIx[] }[] };
}

/** Who sent this wallet its first SOL: the source of a system transfer into it, else the fee payer. */
function findFunder(tx: ParsedTx | null, wallet: string): string | null {
  if (!tx?.transaction?.message) return null;
  const ixs: ParsedIx[] = [
    ...(tx.transaction.message.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? []),
  ];
  for (const ix of ixs) {
    if (ix.program !== 'system' || !ix.parsed?.info) continue;
    const info = ix.parsed.info;
    const into = info.destination === wallet || info.newAccount === wallet;
    if (into && typeof info.source === 'string') return info.source;
  }
  const payer = tx.transaction.message.accountKeys?.[0];
  const key = typeof payer === 'string' ? payer : payer?.pubkey;
  return key && key !== wallet ? key : null;
}

async function walletFacts(wallet: string): Promise<WalletFacts> {
  const hit = factCache.get(wallet);
  if (hit && Date.now() - hit.at < FACT_TTL) return hit;

  const limit = config.wallets.historyLimit;
  const sigs = await rpc<Sig[]>('getSignaturesForAddress', [wallet, { limit, commitment: 'confirmed' }]);
  const complete = sigs.length < limit;
  const oldest = sigs[sigs.length - 1];
  let funder: string | null = null;
  if (complete && oldest) {
    const tx = await rpc<ParsedTx | null>('getTransaction', [
      oldest.signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ]);
    funder = findFunder(tx, wallet);
  }
  const facts: WalletFacts = {
    complete,
    firstSeen: complete && oldest?.blockTime ? oldest.blockTime * 1000 : null,
    txCount: sigs.length,
    funder,
    at: Date.now(),
  };
  remember(factCache, wallet, facts);
  return facts;
}

/** Exchanges and services fund thousands of wallets; sharing one of them isn't a cluster. */
async function isBusy(addr: string): Promise<boolean> {
  const hit = busyCache.get(addr);
  if (hit !== undefined) return hit;
  const lim = config.wallets.busyFunderTxs;
  const sigs = await rpc<Sig[]>('getSignaturesForAddress', [addr, { limit: lim, commitment: 'confirmed' }]);
  const busy = sigs.length >= lim;
  remember(busyCache, addr, busy, 10_000);
  return busy;
}

/**
 * Early-buyer forensics on a sample of top holders + earliest buyers:
 *  - fresh wallets (created hours before buying) → likely one actor with many wallets
 *  - funding clusters (several buyers funded by the same wallet) → bundles that fake "unique buyers"
 *  - buyers funded by the creator → dev buying their own token through side wallets
 */
export async function analyzeWallets(
  mint: string,
  sample: string[],
  creator: string,
  balances: Map<string, number>,
): Promise<WalletAnalysis> {
  const hit = resultCache.get(mint);
  if (hit && Date.now() - hit.at < 180_000) return hit.res;

  const empty: WalletAnalysis = {
    ok: false, sampled: 0, freshPct: 0, lowActivityPct: 0, clusters: 0, largestCluster: 0,
    clusterWallets: 0, clusterHoldPct: 0, devFundedBuyers: 0,
  };
  if (!sample.length) return { ...empty, ok: true };

  const settled = await Promise.allSettled(sample.map((w) => walletFacts(w)));
  const facts = new Map<string, WalletFacts>();
  settled.forEach((r, i) => r.status === 'fulfilled' && facts.set(sample[i], r.value));
  if (facts.size < Math.ceil(sample.length / 2)) {
    const err = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason;
    return { ...empty, error: `only ${facts.size}/${sample.length} wallets readable: ${err instanceof Error ? err.message : err}` };
  }

  const now = Date.now();
  const freshMs = config.wallets.freshHours * 3_600_000;
  let fresh = 0;
  let low = 0;
  let devFunded = 0;
  const byFunder = new Map<string, string[]>();
  for (const [w, f] of facts) {
    if (f.firstSeen !== null && now - f.firstSeen < freshMs) fresh++;
    if (f.complete && f.txCount < 10) low++;
    if (!f.funder) continue;
    if (f.funder === creator) devFunded++;
    byFunder.set(f.funder, [...(byFunder.get(f.funder) ?? []), w]);
  }

  const clusterWallets = new Set<string>();
  let clusters = 0;
  let largest = 0;
  for (const [funder, ws] of byFunder) {
    if (ws.length < 2) continue;
    try {
      if (await isBusy(funder)) continue;
    } catch (e) {
      log.debug(`[wallets] busy check failed for ${funder}`, e);
      continue;
    }
    clusters++;
    largest = Math.max(largest, ws.length);
    ws.forEach((w) => clusterWallets.add(w));
  }
  let clusterTokens = 0;
  for (const w of clusterWallets) clusterTokens += balances.get(w) ?? 0;

  const n = facts.size;
  const res: WalletAnalysis = {
    ok: true,
    sampled: n,
    freshPct: (fresh / n) * 100,
    lowActivityPct: (low / n) * 100,
    clusters,
    largestCluster: largest,
    clusterWallets: clusterWallets.size,
    clusterHoldPct: (clusterTokens / PUMP.TOTAL_SUPPLY) * 100,
    devFundedBuyers: devFunded,
  };
  remember(resultCache, mint, { at: Date.now(), res }, 5_000);
  return res;
}
