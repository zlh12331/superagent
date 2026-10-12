// write-file.tool.ts：write_file 工具——整文件写入/追加（createDirs 可选）
import { promises as fs } from 'node:fs';
import type { FileWriteRes } from '@code-agent/shared/main';
import { z } from 'zod';
import type { IFileService } from '../../file/file-service';
import { t } from '../../i18n';
import { resolveWithinWorkspace } from './path-guard';
import { readTracker } from './read-tracker';
import type { Tool, ToolContext, ToolResult } from './tool';

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

const WriteFileInputSchema = z.object({
  path: z.string().min(1).describe('文件路径（相对路径基于工作目录解析）'),
  content: z.string().describe('文件内容（UTF-8 字符串）'),
  append: z.boolean().default(false).describe('是否追加写入（默认 false 覆盖）'),
  createDirs: z.boolean().default(true).describe('是否自动创建父目录（默认 true）'),
});

type WriteFileInput = z.infer<typeof WriteFileInputSchema>;

export function createWriteFileTool(fileService: IFileService): Tool<WriteFileInput> {
  return {
    name: 'write_file',
    description:
      '写入文件内容（UTF-8 文本）。默认覆盖写入，可通过 append=true 追加到文件末尾。会修改文件系统，需用户审批后执行。路径可相对工作目录或绝对路径（必须在工作目录内）。',
    inputSchema: WriteFileInputSchema,
    permission: 'ask',
    category: 'edit',
    execute: async (input: WriteFileInput, ctx: ToolContext): Promise<ToolResult> => {
      const { resolved, realTarget } = resolveWithinWorkspace(input.path, ctx.workingDir);

      const exists = await fileExists(realTarget);
      if (exists && !readTracker.has(ctx.sessionId, realTarget)) {
        return {
          title: t('tools.fileNotRead'),
          output: '修改已存在文件前必须先读取其内容。请先使用 read_file 工具读取该文件，再写入。',
        };
      }

      const result: FileWriteRes = await fileService.write({
        path: realTarget,
        content: input.content,
        append: input.append,
        createDirs: input.createDirs,
      });

      const action = input.append ? '追加写入' : '写入文件';
      return {
        title: `${action}: ${input.path}`,
        output: `已${action} ${input.path}（${result.bytesWritten} 字节）`,
        metadata: {
          path: resolved,
          bytesWritten: result.bytesWritten,
          append: input.append,
          createDirs: input.createDirs,
        },
      };
    },
  };
}
