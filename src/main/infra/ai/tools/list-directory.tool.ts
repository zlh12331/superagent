// src/main/infra/ai/tools/list-directory.tool.ts
// list_directory 工具：封装 FileService.list，供 Code Agent 列出目录内容
// ──────────────────────────────────────────────────────────────
// 职责：
// - 接收 LLM 生成的 path/depth/includeHidden 入参
// - 通过 path-guard 把路径解析为 workingDir 内的绝对路径
// - 调用 FileService.list 递归列出目录内容
//
// 权限：'auto'（只读操作，无副作用，自动执行）
//
// 入参：
// - path：目录路径（相对或绝对）
// - depth：递归深度（默认 1，最大 10）
// - includeHidden：是否包含隐藏文件（默认 false）
//
// 输出：FileListRes（entries: FileEntry[]）
// ──────────────────────────────────────────────────────────────

import type { FileListRes } from '@novel-writer/shared';
import { z } from 'zod';
import type { IFileService } from '../../file/file-service';
import type { Tool, ToolContext } from '../tool';
import { resolveWithinWorkspace } from './path-guard';

/**
 * list_directory 工具入参 zod schema
 *
 * 与 FileListReqSchema 字段对齐，但 path 允许相对路径。
 * depth 限制最大 10 层，避免大目录 OOM。
 */
const ListDirectoryInputSchema = z.object({
  path: z.string().min(1).describe('目录路径（相对路径基于工作目录解析）'),
  depth: z
    .number()
    .int()
    .positive()
    .max(10)
    .default(1)
    .describe('递归深度（1=仅直接子项，最大 10）'),
  includeHidden: z
    .boolean()
    .default(false)
    .describe('是否包含隐藏文件（点开头文件/目录，默认 false）'),
});

/** list_directory 工具入参类型（从 schema 派生） */
type ListDirectoryInput = z.infer<typeof ListDirectoryInputSchema>;

/** list_directory 工具输出类型（复用 FileListRes） */
type ListDirectoryOutput = FileListRes;

/**
 * 工厂函数：创建 list_directory 工具实例
 *
 * @param fileService 文件服务实例（由 ServiceContainer 注入）
 * @returns Tool 实例（permission: 'auto'）
 */
export function createListDirectoryTool(
  fileService: IFileService,
): Tool<ListDirectoryInput, ListDirectoryOutput> {
  return {
    name: 'list_directory',
    description:
      '列出目录内容（递归深度可控）。返回文件/目录/符号链接列表，含名称、路径、类型、大小、修改时间。路径可相对工作目录或绝对路径（必须在工作目录内）。',
    inputSchema: ListDirectoryInputSchema,
    permission: 'auto',
    execute: async (input: ListDirectoryInput, ctx: ToolContext): Promise<ListDirectoryOutput> => {
      // 路径解析与边界检查
      const absPath = resolveWithinWorkspace(input.path, ctx.workingDir);

      // 调用 FileService 列出目录
      return fileService.list({
        path: absPath,
        depth: input.depth,
        includeHidden: input.includeHidden,
      });
    },
  };
}
