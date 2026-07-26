// src/main/infra/ai/tools/read-file.tool.ts
// read_file 工具：封装 FileService.read，供 Code Agent 读取文件内容
// ──────────────────────────────────────────────────────────────
// 职责：
// - 接收 LLM 生成的 path/offset/limit 入参
// - 通过 path-guard 把路径解析为 workingDir 内的绝对路径
// - 调用 FileService.read 读取文件内容
//
// 权限：'auto'（只读操作，无副作用，自动执行）
//
// 入参：
// - path：文件路径（相对或绝对，相对路径基于 workingDir 解析）
// - offset：起始行（0-based，省略时从第 0 行开始）
// - limit：读取行数（省略时读到文件末尾）
//
// 输出：ToolResult（title + output 文本 + metadata 结构化数据）
// ──────────────────────────────────────────────────────────────

import type { FileReadRes } from '@novel-writer/shared';
import { z } from 'zod';
import type { IFileService } from '../../file/file-service';
import type { Tool, ToolContext, ToolResult } from '../tool';
import { resolveWithinWorkspace } from './path-guard';

const ReadFileInputSchema = z.object({
  path: z.string().min(1).describe('文件路径（相对路径基于工作目录解析）'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('起始行（0-based），省略时从第 0 行开始')
    .transform((v) => v ?? undefined),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('读取行数，省略时读到文件末尾')
    .transform((v) => v ?? undefined),
});

type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

export function createReadFileTool(fileService: IFileService): Tool<ReadFileInput> {
  return {
    name: 'read_file',
    description:
      '读取文件内容（UTF-8 文本）。支持分批读取：通过 offset 和 limit 参数指定起始行和行数。路径可相对工作目录或绝对路径（必须在工作中目录内）。',
    inputSchema: ReadFileInputSchema,
    permission: 'auto',
    execute: async (input: ReadFileInput, ctx: ToolContext): Promise<ToolResult> => {
      const absPath = resolveWithinWorkspace(input.path, ctx.workingDir);

      const result: FileReadRes = await fileService.read({
        path: absPath,
        offset: input.offset,
        limit: input.limit,
      });

      return {
        title: `读取文件: ${input.path}`,
        output: result.content,
        metadata: {
          path: absPath,
          totalLines: result.totalLines,
          encoding: result.encoding,
          offset: input.offset ?? 0,
          limit: input.limit,
        },
      };
    },
  };
}
