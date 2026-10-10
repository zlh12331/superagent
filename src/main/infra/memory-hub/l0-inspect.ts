// l0-inspect.ts：L0 JSONL 审计镜像的只读检视——会话目录定位、记录计数、键枚举（IPC status 消费）
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** L0 对话目录（引擎数据根下的 data/conversations） */
export function conversationsDir(dataDir: string): string {
  return join(dataDir, 'data', 'conversations');
}

async function readAllJsonl(dir: string): Promise<(string | null)[]> {
  if (!existsSync(dir)) {
    return [];
  }
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  return Promise.all(
    files.map(async (file) => {
      try {
        return await readFile(join(dir, file), 'utf8');
      } catch {
        return null;
      }
    }),
  );
}

function forEachRecord(
  texts: readonly (string | null)[],
  visit: (rec: Record<string, unknown>) => void,
): void {
  for (const text of texts) {
    if (text === null) continue;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      try {
        visit(JSON.parse(line) as Record<string, unknown>);
      } catch {}
    }
  }
}

function sessionKeyOf(rec: Record<string, unknown>): string | null {
  const key = rec['sessionKey'];
  return typeof key === 'string' && key.length > 0 ? key : null;
}

function collectSessionKeys(texts: readonly (string | null)[]): Set<string> {
  const keys = new Set<string>();
  forEachRecord(texts, (rec) => {
    const key = sessionKeyOf(rec);
    if (key !== null) keys.add(key);
  });
  return keys;
}

export interface L0Line {
  readonly role: string;
  readonly content: string;
  readonly timestamp: number;
}

export async function readSessionRecords(
  dataDir: string,
  sessionKey: string,
  limit: number,
): Promise<L0Line[]> {
  const texts = await readAllJsonl(conversationsDir(dataDir));
  const records: L0Line[] = [];
  forEachRecord(texts, (rec) => {
    if (sessionKeyOf(rec) !== sessionKey) return;
    records.push({
      role: typeof rec['role'] === 'string' ? rec['role'] : 'unknown',
      content: typeof rec['content'] === 'string' ? rec['content'] : '',
      timestamp: typeof rec['timestamp'] === 'number' ? rec['timestamp'] : 0,
    });
  });
  records.sort((a, b) => a.timestamp - b.timestamp);
  return records.slice(-limit);
}

export async function countL0Records(
  dataDir: string,
): Promise<{ sessionCount: number; recordCount: number }> {
  const texts = await readAllJsonl(conversationsDir(dataDir));
  let recordCount = 0;
  forEachRecord(texts, (rec) => {
    if (sessionKeyOf(rec) !== null) recordCount += 1;
  });
  return { sessionCount: collectSessionKeys(texts).size, recordCount };
}

export async function listL0SessionKeys(dataDir: string): Promise<string[]> {
  return [...collectSessionKeys(await readAllJsonl(conversationsDir(dataDir)))];
}
