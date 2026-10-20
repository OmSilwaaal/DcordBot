import { RateLimiter } from './limiter.js';
import { sleep } from './math.js';

export interface HttpResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

interface Opts {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  limiter?: RateLimiter;
  headers?: Record<string, string>;
}

/**
 * JSON fetch that always reports what happened (status + error) instead of
 * collapsing failures into a boolean. Callers decide whether a failure means
 * "reject", "retry later" or "unknown" — nothing here fails open.
 */
export async function fetchJson<T>(url: string, opts: Opts = {}): Promise<HttpResult<T>> {
  const { method = 'GET', body, timeoutMs = 8000, retries = 1, limiter, headers = {} } = opts;
  let last: HttpResult<T> = { ok: false, status: 0, data: null, error: 'not attempted' };

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (limiter) await limiter.take();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        signal: ctrl.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'meme-signal-discord/2.0',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429) {
        limiter?.pause(5000);
        last = { ok: false, status: 429, data: null, error: 'rate limited' };
      } else if (!res.ok) {
        last = { ok: false, status: res.status, data: null, error: `HTTP ${res.status}` };
        if (res.status < 500) return last; // 4xx won't fix itself on retry
      } else {
        return { ok: true, status: res.status, data: (await res.json()) as T };
      }
    } catch (e) {
      last = { ok: false, status: 0, data: null, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(500 * 2 ** attempt + Math.random() * 250);
  }
  return last;
}
