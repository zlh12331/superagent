// recall-memory.tool.ts：recall_memory 工具——记忆召回（memoryPort 承载）
import { z } from 'zod';
import { t } from '../../i18n';
import { isMemoryEnabled } from '../../memory-hub/memory-pref';
import type { MemoryPort } from '../../memory-hub/types';
import type { Tool, ToolContext, ToolResult } from './tool';

const RecallMemoryInputSchema = z.object({
  query: z.string().min(1).max(200),
  mode: z.enum(['recall', 'memories', 'conversations']).optional(),
});

type RecallMemoryInput = z.infer<typeof RecallMemoryInputSchema>;

async function searchL1(memoryPort: MemoryPort, query: string): Promise<ToolResult> {
  const result = await memoryPort.searchMemories(query, 10);
  if (result.content.trim().length === 0) {
    return { title: t('tools.recallMemory.l1Title'), output: '未找到相关记忆。' };
  }
  return {
    title: t('tools.recallMemory.l1WithCount', { count: result.total }),
    output: result.content,
  };
}

async function searchL0(memoryPort: MemoryPort, query: string): Promise<ToolResult> {
  const result = await memoryPort.searchConversations(query, 10);
  if (result.content.trim().length === 0) {
    return { title: t('tools.recallMemory.l0Title'), output: '未找到相关对话内容。' };
  }
  return {
    title: t('tools.recallMemory.l0WithCount', { count: result.total }),
    output: result.content,
  };
}

async function prefetchRecall(
  memoryPort: MemoryPort,
  query: string,
  sessionId: string,
): Promise<ToolResult> {
  const result = await memoryPort.recall({ query, sessionKey: sessionId });
  if (!result.ok) {
    return {
      title: t('tools.recallMemory.failed'),
      output: `记忆引擎返回失败：${result.message ?? '未知原因'}`,
    };
  }
  if (result.context.trim().length === 0) {
    return { title: t('tools.recallMemory.title'), output: '未找到相关记忆。' };
  }
  return {
    title: t('tools.recallMemory.withCount', { count: result.memoryCount }),
    output: result.context,
  };
}

export function createRecallMemoryTool(memoryPort: MemoryPort): Tool<RecallMemoryInput> {
  return {
    name: 'recall_memory',
    description:
      '检索跨会话记忆（用户事实、偏好、历史约定、过往对话内容）。默认模式为引擎预取召回；mode="memories" 为 L1 结构化记忆检索；mode="conversations" 为 L0 历史会话内容检索。在需要回忆用户之前说过的偏好/约定/背景信息时调用。',
    inputSchema: RecallMemoryInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: RecallMemoryInput, ctx: ToolContext): Promise<ToolResult> => {
      if (!isMemoryEnabled()) {
        return { title: t('tools.recallMemory.disabled'), output: '用户已在设置中关闭记忆功能。' };
      }
      if (input.mode === 'memories') {
        return searchL1(memoryPort, input.query);
      }
      if (input.mode === 'conversations') {
        return searchL0(memoryPort, input.query);
      }
      return prefetchRecall(memoryPort, input.query, ctx.sessionId);
    },
  };
}
