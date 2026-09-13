// src/main/infra/memory-hub/l0-inspect.ts
// L0 审计镜像只读检查（从 memory-hub-service 抽出：统计/枚举会话）
// ──────────────────────────────────────────────────────────────
// 背景：引擎把 L0 同时落 SQLite（权威）与 JSONL（可 grep 的审计镜像）。
//   设置页需要"已记录多少"与"清空全部"的会话枚举，这两件事都只读审计镜像、
//   不触发引擎启动（打开设置页不应有启动 sidecar 的副作用）。
// 抽取理由：这些是纯数据检查逻辑，与 sidecar 生命周期管理无关；留在
//   MemoryHubService 内会推高其认知复杂度（超过棘轮门槛）。
// ──────────────────────────────────────────────────────────────

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** L0 审计镜像目录（相对 dataDir） */
export function conversationsDir(dataDir: string): string {
  return join(dataDir, 'data', 'conversations');
}

/**
 * 并发读取审计镜像的全部 JSONL 文本
 *
 * 性能说明：此前用 readdirSync + readFileSync 全目录全文件同步读，期间事件循环
 *   完全停摆（10MB JSONL ≈ 30–60ms 阻塞）；改为 fs.promises 并发读，只让 IO 等待。
 */
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

/** 遍历全部 JSONL 行，对每个成功解析的行调用 visit（损坏行跳过） */
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
      } catch {
        // 跳过损坏行（审计镜像容忍脏数据）
      }
    }
  }
}

/** 从一条记录提取非空 sessionKey（无则 null） */
function sessionKeyOf(rec: Record<string, unknown>): string | null {
  const key = rec['sessionKey'];
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/** 从全部 JSONL 文本中提取出现的会话 key（去重） */
function collectSessionKeys(texts: readonly (string | null)[]): Set<string> {
  const keys = new Set<string>();
  forEachRecord(texts, (rec) => {
    const key = sessionKeyOf(rec);
    if (key !== null) keys.add(key);
  });
  return keys;
}

/** 按会话读取 L0 记录（只读审计镜像；不触发引擎启动） */
export interface L0Line {
  readonly role: string;
  readonly content: string;
  readonly timestamp: number;
}

/** 某会话的全部 L0 记录（按时间升序） */
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

/** 统计既有记忆数据（会话数 + 记录数；只读审计镜像） */
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

/** 列出审计镜像中的全部会话 key（"清空全部"枚举用） */
export async function listL0SessionKeys(dataDir: string): Promise<string[]> {
  return [...collectSessionKeys(await readAllJsonl(conversationsDir(dataDir)))];
}
