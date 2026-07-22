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
// 输出：FileReadRes（content / totalLines / encoding）
// ──────────────────────────────────────────────────────────────

import type { FileReadRes } from '@novel-writer/shared';
import { z } from 'zod';
import type { IFileService } from '../../file/file-service';
import type { Tool, ToolContext } from '../tool';
import { resolveWithinWorkspace } from './path-guard';

/**
 * read_file 工具入参 zod schema
 *
 * 字段与 FileReadReqSchema 对齐，但 path 允许相对路径
 * （由 path-guard 基于 workingDir 解析为绝对路径）。
 */
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

/** read_file 工具入参类型（从 schema 派生） */
type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

/**
 * read_file 工具输出类型
 *
 * 复用 FileReadRes（content / totalLines / encoding），
 * LLM 据此判断文件是否截断、是否需要继续读取后续行。
 */
type ReadFileOutput = FileReadRes;

/**
 * 工厂函数：创建 read_file 工具实例
 *
 * 使用工厂函数注入 IFileService 依赖，便于：
 * - ServiceContainer 统一管理 FileService 单例并注入到工具
 * - 单元测试注入 mock IFileService
 *
 * @param fileService 文件服务实例（由 ServiceContainer 注入）
 * @returns Tool 实例（permission: 'auto'）
 */
export function createReadFileTool(fileService: IFileService): Tool<ReadFileInput, ReadFileOutput> {
  return {
    name: 'read_file',
    description:
      '读取文件内容（UTF-8 文本）。支持分批读取：通过 offset 和 limit 参数指定起始行和行数。路径可相对工作目录或绝对路径（必须在工作中目录内）。',
    inputSchema: ReadFileInputSchema,
    permission: 'auto',
    execute: async (input: ReadFileInput, ctx: ToolContext): Promise<ReadFileOutput> => {
      // 路径解析与边界检查（越权会抛 UNAUTHORIZED）
      const absPath = resolveWithinWorkspace(input.path, ctx.workingDir);

      // 调用 FileService 读取文件
      // offset/limit 已通过 zod schema 校验为 number | undefined
      return fileService.read({
        path: absPath,
        offset: input.offset,
        limit: input.limit,
      });
    },
  };
}
