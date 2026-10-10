import type { FileReadRes } from '@code-agent/shared/main';
import { z } from 'zod';
import type { IFileService } from '../../file/file-service';
import { t } from '../../i18n';
import { resolveWithinWorkspace } from './path-guard';
import { readTracker } from './read-tracker';
import type { Tool, ToolContext, ToolResult } from './tool';

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

/**
 * 创建 read_file 工具（读取工作目录内 UTF-8 文本文件，支持 offset/limit 分批读取）
 *
 * @param fileService 文件服务（执行实际读取）
 */
export function createReadFileTool(fileService: IFileService): Tool<ReadFileInput> {
  return {
    name: 'read_file',
    description:
      '读取文件内容（UTF-8 文本）。支持分批读取：通过 offset 和 limit 参数指定起始行和行数。路径可相对工作目录或绝对路径（必须在工作中目录内）。',
    inputSchema: ReadFileInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: ReadFileInput, ctx: ToolContext): Promise<ToolResult> => {
      const { resolved, realTarget } = resolveWithinWorkspace(input.path, ctx.workingDir);

      const result: FileReadRes = await fileService.read({
        path: realTarget,
        offset: input.offset,
        limit: input.limit,
      });
      readTracker.record(ctx.sessionId, realTarget);

      return {
        title: t('tools.readFile.title', { path: input.path }),
        output: result.content,
        metadata: {
          path: resolved,
          totalLines: result.totalLines,
          encoding: result.encoding,
          offset: input.offset ?? 0,
          limit: input.limit,
        },
      };
    },
  };
}
