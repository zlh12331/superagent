import { existsSync } from 'node:fs';
import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { logger } from '../../utils/logger';
import { conversationsDir } from './l0-inspect';

/**
 * 单遍扫描移除 JSONL 中命中任一会话 key 的行（原子写：临时文件 + rename）
 *
 * 单 key 清除（memory:clear）与批量清除（memory:clearAll）共用本实现：
 * 批量传入全部 key，目录只扫描一次、每个文件至多重写一次。
 *
 * @param dataDir 引擎数据目录
 * @param sessionKeys 待移除的会话 key（空白 key 忽略）
 * @returns 移除的行数
 */
export async function removeSessionLinesFromJsonl(
  dataDir: string,
  sessionKeys: readonly string[],
): Promise<number> {
  const keys = new Set(sessionKeys.filter((key) => key.trim().length > 0));
  const dir = conversationsDir(dataDir);
  if (keys.size === 0 || !existsSync(dir)) {
    return 0;
  }
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const file of files) {
    removed += await removeSessionLinesInFile(join(dir, file), file, keys);
  }
  return removed;
}

/** 移除单个 JSONL 文件中命中会话 key 的行（读取失败跳过；写回失败保留原文件） */
async function removeSessionLinesInFile(
  filePath: string,
  file: string,
  keys: ReadonlySet<string>,
): Promise<number> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return 0;
  }
  const kept: string[] = [];
  let removed = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    try {
      const rec = JSON.parse(raw) as Record<string, unknown>;
      const hit = [rec['sessionKey'], rec['session_id']].some(
        (value) => typeof value === 'string' && keys.has(value),
      );
      if (hit) {
        removed += 1;
        continue;
      }
      kept.push(raw);
    } catch {
      kept.push(raw);
    }
  }
  if (removed === 0) {
    return 0;
  }
  const keptText = kept.length > 0 ? `${kept.join('\n')}\n` : '';
  const tmpPath = `${filePath}.tmp`;
  try {
    await writeFile(tmpPath, keptText, 'utf8');
    await rename(tmpPath, filePath);
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error), file },
      '[memory-hub] JSONL 清理写回失败（保留原文件）',
    );
    try {
      await unlink(tmpPath);
    } catch {}
  }
  return removed;
}
