// src/main/infra/ai/tools/edit-file.tool.ts
// edit_file 工具：基于字符串替换的结构化文件编辑
// ──────────────────────────────────────────────────────────────

import { promises as fs } from 'node:fs';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../tool';
import { resolveWithinWorkspace } from './path-guard';

const EditFileInputSchema = z.object({
  path: z.string().min(1).describe('文件路径（相对路径基于工作目录解析）'),
  oldString: z
    .string()
    .min(1)
    .describe('要查找的字符串（必须在文件中存在；除非 replaceAll=true，否则必须唯一）'),
  newString: z.string().describe('替换后的字符串（可为空字符串，表示删除 oldString）'),
  replaceAll: z
    .boolean()
    .default(false)
    .describe('是否替换所有匹配项（默认 false，要求 oldString 在文件中唯一）'),
});

type EditFileInput = z.infer<typeof EditFileInputSchema>;

function countLines(s: string): number {
  if (s.length === 0) return 0;
  return s.split('\n').length;
}

export function createEditFileTool(): Tool<EditFileInput> {
  return {
    name: 'edit_file',
    description:
      '通过字符串替换精确编辑文件（不重写整个文件）。查找 oldString 并替换为 newString，默认要求 oldString 在文件中唯一（防止误替换）。设置 replaceAll=true 可替换所有匹配项。newString 为空字符串时表示删除 oldString。会修改文件系统，需用户审批后执行。',
    inputSchema: EditFileInputSchema,
    permission: 'ask',
    category: 'edit',
    execute: async (input: EditFileInput, ctx: ToolContext): Promise<ToolResult> => {
      const absPath = resolveWithinWorkspace(input.path, ctx.workingDir);

      let original: string;
      try {
        original = await fs.readFile(absPath, 'utf-8');
      } catch (error) {
        const nodeError = error as { code?: string };
        if (nodeError.code === 'ENOENT') {
          throw new AppError(ErrorCode.NOT_FOUND, `文件不存在：${absPath}`, error);
        }
        throw new AppError(ErrorCode.FS_READ_FAILED, '读取文件失败', error);
      }

      const parts = original.split(input.oldString);
      const matchCount = parts.length - 1;

      if (matchCount === 0) {
        throw new AppError(
          ErrorCode.INVALID_INPUT,
          `oldString 在文件中未找到。请先用 read_file 工具查看文件内容，确认 oldString 与文件实际内容完全一致（包括缩进、换行符）。`,
        );
      }

      if (matchCount > 1 && !input.replaceAll) {
        throw new AppError(
          ErrorCode.INVALID_INPUT,
          `oldString 在文件中出现 ${matchCount} 次，但 replaceAll=false。请提供更长、更唯一的 oldString，或设置 replaceAll=true 替换所有匹配项。`,
        );
      }

      const updated =
        matchCount === 1
          ? original.replace(input.oldString, input.newString)
          : original.split(input.oldString).join(input.newString);

      const replacedCount = input.replaceAll ? matchCount : 1;
      const oldLines = countLines(input.oldString);
      const newLines = countLines(input.newString);
      const addedLines = newLines * replacedCount;
      const removedLines = oldLines * replacedCount;

      try {
        const buffer = Buffer.from(updated, 'utf-8');
        await fs.writeFile(absPath, buffer);
        const isDelete = input.newString.length === 0;
        const action = isDelete ? '删除' : input.replaceAll ? '替换全部' : '替换';
        return {
          title: `编辑文件: ${input.path}`,
          output: `已${action} ${replacedCount} 处（+${addedLines} 行 / -${removedLines} 行，写入 ${buffer.byteLength} 字节）`,
          metadata: {
            path: absPath,
            bytesWritten: buffer.byteLength,
            replacedCount,
            addedLines,
            removedLines,
          },
        };
      } catch (error) {
        throw new AppError(ErrorCode.FS_WRITE_FAILED, '写入文件失败', error);
      }
    },
  };
}
