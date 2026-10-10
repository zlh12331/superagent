import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TelemetryLevel } from '@code-agent/shared/main';
import { app } from 'electron';

/** 默认遥测级别（与项目初始行为一致） */
const DEFAULT_LEVEL: TelemetryLevel = 'full';

/** 有效级别集合（用于校验 JSON 文件内容） */
const VALID_LEVELS: readonly TelemetryLevel[] = ['off', 'error-only', 'full'];

/** 偏好文件路径 */
function getPrefPath(): string {
  return join(app.getPath('userData'), 'telemetry-pref.json');
}

/** 偏好文件结构 */
interface TelemetryPref {
  level: TelemetryLevel;
}

/**
 * 同步读取遥测级别
 *
 * 在 OTel 初始化前调用（whenReady 路径），必须同步。
 * 文件不存在或解析失败时返回默认值 'full'，不阻塞应用启动。
 */
export function readTelemetryLevelSync(): TelemetryLevel {
  try {
    const path = getPrefPath();
    if (!existsSync(path)) {
      return DEFAULT_LEVEL;
    }
    const content = readFileSync(path, 'utf8');
    const pref = JSON.parse(content) as Partial<TelemetryPref>;
    const level = pref.level;
    if (level !== undefined && VALID_LEVELS.includes(level)) {
      return level;
    }
    return DEFAULT_LEVEL;
  } catch {
    return DEFAULT_LEVEL;
  }
}

/**
 * 异步写入遥测级别
 *
 * 在 IPC handler 中调用（whenReady 之后），用 async API。
 * 写入后需要重启应用才能生效（OTel provider 已初始化无法动态改）。
 */
export async function writeTelemetryLevel(level: TelemetryLevel): Promise<void> {
  const path = getPrefPath();
  const dir = join(path, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const pref: TelemetryPref = { level };
  writeFileSync(path, JSON.stringify(pref, null, 2), { encoding: 'utf8', mode: 0o600 });
}
