import { config } from '../config.js';
import type { XMentions } from '../types.js';
import { fetchJson } from '../utils/http.js';
import { RateLimiter } from '../utils/limiter.js';
import { log } from '../utils/logger.js';
import { median } from '../utils/math.js';

/**
 * Posts in the last ~7 days containing the token's contract address.
 * Searching the CA (not the ticker) avoids matching every other $PEPE.
 *
 * Two interchangeable sources behind one function:
 *  - api:    official X API, billed per post and per user returned
 *  - scrape: rettiwt-api using a logged-in X account's session — free, but against X's
 *            terms. Use a throwaway account; it can be rate-limited or suspended at any time.
 */

const limiter = new RateLimiter(0.2, 1); // ≤1 search / 5s — gentle on both the bill and the account
const cache = new Map<string, { at: number; res: XMentions }>();
let day = '';
let callsToday = 0;
let consecutiveFailures = 0;
let pausedUntil = 0;
let lastError = '';

interface Author {
  id: string;
  followers: number;
  createdAt: number | null;
}

export function xUsage() {
  return {
    mode: config.x.mode,
    callsToday,
    cap: config.x.maxCallsPerDay,
    pausedMin: Math.max(0, (pausedUntil - Date.now()) / 60_000),
    lastError,
  };
}

const skip = (reason: string): XMentions => ({
  ok: false, skipped: reason, posts: 0, capped: false, authors: 0, medianFollowers: 0, newAccountPct: 0,
});

function summarize(posts: number, max: number, authors: Author[]): XMentions {
  const now = Date.now();
  const unique = new Map(authors.map((a) => [a.id, a]));
  const users = [...unique.values()];
  return {
    ok: true,
    posts,
    capped: posts >= max,
    authors: users.length,
    medianFollowers: median(users.map((u) => u.followers)),
    newAccountPct: users.length
      ? (users.filter((u) => u.createdAt !== null && now - u.createdAt < 30 * 86_400_000).length / users.length) * 100
      : 0,
  };
}

// ── official API ─────────────────────────────────────────────────────

interface SearchResp {
  data?: { id: string; author_id?: string }[];
  includes?: { users?: { id: string; created_at?: string; public_metrics?: { followers_count?: number } }[] };
  meta?: { result_count?: number };
}

async function viaApi(mint: string, max: number): Promise<XMentions> {
  const q = new URLSearchParams({
    query: `${mint} -is:retweet`,
    max_results: String(Math.min(100, Math.max(10, max))),
    expansions: 'author_id',
    'user.fields': 'created_at,public_metrics',
  });
  const r = await fetchJson<SearchResp>(`https://api.x.com/2/tweets/search/recent?${q}`, {
    limiter,
    retries: 0,
    timeoutMs: 8000,
    headers: { Authorization: `Bearer ${config.x.bearerToken}` },
  });
  if (!r.ok || !r.data) throw new Error(`X API ${r.error ?? 'error'}`);
  const users = r.data.includes?.users ?? [];
  return summarize(
    r.data.meta?.result_count ?? r.data.data?.length ?? 0,
    max,
    users.map((u) => ({
      id: u.id,
      followers: u.public_metrics?.followers_count ?? 0,
      createdAt: u.created_at ? Date.parse(u.created_at) : null,
    })),
  );
}

// ── scrape (rettiwt-api) ─────────────────────────────────────────────

type RettiwtLike = {
  tweet: {
    search: (
      filter: { includeWords?: string[]; onlyOriginal?: boolean },
      count?: number,
    ) => Promise<{ list: { tweetBy?: { id: string; followersCount?: number; createdAt?: string } }[] }>;
  };
};
let scraper: RettiwtLike | null = null;

async function getScraper(): Promise<RettiwtLike> {
  if (scraper) return scraper;
  if (!config.x.scrapeApiKey) throw new Error('X_SCRAPE_API_KEY not set');
  // Lazy-loaded so the dependency only matters when scrape mode is on.
  const { Rettiwt } = await import('rettiwt-api');
  try {
    scraper = new Rettiwt({
      apiKey: config.x.scrapeApiKey,
      timeout: 10_000,
      maxRetries: 0,
      ...(config.x.scrapeProxy ? { proxy: config.x.scrapeProxy } : {}),
    }) as unknown as RettiwtLike;
  } catch (e) {
    throw new Error(`X_SCRAPE_API_KEY rejected (${e instanceof Error ? e.message : e}) — regenerate it from the logged-in account`);
  }
  return scraper;
}

async function viaScrape(mint: string, max: number): Promise<XMentions> {
  const client = await getScraper();
  await limiter.take();
  const res = await client.tweet.search({ includeWords: [mint], onlyOriginal: true }, Math.min(20, Math.max(1, max)));
  const list = res?.list ?? [];
  return summarize(
    list.length,
    max,
    list
      .filter((t) => t.tweetBy?.id)
      .map((t) => ({
        id: t.tweetBy!.id,
        followers: t.tweetBy!.followersCount ?? 0,
        createdAt: t.tweetBy!.createdAt ? Date.parse(t.tweetBy!.createdAt) : null,
      })),
  );
}

// ── entry point ──────────────────────────────────────────────────────

export async function xMentions(mint: string): Promise<XMentions> {
  if (config.x.mode === 'off') return skip('X off');
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.res;
  if (Date.now() < pausedUntil) return skip(`paused after errors: ${lastError}`);

  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    callsToday = 0;
  }
  if (callsToday >= config.x.maxCallsPerDay) return skip('daily X budget used');
  callsToday++;

  try {
    const res = config.x.mode === 'api' ? await viaApi(mint, config.x.maxResults) : await viaScrape(mint, config.x.maxResults);
    consecutiveFailures = 0;
    lastError = '';
    cache.set(mint, { at: Date.now(), res });
    if (cache.size > 2000) cache.delete(cache.keys().next().value!);
    return res;
  } catch (e) {
    lastError = (e instanceof Error ? e.message : String(e)).slice(0, 160);
    consecutiveFailures++;
    // Back off hard after repeated failures: hammering a limited account is how it gets suspended.
    if (consecutiveFailures >= 3) {
      pausedUntil = Date.now() + Math.min(6 * 60, 15 * 2 ** (consecutiveFailures - 3)) * 60_000;
      log.warn(`[x] ${consecutiveFailures} failures in a row, pausing until ${new Date(pausedUntil).toISOString()}: ${lastError}`);
    }
    return skip(lastError);
  }
}
