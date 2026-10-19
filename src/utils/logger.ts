type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = ORDER[(process.env.LOG_LEVEL || 'info').toLowerCase() as Level] ?? ORDER.info;

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function out(level: Level, msg: string, extra?: unknown): void {
  if (ORDER[level] < MIN) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra === undefined) fn(line);
  else fn(line, extra instanceof Error ? extra.message : extra);
}

export const log = {
  debug: (msg: string, extra?: unknown) => out('debug', msg, extra),
  info: (msg: string, extra?: unknown) => out('info', msg, extra),
  warn: (msg: string, extra?: unknown) => out('warn', msg, extra),
  error: (msg: string, extra?: unknown) => out('error', msg, extra),
};
