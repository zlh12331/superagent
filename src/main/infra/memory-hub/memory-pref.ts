// src/main/infra/memory-hub/memory-pref.ts
// 记忆功能用户开关（settings.memory.enabled，SQLite 单一真源）
// ──────────────────────────────────────────────────────────────
// 语义（与设置页文案一致）：
// - enabled=false：不捕获新记忆（capture-wire 跳过 + save_memory 拒绝）、
//   不注入召回（agent.handler 预取 + recall_memory 工具拒绝）
// - 不影响既有数据：关闭后已记录的记忆仍可列出/清除（用户可先关再清）
//
// 读取策略：设置写入是 fire-and-forget（settings:set），主进程侧需要读时
// 从 SQLite 直接取（同步 API），并做短 TTL 缓存避免每个回合都查库。
// ──────────────────────────────────────────────────────────────

import { logger } from '../../utils/logger';
import { readSetting } from '../storage/settings-pref';

/** 缓存 TTL（毫秒）：设置变更是低频操作，短缓存足以避免重复查库 */
const CACHE_TTL_MS = 1_000;

let cachedValue: boolean | null = null;
let cachedAt = 0;

/**
 * 记忆功能是否启用（默认启用）
 *
 * 默认 true：记忆是产品核心能力之一，且设置页可见可关（用户能明确关闭）。
 * 读取失败（DB 未就绪/条目损坏）时返回默认值并记日志——不因设置读取问题
 * 而彻底禁用记忆功能。
 */
export function isMemoryEnabled(): boolean {
  const now = Date.now();
  if (cachedValue !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedValue;
  }
  let enabled = true;
  try {
    const raw = readSetting('memory') as { enabled?: unknown } | undefined;
    if (typeof raw?.enabled === 'boolean') {
      enabled = raw.enabled;
    }
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      '[memory-hub] 记忆开关读取失败，按默认（启用）处理',
    );
    enabled = true;
  }
  cachedValue = enabled;
  cachedAt = now;
  return enabled;
}

/** 清空缓存（设置变更后调用，让下一次读取立即生效） */
export function resetMemoryEnabledCache(): void {
  cachedValue = null;
  cachedAt = 0;
}
