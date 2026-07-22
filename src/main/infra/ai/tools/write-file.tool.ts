// src/main/infra/ai/tools/write-file.tool.ts
// write_file 工具：封装 FileService.write，供 Code Agent 写入文件
// ──────────────────────────────────────────────────────────────
// 职责：
// - 接收 LLM 生成的 path/content/append/createDirs 入参
// - 通过 path-guard 把路径解析为 workingDir 内的绝对路径
// - 调用 FileService.write 写入文件
//
// 权限：'ask'（写操作有副作用，需用户审批）
// - 覆盖已有文件可能造成数据丢失
// - 创建新文件可能影响项目结构
// - 用户需确认后再执行
//
// 入参：
// - path：文件路径（相对或绝对）
// - content：文件内容（UTF-8 字符串）
// - append：是否追加（默认 false 覆盖）；true 时在文件末尾追加
// - createDirs：是否自动创建父目录（默认 true）
//
// 输出：FileWriteRes（bytesWritten）
// ──────────────────────────────────────────────────────────────

import type { FileWriteRes } from '@novel-writer/shared';
import { z } from 'zod';
import type { IFileService } from '../../file/file-service';
import type { Tool, ToolContext } from '../tool';
import { resolveWithinWorkspace } from './path-guard';

/**
 * write_file 工具入参 zod schema
 *
 * 与 FileWriteReqSchema 字段对齐，但 path 允许相对路径。
 * append/createDirs 提供 LLM 友好的默认值。
 */
const WriteFileInputSchema = z.object({
  path: z.string().min(1).describe('文件路径（相对路径基于工作目录解析）'),
  content: z.string().describe('文件内容（UTF-8 字符串）'),
  append: z.boolean().default(false).describe('是否追加写入（默认 false 覆盖）'),
  createDirs: z.boolean().default(true).describe('是否自动创建父目录（默认 true）'),
});

/** write_file 工具入参类型（从 schema 派生） */
type WriteFileInput = z.infer<typeof WriteFileInputSchema>;

/** write_file 工具输出类型（复用 FileWriteRes） */
type WriteFileOutput = FileWriteRes;

/**
 * 工厂函数：创建 write_file 工具实例
 *
 * @param fileService 文件服务实例（由 ServiceContainer 注入）
 * @returns Tool 实例（permission: 'ask'）
 */
export function createWriteFileTool(
  fileService: IFileService,
): Tool<WriteFileInput, WriteFileOutput> {
  return {
    name: 'write_file',
    description:
      '写入文件内容（UTF-8 文本）。默认覆盖写入，可通过 append=true 追加到文件末尾。会修改文件系统，需用户审批后执行。路径可相对工作目录或绝对路径（必须在工作目录内）。',
    inputSchema: WriteFileInputSchema,
    permission: 'ask',
    execute: async (input: WriteFileInput, ctx: ToolContext): Promise<WriteFileOutput> => {
      // 路径解析与边界检查
      const absPath = resolveWithinWorkspace(input.path, ctx.workingDir);

      // 调用 FileService 写入文件
      return fileService.write({
        path: absPath,
        content: input.content,
        append: input.append,
        createDirs: input.createDirs,
      });
    },
  };
}
