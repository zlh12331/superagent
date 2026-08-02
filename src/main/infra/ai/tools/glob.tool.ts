// src/main/infra/ai/tools/glob.tool.ts
// glob 工具：封装 SearchService.glob，供 Code Agent 按文件名模式查找文件
// ──────────────────────────────────────────────────────────────

import type { GlobRes } from '@code-agent/shared';
import { z } from 'zod';
import type { ISearchService } from '../../search/search-service';
import type { Tool, ToolContext, ToolResult } from '../tool';
import { resolveWithinWorkspace } from './path-guard';

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

export function createGlobTool(searchService: ISearchService): Tool<GlobInput> {
  return {
    name: 'glob',
    description:
      '按 glob 模式匹配文件路径（不读取内容），用于按文件名查找。基于 ripgrep --files 实现，默认遵守 .gitignore。返回匹配的文件绝对路径数组。路径可相对工作目录或绝对路径（必须在工作目录内）。',
    inputSchema: GlobInputSchema,
    permission: 'auto',
    execute: async (input: GlobInput, ctx: ToolContext): Promise<ToolResult> => {
      const rawPath = input.path ?? '.';
      const absPath = resolveWithinWorkspace(rawPath, ctx.workingDir);

      const result: GlobRes = await searchService.glob({
        pattern: input.pattern,
        path: absPath,
        includeHidden: input.includeHidden,
        maxResults: input.maxResults,
      });

      return {
        title: `文件匹配: ${input.pattern}`,
        output: result.files.join('\n') || '(无匹配结果)',
        metadata: {
          pattern: input.pattern,
          path: absPath,
          count: result.files.length,
          truncated: result.truncated,
          files: result.files,
        },
      };
    },
  };
}
