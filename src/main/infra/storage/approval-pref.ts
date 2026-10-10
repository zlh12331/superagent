import { mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ApprovalMode, DEFAULT_APPROVAL_MODE } from '@code-agent/shared/main';
import { app } from 'electron';
import { logger } from '../../utils/logger';

function approvalPrefPath(): string {
  return join(app.getPath('userData'), 'approval-pref.json');
}

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

export async function writeApprovalMode(mode: ApprovalMode): Promise<void> {
  const filePath = approvalPrefPath();
  mkdirSync(join(filePath, '..'), { recursive: true });
  const content = JSON.stringify({ mode }, null, 2);
  await writeFile(filePath, content, 'utf8');
  logger.info({ mode }, '审批模式已保存');
}
