// whitelist-pref.ts：工具命令白名单持久化（JSON 文件而非 SQLite）——PermissionService
// 构造期同步读取（早于 DB 就绪）；条目 = 工具名 + 模式串
import { mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WhitelistEntry } from '@code-agent/shared/main';
import { app } from 'electron';
import { logger } from '../../utils/logger';

function whitelistPrefPath(): string {
  return join(app.getPath('userData'), 'whitelist.json');
}

/** 同步读白名单（逐条形状校验，垃圾条目剔除不炸） */
export function readWhitelistSync(): WhitelistEntry[] {
  try {
    const raw = readFileSync(whitelistPrefPath(), 'utf8');
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (Array.isArray(parsed.entries)) {
      return parsed.entries.filter(
        (e): e is WhitelistEntry =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as WhitelistEntry).toolName === 'string' &&
          typeof (e as WhitelistEntry).pattern === 'string',
      );
    }
  } catch {}
  return [];
}

/** 整表覆写白名单 */
export async function writeWhitelist(entries: readonly WhitelistEntry[]): Promise<void> {
  const filePath = whitelistPrefPath();
  mkdirSync(join(filePath, '..'), { recursive: true });
  const content = JSON.stringify({ entries }, null, 2);
  await writeFile(filePath, content, 'utf8');
  logger.info({ count: entries.length }, '命令白名单已保存');
}
