// src/main/infra/ai/tools/list-directory.tool.ts
// list_directory 工具：封装 FileService.list，供 Code Agent 列出目录内容
// ──────────────────────────────────────────────────────────────

import type { FileListRes } from '@code-agent/shared/main';
import { z } from 'zod';
import type { IFileService } from '../../file/file-service';
import type { Tool, ToolContext, ToolResult } from '../tool';
import { resolveWithinWorkspace } from './path-guard';

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

type ListDirectoryInput = z.infer<typeof ListDirectoryInputSchema>;

export function createListDirectoryTool(fileService: IFileService): Tool<ListDirectoryInput> {
  return {
    name: 'list_directory',
    description:
      '列出目录内容（递归深度可控）。返回文件/目录/符号链接列表，含名称、路径、类型、大小、修改时间。路径可相对工作目录或绝对路径（必须在工作目录内）。',
    inputSchema: ListDirectoryInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: ListDirectoryInput, ctx: ToolContext): Promise<ToolResult> => {
      const absPath = resolveWithinWorkspace(input.path, ctx.workingDir);

      const result: FileListRes = await fileService.list({
        path: absPath,
        depth: input.depth,
        includeHidden: input.includeHidden,
      });

      const lines = result.entries.map((e) => {
        const typeChar = e.type === 'directory' ? 'd' : e.type === 'symlink' ? 'l' : '-';
        const sizeStr = e.size !== undefined ? `${e.size}B` : '';
        return `${typeChar} ${e.name}${sizeStr ? `  ${sizeStr}` : ''}`;
      });

      return {
        title: `列出目录: ${input.path}`,
        output: lines.join('\n') || '(空目录)',
        metadata: {
          path: absPath,
          depth: input.depth,
          count: result.entries.length,
          entries: result.entries,
        },
      };
    },
  };
}
