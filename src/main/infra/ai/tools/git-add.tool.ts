import { z } from 'zod';
import type { IGitService } from '../../git/git-service';
import { t } from '../../i18n';
import type { Tool, ToolContext, ToolResult } from './tool';

const GitAddInputSchema = z.object({
  paths: z
    .array(z.string().min(1))
    .default([])
    .describe('要暂存的路径列表（相对工作目录或绝对路径，省略时暂存所有改动）'),
});

type GitAddInput = z.infer<typeof GitAddInputSchema>;

/**
 * 创建 git_add 工具（暂存改动到 Git 暂存区：paths 为空数组 = 全部暂存；ask 级审批）
 *
 * @param gitService Git 服务（执行实际暂存）
 */
export function createGitAddTool(gitService: IGitService): Tool<GitAddInput> {
  return {
    name: 'git_add',
    description:
      '将工作区改动暂存到 Git 暂存区（git add）。paths 为空数组时暂存所有改动（git add -A）；指定具体路径时只暂存这些路径。会修改 Git 仓库状态，需用户审批后执行。建议在 commit 前调用此工具暂存改动。',
    inputSchema: GitAddInputSchema,
    permission: 'ask',
    category: 'edit',
    execute: async (input: GitAddInput, ctx: ToolContext): Promise<ToolResult> => {
      const result = await gitService.add({
        path: ctx.workingDir,
        paths: input.paths,
      });

      const summary =
        input.paths.length === 0
          ? `已暂存全部改动（${result.stagedCount} 个文件已暂存）`
          : `已暂存 ${input.paths.length} 个路径（${result.stagedCount} 个文件已暂存）`;

      return {
        title: t('tools.gitAdd.title'),
        output: summary,
        metadata: {
          stagedCount: result.stagedCount,
          paths: input.paths,
          action: 'add',
        },
      };
    },
  };
}
