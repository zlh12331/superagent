import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ChatMessage,
  InferHandlers,
  IPC_DEFINITIONS,
  SessionImportRes,
} from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { app, dialog } from 'electron';

import type { ISessionService } from '../infra/storage/session-service';
import { readJsonImportFile } from '../utils/json-file';
import { logger } from '../utils/logger';
import type { IpcHandlerContext } from '../utils/wrap';

/** session 域 IPC handler 依赖（组合根注入；compactMessages/hasRunningAgentTurns 见字段注释） */
export interface SessionHandlerDeps {
  readonly sessionService: ISessionService;
  /**
   * 上下文压缩器（模型窗口感知）：由组合根注入（模型解析 + 预算 + 裁剪纯函数编排）。
   * 独立注入而非直接 import：保持 handler 与 ai 基础设施解耦，测试可注入纯函数。
   */
  readonly compactMessages: (messages: readonly ChatMessage[]) => {
    readonly trimmed: readonly ChatMessage[];
    readonly removed: number;
    readonly reclaimedTokens: number;
  };
  /**
   * 是否有运行中回合（36-D 清空守卫）：组合根传 serviceContainer.hasRunningAgentTurns()
   * ——与关窗协商同一「运行中」真源。清空全部会话在有回合运行时拒绝（SESSION_IN_USE）。
   */
  readonly hasRunningAgentTurns: () => boolean;
}

/**
 * 导出全部会话 JSON（数据资产可迁移）
 *
 * 流程：dialog 选保存路径 → SessionService.exportAll 聚合数据 → 写文件。
 * 用户取消时返回 { saved: false }。
 */
async function exportAllSessions(sessionService: ISessionService): Promise<{
  saved: boolean;
  path?: string;
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出全部会话',
    defaultPath: join(app.getPath('documents'), `sessions-export-${stamp}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || filePath === undefined || filePath === '') {
    return { saved: false };
  }
  try {
    const payload = await sessionService.exportAll();
    await writeFile(filePath, JSON.stringify(payload), 'utf8');
    logger.info({ filePath, sessions: payload.sessions.length }, '会话导出完成');
    return { saved: true, path: filePath };
  } catch (error) {
    logger.error({ error: String(error) }, '会话导出失败');
    throw error;
  }
}

/**
 * 导入会话 JSON（数据资产可迁移）
 *
 * 流程：dialog 选文件 → 读文件（大小上限 + JSON 解析）→ SessionService.importAll
 * （zod 文件格式校验 + 同 id 跳过 + 每会话事务落库）。
 * 用户取消 / 空选时返回 { imported: 0, skipped: 0 }（无操作，不报错）。
 */
async function importSessionsFile(sessionService: ISessionService): Promise<SessionImportRes> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '导入会话',
    defaultPath: app.getPath('documents'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  const filePath = filePaths[0];
  if (canceled || filePath === undefined) {
    return { imported: 0, skipped: 0 };
  }
  const payload = await readJsonImportFile(filePath);
  const result = await sessionService.importAll(payload);
  logger.info({ filePath, imported: result.imported, skipped: result.skipped }, '会话导入完成');
  return result;
}

/**
 * 创建 Session 域 handler 实现
 *
 * 6 个方法对应会话持久化的用户操作：
 * - list            → 分页列出所有会话（按 updatedAt 倒序）
 * - get             → 获取指定会话的完整消息历史
 * - delete          → 删除指定会话（级联删除消息）
 * - rename          → 重命名会话标题
 * - create          → 创建新会话（绑定 workingDir，空会话）
 * - listRecentDirs  → 查询最近使用的目录列表（去重 + 按 lastUsed 倒序）
 *
 * appendMessage 是内部 API（供 AgentService 调用），不通过 IPC 暴露。
 */
export function createSessionHandlers(
  deps: SessionHandlerDeps,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['session'] {
  const { sessionService, compactMessages, hasRunningAgentTurns } = deps;

  return {
    list: async (input) => {
      return sessionService.list(input.limit, input.offset);
    },

    get: async (input) => {
      return sessionService.get(input.id, { includeMessages: input.includeMessages === true });
    },

    delete: async (input) => {
      return sessionService.delete(input.id);
    },

    clearAll: async () => {
      if (hasRunningAgentTurns()) {
        throw new AppError(ErrorCode.SESSION_IN_USE);
      }
      return sessionService.clearAll();
    },

    rename: async (input) => {
      return sessionService.rename(input.id, input.title);
    },

    pin: async (input) => {
      return sessionService.pin(input.id, input.pinned);
    },

    create: async (input) => {
      const sessionId = await sessionService.create({
        workingDir: input.workingDir,
        title: input.title,
        messages: undefined,
      });
      return { sessionId };
    },

    listRecentDirs: async (input) => {
      return sessionService.listRecentDirs({ limit: input.limit });
    },

    exportAll: async () => {
      return exportAllSessions(sessionService);
    },

    importAll: async () => {
      return importSessionsFile(sessionService);
    },

    getUsageSummary: async () => {
      return sessionService.getUsageSummary();
    },

    getTurns: async (input) => {
      return sessionService.getTurns(input.sessionId);
    },

    getRecentTurns: async (input) => {
      return sessionService.getRecentTurns({ limit: input.limit });
    },

    getTurnMessages: async (input) => {
      const messages = await sessionService.getTurnMessages(input.turnId);
      return { messages };
    },

    compact: async (input) => {
      const session = await sessionService.get(input.sessionId);
      const { trimmed, removed, reclaimedTokens } = compactMessages(session.messages);
      if (reclaimedTokens > 0) {
        await sessionService.replaceMessages(input.sessionId, trimmed);
      }
      return {
        removed,
        remaining: trimmed.length,
        reclaimedTokens,
        messages: trimmed,
      };
    },
  };
}
