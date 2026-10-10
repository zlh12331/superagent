import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { app } from 'electron';
import { listBackups, stageRestore } from '../infra/storage/backup-store';
import { createManualBackup, getDbPath } from '../infra/storage/db';
import { logger } from '../utils/logger';
import type { IpcHandlerContext } from '../utils/wrap';

export interface BackupHandlerDeps {
  readonly hasRunningAgentTurns: () => boolean;
}

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
