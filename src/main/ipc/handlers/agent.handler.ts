// src/main/ipc/handlers/agent.handler.ts
// 写作 Agent 域 IPC handler（薄层）
// 设计文档 §4.1 分层架构 / §5.1 场景 5（Agent 章节生成）/ §5.3 完整 Channel 清单
//
// 职责：
// 1. 注册 agent 域 3 个 channel 的 handler（generateChapter / rewrite / expandOutline）
// 2. 每个 handler 注入 ctx.sender 作为 webContents（agent.service 需推送流式事件到发起请求的窗口）
// 3. 不做业务逻辑，仅参数校验（wrap 内置 zod）+ 调 service
//
// 注意：
// - 3 个 service 函数都立即返回 { ackId }，后台异步流式生成
// - 流式事件通过 stream-bridge 推送：chat:stream:chunk / end / error（agent 复用 chat 流式 channel）
// - webContents = ctx.sender，确保事件只推送到发起请求的窗口

import { IPC_CHANNELS } from '@novel-writer/shared';
import { z } from 'zod';
import { expandOutline, generateChapter, rewriteChapter } from '../../services/agent.service';
import { wrap } from '../../utils/wrap';

/**
 * 注册 agent 域 IPC handler
 *
 * 3 个 channel：
 * - agent:generateChapter → generateChapter（续写下一章）
 * - agent:rewrite         → rewriteChapter（改写章节片段）
 * - agent:expandOutline   → expandOutline（扩写大纲）
 *
 * 所有 handler 都将 ctx.sender 作为 webContents 传给 service，
 * 用于后续流式事件推送（stream-bridge → webContents.send）
 */
export function registerAgentHandlers(): void {
  // 续写下一章：projectId 必填，prevChapterId / prompt 可选
  wrap(
    IPC_CHANNELS.AGENT_GENERATE_CHAPTER,
    z.object({
      projectId: z.string().min(1),
      prevChapterId: z.string().optional(),
      prompt: z.string().optional(),
    }),
    // 注意：exactOptionalPropertyTypes 严格模式下，直接展开 ...input 会把
    // prevChapterId?: string 变为 string | undefined，无法赋给可选属性。
    // 故采用条件展开，仅在字段存在时写入（与 chat.service.ts 一致）。
    (input, ctx) =>
      generateChapter({
        projectId: input.projectId,
        ...(input.prevChapterId !== undefined ? { prevChapterId: input.prevChapterId } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        webContents: ctx.sender,
      }),
  );

  // 改写章节：chapterId + instruction 必填
  wrap(
    IPC_CHANNELS.AGENT_REWRITE,
    z.object({
      chapterId: z.string().min(1),
      instruction: z.string().min(1),
    }),
    (input, ctx) => rewriteChapter({ ...input, webContents: ctx.sender }),
  );

  // 扩写大纲：projectId + outline 必填
  wrap(
    IPC_CHANNELS.AGENT_EXPAND_OUTLINE,
    z.object({
      projectId: z.string().min(1),
      outline: z.string().min(1),
    }),
    (input, ctx) => expandOutline({ ...input, webContents: ctx.sender }),
  );
}
