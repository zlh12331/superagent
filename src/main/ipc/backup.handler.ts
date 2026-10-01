// src/main/ipc/backup.handler.ts
// Backup 域 IPC handler（37 号 B：启动备份可见性与手动恢复，定义表驱动）
//
// 职责：
// - backup:list    列出恢复点（backups/ 轮转环 + quick_check 健康度）
// - backup:create  手动立即备份（复用启动备份路径，进同一轮转环）
// - backup:restore 从指定恢复点恢复（暂存 + 重启生效；运行中回合拒绝）
//
// 设计：
// - DI 模式：sessionService 的 hasRunningAgentTurns 由组合根注入（36-D 同款）——
//   恢复是有头破坏性操作，运行中回合先拒绝（与关窗协商同一「运行中」真源）
// - restore 成功后 app.relaunch() + app.quit()：走 before-quit 善后链
//   （closeDb 等待在途备份落地）后重启进程，暂存在下次 initDb 顶部生效
// - list/create 的恢复点操作在 backup-store（文件操作单点）
// ──────────────────────────────────────────────────────────────

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
    // backup:list - 恢复点列表（最新在前；含 quick_check 健康度）
    list: async () => {
      return { backups: listBackups(getDbPath()) };
    },

    // backup:create - 手动立即备份（与启动备份同环；在途启动备份经 pendingBackup 串行化）
    create: async () => {
      const { name } = await createManualBackup();
      return { name };
    },

    // backup:restore - 从指定恢复点恢复（暂存 + 重启生效）
    // 运行中回合先拒绝（重启会在途回合中断；让用户明确先停止）
    restore: async (input) => {
      if (hasRunningAgentTurns()) {
        throw new AppError(ErrorCode.SESSION_IN_USE);
      }
      stageRestore(getDbPath(), input.name);
      logger.warn({ backup: input.name }, '备份恢复已暂存，即将重启应用以生效');
      // 重启走完整善后链：before-quit 协商 → dispose（closeDb 等在途备份落地）
      // → app.relaunch 拉起新进程。延迟一帧让 IPC 响应先回渲染层（relaunch+quit
      // 立即执行会让当前 invoke 的 ack 丢失，渲染层表现为错误 toast 而非成功提示）
      setImmediate(() => {
        app.relaunch();
        app.quit();
      });
      return { ok: true };
    },
  };
}
