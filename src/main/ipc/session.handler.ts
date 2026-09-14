// src/main/ipc/session.handler.ts
// Session 域 IPC handler：会话持久化查询通道（定义表驱动）
//
// 职责：
// - 实现 6 个 session:* 请求-响应方法
// - 把 IPC 调用委托给 SessionService
//
// 设计：
// - 与 GitHandler / CodebaseHandler 一致的 DI 模式
// - SessionHandlerDeps 接口声明依赖，便于测试 mock
// - 不持有状态，所有调用转发给 SessionService
//
// 注意：
// - SessionService 的 appendMessage 是内部 API（非 IPC 通道）
//   由 AgentService / ChatService 直接调用，不在此 handler 中注册

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMessage, InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { app, dialog } from 'electron';

import type { ISessionService } from '../infra/storage/session-service';
import { logger } from '../utils/logger';
import type { IpcHandlerContext } from '../utils/wrap';

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
    // P2 修复：紧凑序列化 + 异步写——此前 null,2 美化显著放大体积，
    // writeFileSync 同步阻塞主进程（重度使用时秒级卡顿，全部 IPC 停摆）
    await writeFile(filePath, JSON.stringify(payload), 'utf8');
    logger.info({ filePath, sessions: payload.sessions.length }, '会话导出完成');
    return { saved: true, path: filePath };
  } catch (error) {
    logger.error({ error: String(error) }, '会话导出失败');
    throw error;
  }
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
  const { sessionService, compactMessages } = deps;

  return {
    // session:list - 分页列出会话
    list: async (input) => {
      return sessionService.list(input.limit, input.offset);
    },

    // session:get - 获取完整会话消息历史
    get: async (input) => {
      return sessionService.get(input.id);
    },

    // session:delete - 删除会话（级联删除消息）
    delete: async (input) => {
      return sessionService.delete(input.id);
    },

    // session:rename - 重命名会话标题
    rename: async (input) => {
      return sessionService.rename(input.id, input.title);
    },

    // session:pin - 置顶/取消置顶会话（对齐参考项目 pinned-header 分组）
    pin: async (input) => {
      return sessionService.pin(input.id, input.pinned);
    },

    // session:create - 创建新会话（绑定 workingDir，空会话）
    create: async (input) => {
      const sessionId = await sessionService.create({
        workingDir: input.workingDir,
        title: input.title,
        messages: undefined,
      });
      return { sessionId };
    },

    // session:listRecentDirs - 查询最近使用的目录列表
    listRecentDirs: async (input) => {
      return sessionService.listRecentDirs({ limit: input.limit });
    },

    // session:exportAll - 导出全部会话 JSON（dialog 选路径 + 写文件）
    exportAll: async () => {
      return exportAllSessions(sessionService);
    },

    // session:getUsageSummary - 用量统计汇总（设置页展示）
    getUsageSummary: async () => {
      return sessionService.getUsageSummary();
    },

    // session:getTurns - 回合列表查询（Transcript）
    getTurns: async (input) => {
      return sessionService.getTurns(input.sessionId);
    },

    // session:getRecentTurns - 最近回合查询（设置页展示）
    getRecentTurns: async (input) => {
      return sessionService.getRecentTurns({ limit: input.limit });
    },

    // session:getTurnMessages - 回合消息明细（Transcript 消息级回放）
    getTurnMessages: async (input) => {
      const messages = await sessionService.getTurnMessages(input.turnId);
      return { messages };
    },

    // session:compact - /compact 斜杠命令：手动压缩会话上下文（裁剪后整体落库）
    // 落库门槛用回收的 token 数：纯条数差会漏掉就地裁剪（条数不变但内容变少）
    compact: async (input) => {
      const session = await sessionService.get(input.sessionId);
      // 契约修正后 session.messages 已是 ChatMessage[]（packages/shared/src/schemas/session.ts），无需断言
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
