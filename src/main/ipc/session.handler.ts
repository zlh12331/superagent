// session.handler.ts：session 域 IPC——会话 CRUD/置顶/导出导入/用量/回合明细/上下文压缩
// compact 依赖注入（compactMessages）：压缩预算与 token 估算在 index.ts 装配（依赖模型上下文窗口）
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

/** 依赖注入工厂：compactMessages（模型感知的压缩策略）与 hasRunningAgentTurns（清空护栏）由 index.ts 装配 */
export interface SessionHandlerDeps {
  readonly sessionService: ISessionService;
  readonly compactMessages: (messages: readonly ChatMessage[]) => {
    readonly trimmed: readonly ChatMessage[];
    readonly removed: number;
    readonly reclaimedTokens: number;
  };
  readonly hasRunningAgentTurns: () => boolean;
}

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
      // 危险操作双保险：运行中回合直接拒（确认弹窗在渲染层，这里是兜底）
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
      // 压缩按预算裁历史消息；零回收时不落库（避免无意义重写整条会话）
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
