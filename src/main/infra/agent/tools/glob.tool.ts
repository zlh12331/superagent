// src/main/infra/agent/tools/glob.tool.ts
// glob 工具：封装 SearchService.glob，供 Code Agent 按文件名模式查找文件
// ──────────────────────────────────────────────────────────────
// 职责：
// - 接收 LLM 生成的 pattern/path/includeHidden/maxResults 入参
// - 通过 path-guard 把搜索根目录解析为 workingDir 内的绝对路径
// - 调用 SearchService.glob 执行文件路径匹配
//
// 权限：'auto'（只读操作，无副作用，自动执行）
//
// 入参：
// - pattern：glob 模式（如 双星斜杠.ts 匹配所有 TypeScript 文件）
// - path：搜索根目录（相对路径，默认 workingDir）
// - includeHidden：是否包含隐藏文件（默认 false）
// - maxResults：最大结果数（默认 1000）
//
// 输出：GlobRes（files / truncated）
// ──────────────────────────────────────────────────────────────

import type { GlobRes } from '@novel-writer/shared';
import { z } from 'zod';
import type { ISearchService } from '../../search/search-service';
import type { Tool, ToolContext } from '../tool';
import { resolveWithinWorkspace } from './path-guard';

/**
 * glob 工具入参 zod schema
 *
 * 与 GlobReqSchema 字段对齐，但 path 允许相对路径（由 path-guard 解析）。
 * path 省略时默认搜索 workingDir 本身。
 */
const GlobInputSchema = z.object({
  pattern: z.string().min(1).describe('glob 模式，如 双星斜杠.ts 匹配所有 TypeScript 文件'),
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

/** glob 工具入参类型（从 schema 派生） */
type GlobInput = z.infer<typeof GlobInputSchema>;

/** glob 工具输出类型（复用 GlobRes） */
type GlobOutput = GlobRes;

/**
 * 工厂函数：创建 glob 工具实例
 *
 * @param searchService 搜索服务实例（由 ServiceContainer 注入）
 * @returns Tool 实例（permission: 'auto'）
 */
export function createGlobTool(searchService: ISearchService): Tool<GlobInput, GlobOutput> {
  return {
    name: 'glob',
    description:
      '按 glob 模式匹配文件路径（不读取内容），用于按文件名查找。基于 ripgrep --files 实现，默认遵守 .gitignore。返回匹配的文件绝对路径数组。路径可相对工作目录或绝对路径（必须在工作目录内）。',
    inputSchema: GlobInputSchema,
    permission: 'auto',
    execute: async (input: GlobInput, ctx: ToolContext): Promise<GlobOutput> => {
      // path 省略时默认搜索 workingDir 本身
      const rawPath = input.path ?? '.';
      const absPath = resolveWithinWorkspace(rawPath, ctx.workingDir);

      // 调用 SearchService 执行文件路径匹配
      return searchService.glob({
        pattern: input.pattern,
        path: absPath,
        includeHidden: input.includeHidden,
        maxResults: input.maxResults,
      });
    },
  };
}
