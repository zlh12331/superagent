import { logger } from '../../utils/logger';
import { readSetting } from '../storage/settings-pref';

const CACHE_TTL_MS = 1_000;

let cachedValue: boolean | null = null;
let cachedAt = 0;

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

export function resetMemoryEnabledCache(): void {
  cachedValue = null;
  cachedAt = 0;
}
