// src/main/infra/ai/tools/glob.tool.ts
// glob 工具：封装 SearchService.glob，供 Code Agent 按文件名模式查找文件
// ──────────────────────────────────────────────────────────────

import type { GlobRes } from '@code-agent/shared/main';
import { z } from 'zod';
import { t } from '../../i18n';
import type { ISearchService } from '../../search/search-service';
import { resolveWithinWorkspace } from './path-guard';
import type { Tool, ToolContext, ToolResult } from './tool';

const GlobInputSchema = z.object({
  pattern: z.string().min(1).describe('glob 模式，如 **/*.ts 匹配所有 TypeScript 文件'),
  path: z
    .string()
    .optional()
    .describe('搜索根目录（相对路径，省略时搜索工作目录）')
    .transform((v) => v ?? undefined),
  includeHidden: z.boolean().default(false).describe('是否包含隐藏文件（默认 false）'),
  maxResults: z
    .number()
    .int()
    .positive()
    .max(10000)
    .default(1000)
    .describe('最大结果数（默认 1000，上限 10000）'),
});

type GlobInput = z.infer<typeof GlobInputSchema>;

/**
 * 创建 glob 工具（按 glob 模式匹配文件路径，基于 ripgrep --files，遵守 .gitignore）
 *
 * @param searchService 搜索服务（执行实际匹配）
 */
export function createGlobTool(searchService: ISearchService): Tool<GlobInput> {
  return {
    name: 'glob',
    description:
      '按 glob 模式匹配文件路径（不读取内容），用于按文件名查找。基于 ripgrep --files 实现，默认遵守 .gitignore。返回匹配的文件绝对路径数组。路径可相对工作目录或绝对路径（必须在工作目录内）。',
    inputSchema: GlobInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: GlobInput, ctx: ToolContext): Promise<ToolResult> => {
      const rawPath = input.path ?? '.';
      // realTarget：IO 用真实落点（TOCTOU，debt.md#d1）；metadata.path 保持输入形态
      const { resolved, realTarget } = resolveWithinWorkspace(rawPath, ctx.workingDir);

      const result: GlobRes = await searchService.glob({
        pattern: input.pattern,
        path: realTarget,
        includeHidden: input.includeHidden,
        maxResults: input.maxResults,
      });

      return {
        title: t('tools.glob.title', { pattern: input.pattern }),
        output: result.files.join('\n') || '(无匹配结果)',
        metadata: {
          pattern: input.pattern,
          path: resolved,
          count: result.files.length,
          truncated: result.truncated,
          files: result.files,
        },
      };
    },
  };
}
