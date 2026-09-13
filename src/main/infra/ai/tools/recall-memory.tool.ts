// src/main/infra/ai/tools/recall-memory.tool.ts
// recall_memory 工具：按需检索跨会话记忆（只读）
// ──────────────────────────────────────────────────────────────
// 设计：
// - L0/L1 不注入 systemPrompt（上游 KV cache 约束），改为暴露只读工具由模型主动查询
// - 数据面：MemoryHub recall（keyword 策略预取召回，返回引擎格式化上下文）
// - 依赖注入：MemoryPort 由 ServiceContainer 提供（唯一边界见 infra/memory-hub）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { MemoryPort } from '../../memory-hub/types';
import type { Tool, ToolContext, ToolResult } from './tool';

/** recall_memory 入参 */
const RecallMemoryInputSchema = z.object({
  /** 检索查询（关键词/主题描述） */
  query: z.string().min(1).max(200),
  /**
   * 检索模式（W5 接线补全：此前 searchMemories/searchConversations 建成未接线）：
   * - recall（默认）：引擎预取召回，返回格式化上下文
   * - memories：L1 结构化记忆检索
   * - conversations：L0 会话内容检索（跨会话历史对话）
   */
  mode: z.enum(['recall', 'memories', 'conversations']).optional(),
});

type RecallMemoryInput = z.infer<typeof RecallMemoryInputSchema>;

/**
 * 创建 recall_memory 工具（依赖注入 MemoryPort）
 */
export function createRecallMemoryTool(memoryPort: MemoryPort): Tool<RecallMemoryInput> {
  return {
    name: 'recall_memory',
    description:
      '检索跨会话记忆（用户事实、偏好、历史约定、过往对话内容）。默认模式为引擎预取召回；mode="memories" 为 L1 结构化记忆检索；mode="conversations" 为 L0 历史会话内容检索。在需要回忆用户之前说过的偏好/约定/背景信息时调用。',
    inputSchema: RecallMemoryInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: RecallMemoryInput, ctx: ToolContext): Promise<ToolResult> => {
      // L1 结构化记忆检索
      if (input.mode === 'memories') {
        const result = await memoryPort.searchMemories(input.query, 10);
        if (result.content.trim().length === 0) {
          return { title: '记忆检索（L1）', output: '未找到相关记忆。' };
        }
        return { title: `记忆检索（L1，${result.total} 条）`, output: result.content };
      }
      // L0 会话内容检索（跨会话历史对话）
      if (input.mode === 'conversations') {
        const result = await memoryPort.searchConversations(input.query, 10);
        if (result.content.trim().length === 0) {
          return { title: '会话检索（L0）', output: '未找到相关对话内容。' };
        }
        return { title: `会话检索（L0，${result.total} 条）`, output: result.content };
      }
      // 默认：预取召回
      // 上游 RecallRequest 要求 session_key 必填（缺失 → HTTP 400），故必须传当前
      // 会话 id。此前未传，导致该工具自上线起恒失败并被静默降级为"未找到相关记忆"。
      const result = await memoryPort.recall({ query: input.query, sessionKey: ctx.sessionId });
      if (!result.ok) {
        return {
          title: '记忆检索失败',
          output: `记忆引擎返回失败：${result.message ?? '未知原因'}`,
        };
      }
      if (result.context.trim().length === 0) {
        return { title: '记忆检索', output: '未找到相关记忆。' };
      }
      return {
        title: `记忆检索（${result.memoryCount} 条）`,
        output: result.context,
      };
    },
  };
}
