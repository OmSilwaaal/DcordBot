import type { PathPoint } from '../types.js';

export const PATH_BUCKET_SEC = 15;

const round = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * Folds one price observation into a [sec, low, high, close] path of fixed-width buckets.
 * Buckets only exist where trades happened, so a dead token costs almost nothing to store.
 */
export function pushPath(path: PathPoint[], elapsedSec: number, value: number): void {
  if (!(value > 0) || elapsedSec < 0) return;
  const sec = Math.floor(elapsedSec / PATH_BUCKET_SEC) * PATH_BUCKET_SEC;
  const v = round(value);
  const last = path[path.length - 1];
  if (last && last[0] === sec) {
    if (v < last[1]) last[1] = v;
    if (v > last[2]) last[2] = v;
    last[3] = v;
  } else {
    path.push([sec, v, v, v]);
  }
}
