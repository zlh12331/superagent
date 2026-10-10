// approval-pref.ts：审批模式持久化（JSON 文件而非 SQLite）——容器初始化 PermissionService 时
// DB 可能尚未就绪，此文件必须可同步读取；值为共享 ApprovalMode 四态
import { mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ApprovalMode, DEFAULT_APPROVAL_MODE } from '@code-agent/shared/main';
import { app } from 'electron';
import { logger } from '../../utils/logger';

function approvalPrefPath(): string {
  return join(app.getPath('userData'), 'approval-pref.json');
}

/** 同步读审批模式（损坏/缺失回落默认）；值域窄校验，未知值不采纳 */
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

/** 写审批模式（settings:setApprovalMode 与渲染层切换入口共用） */
export async function writeApprovalMode(mode: ApprovalMode): Promise<void> {
  const filePath = approvalPrefPath();
  mkdirSync(join(filePath, '..'), { recursive: true });
  const content = JSON.stringify({ mode }, null, 2);
  await writeFile(filePath, content, 'utf8');
  logger.info({ mode }, '审批模式已保存');
}
