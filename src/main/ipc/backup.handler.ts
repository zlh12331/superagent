import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { app } from 'electron';
import { listBackups, stageRestore } from '../infra/storage/backup-store';
import { createManualBackup, getDbPath } from '../infra/storage/db';
import { logger } from '../utils/logger';
import type { IpcHandlerContext } from '../utils/wrap';

/** backup 域 IPC handler 依赖（组合根注入） */
export interface BackupHandlerDeps {
  /**
   * 是否有运行中回合（恢复守卫）：组合根传 serviceContainer.hasRunningAgentTurns()
   * ——与关窗协商/清空全部会话同一真源。恢复涉及重启，运行中回合先拒绝。
   */
  readonly hasRunningAgentTurns: () => boolean;
}

/**
 * 创建 Backup 域 handler 实现
 *
 * 三方法对应备份可见性的三个用户操作：查看恢复点 / 立即备份 / 从恢复点恢复。
 */
export function createBackupHandlers(
  deps: BackupHandlerDeps,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['backup'] {
  const { hasRunningAgentTurns } = deps;

  return {
    list: async () => {
      return { backups: listBackups(getDbPath()) };
    },

    create: async () => {
      const { name } = await createManualBackup();
      return { name };
    },

    restore: async (input) => {
      if (hasRunningAgentTurns()) {
        throw new AppError(ErrorCode.SESSION_IN_USE);
      }
      stageRestore(getDbPath(), input.name);
      logger.warn({ backup: input.name }, '备份恢复已暂存，即将重启应用以生效');
      setImmediate(() => {
        app.relaunch();
        app.quit();
      });
      return { ok: true };
    },
  };
}
