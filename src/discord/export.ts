import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { AttachmentBuilder } from 'discord.js';
import { DATA_DIR } from '../utils/files.js';

/** Discord caps a message's attachments (10 MB on most servers); leave headroom. */
const BUDGET = 8 * 1024 * 1024;

/** Files worth analysing, most important first. Dataset/skins files are newest-first. */
function candidates(): string[] {
  if (!fs.existsSync(DATA_DIR)) return [];
  const all = fs.readdirSync(DATA_DIR);
  const newestFirst = (prefix: string) =>
    all
      .filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'))
      .sort()
      .reverse();
  return [
    ...all.filter((f) => f === 'signals.jsonl'),
    ...newestFirst('dataset-'),
    ...newestFirst('skins-alerts-'),
    ...newestFirst('skins-outcomes-'),
  ];
}

export interface ExportResult {
  files: AttachmentBuilder[];
  summary: string;
}

/** Gzips data files into attachments until the size budget is used; reports what didn't fit. */
export function buildExport(): ExportResult {
  const files: AttachmentBuilder[] = [];
  const skipped: string[] = [];
  let used = 0;
  const names = candidates();
  for (const name of names) {
    const raw = fs.readFileSync(path.join(DATA_DIR, name));
    const gz = zlib.gzipSync(raw);
    if (used + gz.length > BUDGET) {
      skipped.push(`${name} (${(gz.length / 1024).toFixed(0)} KB gz)`);
      continue;
    }
    used += gz.length;
    files.push(new AttachmentBuilder(gz, { name: `${name}.gz` }));
  }
  const summary = names.length
    ? `Attached ${files.length}/${names.length} file(s), ${(used / 1024).toFixed(0)} KB gzipped.` +
      (skipped.length ? `\nDidn't fit (run /export again later or fetch another way): ${skipped.join(', ')}` : '')
    : `No data files in ${DATA_DIR} yet.`;
  return { files, summary };
}
