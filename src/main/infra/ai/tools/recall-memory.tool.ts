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
import type { Tool, ToolResult } from './tool';

/** recall_memory 入参 */
const RecallMemoryInputSchema = z.object({
  /** 检索查询（关键词/主题描述） */
  query: z.string().min(1).max(200),
});

type RecallMemoryInput = z.infer<typeof RecallMemoryInputSchema>;

/**
 * 创建 recall_memory 工具（依赖注入 MemoryPort）
 */
export function createRecallMemoryTool(memoryPort: MemoryPort): Tool<RecallMemoryInput> {
  return {
    name: 'recall_memory',
    description:
      '检索跨会话记忆（用户事实、偏好、历史约定）。在需要回忆用户之前说过的偏好/约定/背景信息时调用。',
    inputSchema: RecallMemoryInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: RecallMemoryInput): Promise<ToolResult> => {
      const result = await memoryPort.recall({ query: input.query });
      if (!result.ok || result.context.trim().length === 0) {
        return { title: '记忆检索', output: '未找到相关记忆。' };
      }
      return {
        title: `记忆检索（${result.memoryCount} 条）`,
        output: result.context,
      };
    },
  };
}
