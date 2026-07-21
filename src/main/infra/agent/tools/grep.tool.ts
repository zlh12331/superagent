// src/main/infra/agent/tools/grep.tool.ts
// grep 工具：封装 SearchService.grep，供 Code Agent 在文件内容中搜索匹配
// ──────────────────────────────────────────────────────────────
// 职责：
// - 接收 LLM 生成的 pattern/paths/caseSensitive/isRegex/include/exclude/maxResults 入参
// - 通过 path-guard 把每个搜索路径解析为 workingDir 内的绝对路径
// - 调用 SearchService.grep 执行内容搜索
//
// 权限：'auto'（只读操作，无副作用，自动执行）
//
// 入参：
// - pattern：搜索模式（正则或字面量）
// - paths：搜索范围（相对路径数组，空数组表示搜索 workingDir）
// - caseSensitive：大小写敏感（默认 false）
// - isRegex：是否正则（默认 true）
// - include：文件名 glob 过滤（如 '*.ts'）
// - exclude：排除的文件名 glob 数组
// - maxResults：最大结果数（默认 100）
//
// 输出：GrepRes（matches / truncated）
// ──────────────────────────────────────────────────────────────

import type { GrepRes } from '@novel-writer/shared';
import { z } from 'zod';
import type { ISearchService } from '../../search/search-service';
import type { Tool, ToolContext } from '../tool';
import { resolveWithinWorkspace } from './path-guard';

/**
 * grep 工具入参 zod schema
 *
 * 与 GrepReqSchema 字段对齐，但 paths 允许相对路径（由 path-guard 解析）。
 * 空数组表示搜索 workingDir 本身。
 */
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

/** grep 工具入参类型（从 schema 派生） */
type GrepInput = z.infer<typeof GrepInputSchema>;

/** grep 工具输出类型（复用 GrepRes） */
type GrepOutput = GrepRes;

/**
 * 工厂函数：创建 grep 工具实例
 *
 * @param searchService 搜索服务实例（由 ServiceContainer 注入）
 * @returns Tool 实例（permission: 'auto'）
 */
export function createGrepTool(searchService: ISearchService): Tool<GrepInput, GrepOutput> {
  return {
    name: 'grep',
    description:
      '在文件内容中搜索匹配（基于 ripgrep）。支持正则与字面量两种模式，可指定文件名 glob 过滤和排除规则。返回匹配行、行号、列号及前后 2 行上下文。路径可相对工作目录或绝对路径（必须在工作目录内）。',
    inputSchema: GrepInputSchema,
    permission: 'auto',
    execute: async (input: GrepInput, ctx: ToolContext): Promise<GrepOutput> => {
      // 解析每个搜索路径为 workingDir 内的绝对路径
      // 空数组默认搜索 workingDir 本身
      const resolvedPaths =
        input.paths.length > 0
          ? input.paths.map((p) => resolveWithinWorkspace(p, ctx.workingDir))
          : [ctx.workingDir];

      // 调用 SearchService 执行内容搜索
      return searchService.grep({
        pattern: input.pattern,
        paths: resolvedPaths,
        caseSensitive: input.caseSensitive,
        isRegex: input.isRegex,
        include: input.include,
        exclude: input.exclude,
        maxResults: input.maxResults,
      });
    },
  };
}
