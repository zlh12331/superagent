// backup.handler.ts：backup 域 IPC——数据库备份列表/手动创建/恢复（恢复=暂存+重启生效）
import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { app } from 'electron';
import { listBackups, stageRestore } from '../infra/storage/backup-store';
import { createManualBackup, getDbPath } from '../infra/storage/db';
import { logger } from '../utils/logger';
import type { IpcHandlerContext } from '../utils/wrap';

/** 依赖注入工厂：恢复前置校验需要「是否有运行中回合」（index.ts 从容器取） */
export interface BackupHandlerDeps {
  readonly hasRunningAgentTurns: () => boolean;
}

/** 依赖注入工厂：index.ts 装配 */
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
      // 恢复 = 用备份文件覆盖活跃 DB，运行中回合会持旧句柄写坏数据——有回合直接拒
      if (hasRunningAgentTurns()) {
        throw new AppError(ErrorCode.SESSION_IN_USE);
      }
      // 暂存替换 + relaunch：SQLite 文件被本进程持有，必须重启后由启动序列完成真替换
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
