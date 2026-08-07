// src/main/infra/storage/whitelist-pref.ts
// 命令白名单持久化（用户偏好，JSON 文件）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 读写命令白名单条目（toolName + pattern，跨会话持久）
// - 存储位置：userData/whitelist.json（与 approval-pref / telemetry-pref 同模式）
// - 读取失败回退空列表（白名单为空 = 全部走审批流）
//
// 与「记住决策」的区别：
// - 记住决策：permission-service 内存 Map，5 分钟 TTL（会话级）
// - 白名单：本文件持久化，应用重启仍生效（跨会话）
// ──────────────────────────────────────────────────────────────

import { mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WhitelistEntry } from '@code-agent/shared/main';
import { app } from 'electron';
import { logger } from '../../utils/logger';

/** 偏好文件路径（userData 目录） */
function whitelistPrefPath(): string {
  return join(app.getPath('userData'), 'whitelist.json');
}

/**
 * 同步读取白名单（启动时用；文件缺失/损坏回退空列表）
 */
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
  } catch {
    // 文件不存在 / 解析失败：回退空列表
  }
  return [];
}

/**
 * 异步写入白名单（增删时调用，整表覆写）
 */
export async function writeWhitelist(entries: readonly WhitelistEntry[]): Promise<void> {
  const filePath = whitelistPrefPath();
  mkdirSync(join(filePath, '..'), { recursive: true });
  const content = JSON.stringify({ entries }, null, 2);
  await writeFile(filePath, content, 'utf8');
  logger.info({ count: entries.length }, '命令白名单已保存');
}
