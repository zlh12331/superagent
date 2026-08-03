// src/main/infra/ai/tools/grep.tool.ts
// grep 工具：封装 SearchService.grep，供 Code Agent 在文件内容中搜索匹配
// ──────────────────────────────────────────────────────────────

import type { GrepRes } from '@code-agent/shared/main';
import { z } from 'zod';
import type { ISearchService } from '../../search/search-service';
import type { Tool, ToolContext, ToolResult } from '../tool';
import { resolveWithinWorkspace } from './path-guard';

const GrepInputSchema = z.object({
  pattern: z.string().min(1).describe('搜索模式（正则或字面量）'),
  paths: z
    .array(z.string())
    .default([])
    .describe('搜索范围（相对路径数组，空数组表示搜索工作目录）'),
  caseSensitive: z.boolean().default(false).describe('是否大小写敏感（默认 false）'),
  isRegex: z
    .boolean()
    .default(true)
    .describe('是否作为正则（默认 true）；false 时作为字面量字符串匹配'),
  include: z
    .string()
    .optional()
    .describe("文件名 glob 过滤（如 '*.ts'）")
    .transform((v) => v ?? undefined),
  exclude: z
    .array(z.string())
    .default([])
    .describe("排除的文件名 glob 数组（如 ['node_modules', '.git']）"),
  maxResults: z
    .number()
    .int()
    .positive()
    .max(1000)
    .default(100)
    .describe('最大结果数（默认 100，上限 1000）'),
});

type GrepInput = z.infer<typeof GrepInputSchema>;

export function createGrepTool(searchService: ISearchService): Tool<GrepInput> {
  return {
    name: 'grep',
    description:
      '在文件内容中搜索匹配（基于 ripgrep）。支持正则与字面量两种模式，可指定文件名 glob 过滤和排除规则。返回匹配行、行号、列号及前后 2 行上下文。路径可相对工作目录或绝对路径（必须在工作目录内）。',
    inputSchema: GrepInputSchema,
    permission: 'auto',
    execute: async (input: GrepInput, ctx: ToolContext): Promise<ToolResult> => {
      const resolvedPaths =
        input.paths.length > 0
          ? input.paths.map((p) => resolveWithinWorkspace(p, ctx.workingDir))
          : [ctx.workingDir];

      const result: GrepRes = await searchService.grep({
        pattern: input.pattern,
        paths: resolvedPaths,
        caseSensitive: input.caseSensitive,
        isRegex: input.isRegex,
        include: input.include,
        exclude: input.exclude,
        maxResults: input.maxResults,
      });

      const lines = result.matches.map((m) => {
        const context =
          m.beforeContext.length > 0 || m.afterContext.length > 0 ? ' (含上下文)' : '';
        return `${m.file}:${m.line}:${m.column}: ${m.text}${context}`;
      });

      return {
        title: `内容搜索: ${input.pattern}`,
        output: lines.join('\n') || '(无匹配结果)',
        metadata: {
          pattern: input.pattern,
          matchCount: result.matches.length,
          truncated: result.truncated,
          matches: result.matches,
        },
      };
    },
  };
}
