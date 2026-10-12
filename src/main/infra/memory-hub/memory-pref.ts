// memory-pref.ts：记忆功能总开关（settings 表 memory.enabled 键）——1s TTL 缓存降 DB 读频
import { logger } from '../../utils/logger';
import { readSetting } from '../storage/settings-pref';

const CACHE_TTL_MS = 1_000;

let cachedValue: boolean | null = null;
let cachedAt = 0;

/** 记忆是否启用（读取失败按启用兜底——记忆是旁路，多记无害少记有害） */
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

/** 清空开关缓存（测试隔离用） */
export function resetMemoryEnabledCache(): void {
  cachedValue = null;
  cachedAt = 0;
}
