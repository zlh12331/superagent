// src/main/infra/ai/tools/save-memory.tool.ts
// save_memory 工具：主动保存记忆条目（对齐 qwen save_memory 工具语义收敛）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 模型显式声明值得跨会话保留的内容（绕过回合后自动提取的被动通道）
// - 存储引擎：MemoryHub（TencentDB-Agent-Memory）——显式条目经 capture 进 L0，
//   由蒸馏管线沉淀为 L1 结构化记忆
// - 依赖注入：MemoryPort 由 ServiceContainer 提供（唯一边界见 infra/memory-hub）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { MemoryPort } from '../../memory-hub/types';
import type { Tool, ToolContext, ToolResult } from './tool';

/** save_memory 入参 */
const SaveMemoryInputSchema = z.object({
  /** 记忆内容（跨会话保留的事实/偏好） */
  content: z.string().min(1).max(500),
  /** 记忆类别（缺省 fact；作为蒸馏提示保留入参兼容） */
  kind: z.enum(['fact', 'preference']).optional(),
});

type SaveMemoryInput = z.infer<typeof SaveMemoryInputSchema>;

/**
 * 创建 save_memory 工具（依赖注入 MemoryPort）
 */
export function createSaveMemoryTool(memoryPort: MemoryPort): Tool<SaveMemoryInput> {
  return {
    name: 'save_memory',
    description:
      '主动保存一条跨会话记忆（用户事实或偏好）。用于模型识别到值得长期记住的信息时主动存储。',
    inputSchema: SaveMemoryInputSchema,
    permission: 'auto',
    category: 'exec',
    execute: async (input: SaveMemoryInput, ctx: ToolContext): Promise<ToolResult> => {
      const result = await memoryPort.capture({
        sessionKey: ctx.sessionId,
        userContent: `请记住（${input.kind ?? 'fact'}）：${input.content}`,
        assistantContent: '已记录该记忆。',
      });
      if (result.l0Recorded === 0) {
        return { title: '记忆保存失败', output: '记忆引擎不可用，未能保存该条目。' };
      }
      return {
        title: '记忆已保存',
        output: `已保存记忆（${input.kind ?? 'fact'}）：${input.content.slice(0, 100)}`,
      };
    },
  };
}
