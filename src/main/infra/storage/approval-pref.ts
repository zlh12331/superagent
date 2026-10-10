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
  } catch {}
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
