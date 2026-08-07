// src/main/infra/storage/approval-pref.ts
// 工具审批模式持久化（用户偏好，JSON 文件）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 读写 ApprovalMode 配置（plan / ask / auto / yolo）
// - 存储位置：userData/approval-pref.json（与 telemetry-pref 同模式）
// - 读取失败回退 'ask'（保守默认：写操作需审批）
//
// 设计：
// - 与 telemetry-pref 对齐：无状态模块函数 + 同步/异步读写
// - 启动时由 PermissionService 读取并应用（setApprovalMode）
// ──────────────────────────────────────────────────────────────

import { mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ApprovalMode, DEFAULT_APPROVAL_MODE } from '@code-agent/shared/main';
import { app } from 'electron';
import { logger } from '../../utils/logger';

/** 偏好文件路径（userData 目录） */
function approvalPrefPath(): string {
  return join(app.getPath('userData'), 'approval-pref.json');
}

/**
 * 同步读取审批模式（启动时用；文件缺失/损坏回退默认）
 */
export function readApprovalModeSync(): ApprovalMode {
  try {
    const raw = readFileSync(approvalPrefPath(), 'utf8');
    const parsed = JSON.parse(raw) as { mode?: ApprovalMode };
    if (
      parsed.mode === 'plan' ||
      parsed.mode === 'ask' ||
      parsed.mode === 'auto' ||
      parsed.mode === 'yolo'
    ) {
      return parsed.mode;
    }
  } catch {
    // 文件不存在 / 解析失败：回退默认
  }
  return DEFAULT_APPROVAL_MODE;
}

/**
 * 异步写入审批模式（设置页变更时调用）
 */
export async function writeApprovalMode(mode: ApprovalMode): Promise<void> {
  const filePath = approvalPrefPath();
  mkdirSync(join(filePath, '..'), { recursive: true });
  const content = JSON.stringify({ mode }, null, 2);
  await writeFile(filePath, content, 'utf8');
  logger.info({ mode }, '审批模式已保存');
}
