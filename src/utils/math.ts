export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export const sum = (xs: Iterable<number>): number => {
  let s = 0;
  for (const x of xs) s += x;
  return s;
};

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Coerce PumpPortal / API numeric fields that may arrive as strings. */
export function num(x: unknown): number {
  const v = typeof x === 'string' ? Number(x) : (x as number);
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
