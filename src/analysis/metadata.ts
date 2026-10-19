import type { TokenMetadata } from '../types.js';
import { fetchJson } from '../utils/http.js';
import { RateLimiter } from '../utils/limiter.js';

const limiter = new RateLimiter(3, 5);

/** Metadata URIs are creator-controlled: only fetch public https hosts, never IPs or localhost. */
function safeUrl(uri: string): string | null {
  const raw = uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    const h = u.hostname;
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return null;
    if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return null; // IP literals
    return u.toString();
  } catch {
    return null;
  }
}

function link(v: unknown, allow: RegExp): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!/^https:\/\//i.test(s) || s.length > 200) return undefined;
  return allow.test(s) ? s : undefined;
}

export async function fetchMetadata(uri: string): Promise<TokenMetadata | null> {
  const url = safeUrl(uri);
  if (!url) return null;
  const r = await fetchJson<Record<string, unknown>>(url, { limiter, timeoutMs: 5000, retries: 0 });
  if (!r.ok || !r.data || typeof r.data !== 'object') return null;
  return {
    twitter: link(r.data.twitter, /^https:\/\/(www\.)?(x|twitter)\.com\//i),
    telegram: link(r.data.telegram, /^https:\/\/(www\.)?t\.me\//i),
    website: link(r.data.website, /^https:\/\//i),
  };
}
