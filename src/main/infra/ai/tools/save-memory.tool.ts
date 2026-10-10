import { z } from 'zod';
import { t } from '../../i18n';
import { isMemoryEnabled } from '../../memory-hub/memory-pref';
import type { MemoryPort } from '../../memory-hub/types';
import type { Tool, ToolContext, ToolResult } from './tool';

const SaveMemoryInputSchema = z.object({
  content: z.string().min(1).max(500),
  kind: z.enum(['fact', 'preference']).optional(),
});

type SaveMemoryInput = z.infer<typeof SaveMemoryInputSchema>;

export function createSaveMemoryTool(memoryPort: MemoryPort): Tool<SaveMemoryInput> {
  return {
    name: 'save_memory',
    description:
      '主动保存一条跨会话记忆（用户事实或偏好）。用于模型识别到值得长期记住的信息时主动存储。',
    inputSchema: SaveMemoryInputSchema,
    permission: 'auto',
    category: 'exec',
    execute: async (input: SaveMemoryInput, ctx: ToolContext): Promise<ToolResult> => {
      if (!isMemoryEnabled()) {
        return {
          title: t('tools.saveMemory.disabled'),
          output: '用户已在设置中关闭记忆功能，未保存该条目。',
        };
      }
      const result = await memoryPort.capture({
        sessionKey: ctx.sessionId,
        userContent: `请记住（${input.kind ?? 'fact'}）：${input.content}`,
        assistantContent: '已记录该记忆。',
      });
      if (result.l0Recorded === 0) {
        return { title: t('tools.saveMemory.failed'), output: '记忆引擎不可用，未能保存该条目。' };
      }
      return {
        title: t('tools.saveMemory.saved'),
        output: `已保存记忆（${input.kind ?? 'fact'}）：${input.content.slice(0, 100)}`,
      };
    },
  };
}
