// src/main/infra/ai/tools/save-memory.tool.ts
// save_memory 工具：主动保存记忆条目（对齐 qwen save_memory 工具语义收敛）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 模型显式声明值得跨会话保留的内容（绕过回合后自动提取的被动通道）
// - 敏感信息过滤在 MemoryService.store 内执行（api key/token 等跳过）
// - 依赖注入：MemoryService 由 ServiceContainer 提供（避免双实例）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { MemoryService } from '../memory-service';
import type { Tool, ToolContext, ToolResult } from '../tool';

/** save_memory 入参 */
const SaveMemoryInputSchema = z.object({
  /** 记忆内容（跨会话保留的事实/偏好） */
  content: z.string().min(1).max(500),
  /** 记忆类别（缺省 fact） */
  kind: z.enum(['fact', 'preference']).optional(),
});

type SaveMemoryInput = z.infer<typeof SaveMemoryInputSchema>;

/**
 * 创建 save_memory 工具（依赖注入 MemoryService）
 */
export function createSaveMemoryTool(memoryService: MemoryService): Tool<SaveMemoryInput> {
  return {
    name: 'save_memory',
    description:
      '主动保存一条跨会话记忆（用户事实或偏好）。用于模型识别到值得长期记住的信息时主动存储；敏感信息（API Key/密码/密钥）会被自动过滤。',
    inputSchema: SaveMemoryInputSchema,
    permission: 'auto',
    category: 'exec',
    execute: async (input: SaveMemoryInput, ctx: ToolContext): Promise<ToolResult> => {
      await memoryService.store(ctx.sessionId, [
        {
          content: input.content,
          kind: input.kind ?? 'fact',
        },
      ]);
      return {
        title: '记忆已保存',
        output: `已保存记忆（${input.kind ?? 'fact'}）：${input.content.slice(0, 100)}`,
      };
    },
  };
}
