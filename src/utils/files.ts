import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');

export function ensureDir(dir = DATA_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
}

export const dataPath = (name: string): string => path.join(DATA_DIR, name);

/** data/<prefix>-YYYY-MM-DD.jsonl (UTC) — keeps any single file from growing forever. */
export const dailyFile = (prefix: string): string =>
  dataPath(`${prefix}-${new Date().toISOString().slice(0, 10)}.jsonl`);

export function appendJsonl(file: string, obj: unknown): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip a torn line from a crash mid-write */
    }
  }
  return out;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Write-then-rename so a crash never leaves a half-written state file. */
export function writeJsonAtomic(file: string, obj: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

export function listDataFiles(prefix: string): string[] {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'))
    .sort()
    .map((f) => path.join(DATA_DIR, f));
}
