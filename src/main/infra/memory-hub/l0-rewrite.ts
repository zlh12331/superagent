// src/main/infra/memory-hub/l0-rewrite.ts
// L0 审计镜像 JSONL 行移除（从 memory-hub-service 抽出：异步批量 IO）
// ──────────────────────────────────────────────────────────────
// 背景：引擎把 L0 同时落 SQLite（权威）与 JSONL（可 grep 的审计镜像）。
//   会话清除后需同步移除 JSONL 中该会话的行，否则 UI 列表残留造成"假清空"。
// 抽取理由：这是纯数据改写逻辑，与 sidecar 生命周期管理无关；留在
//   MemoryHubService 内会推高其体积（file-size 棘轮）。
// 性能说明（P2-26）：此前 readdirSync + readFileSync 全目录同步读 + writeFileSync
//   全量重写，期间事件循环完全停摆；改为 fs.promises 异步形态（对齐同目录
//   l0-inspect.ts 的读路径），只让 IO 等待。clearAll 的 N 个 key 合并为单遍
//   扫描一次重写（原每 key 一次全扫全量重写）。
// ──────────────────────────────────────────────────────────────

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
  // 匹配语义与原实现一致：key 原样参与比较，仅空白 key 不参与（原入口早退 0）
  const keys = new Set(sessionKeys.filter((key) => key.trim().length > 0));
  const dir = conversationsDir(dataDir);
  if (keys.size === 0 || !existsSync(dir)) {
    return 0;
  }
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return 0; // 目录读取失败（权限等）跳过
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
    return 0; // 文件读取失败（占用/权限）跳过
  }
  const kept: string[] = [];
  let removed = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    try {
      const rec = JSON.parse(raw) as Record<string, unknown>;
      // 上游 JSONL 镜像字段双格式（camelCase sessionKey / snake_case session_id），
      // 索引访问绕过属性命名规则（字段来自上游数据，非本地 API）
      const hit = [rec['sessionKey'], rec['session_id']].some(
        (value) => typeof value === 'string' && keys.has(value),
      );
      if (hit) {
        removed += 1;
        continue; // 丢弃该会话的行
      }
      kept.push(raw);
    } catch {
      kept.push(raw); // 损坏行保留（不因清理误伤）
    }
  }
  if (removed === 0) {
    return 0; // 无命中不重写（省一次全文件写；记录层面与重写等价）
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
    } catch {
      // tmp 清理失败不阻断
    }
  }
  return removed;
}
