// src/main/infra/ai/tools/git-commit.tool.ts
// git_commit 工具：提交暂存区改动（git commit）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 提交当前暂存区的改动到本地仓库
// - 支持普通提交（git commit -m）和追加提交（git commit --amend -m）
// - 创建新的不可逆提交，需用户审批后执行
//
// 设计：
// - permission='ask'：提交是不可逆操作（虽然可 reset 但有副作用），需用户确认
// - 不自动 git add：调用方应先调用 git_add 暂存改动
// - amend=true 时执行 git commit --amend -m <message>（覆盖原提交）
// - 通过 IGitService 注入，便于测试 mock
// - 返回新提交的 SHA 和统计信息，便于 UI 展示
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { IGitService } from '../../git/git-service';
import type { Tool, ToolContext, ToolResult } from './tool';

const GitCommitInputSchema = z.object({
  message: z
    .string()
    .min(1)
    .describe('提交信息（建议遵循 Conventional Commits 规范，如 "feat: 新增X" "fix: 修复Y"）'),
  // 是否追加到上一次提交（amend），默认 false
  amend: z
    .boolean()
    .default(false)
    .describe('是否追加到上一次提交（git commit --amend -m <message>，覆盖原提交信息）'),
});

type GitCommitInput = z.infer<typeof GitCommitInputSchema>;

export function createGitCommitTool(gitService: IGitService): Tool<GitCommitInput> {
  return {
    name: 'git_commit',
    description:
      '提交暂存区改动到本地仓库（git commit -m <message>）。注意：本工具不会自动 git add，调用前应先调用 git_add 暂存改动。amend=true 时执行 git commit --amend -m <message>（覆盖上次提交）。创建新提交是不可逆操作，需用户审批后执行。',
    inputSchema: GitCommitInputSchema,
    permission: 'ask',
    category: 'edit',
    execute: async (input: GitCommitInput, ctx: ToolContext): Promise<ToolResult> => {
      const result = await gitService.commit({
        path: ctx.workingDir,
        message: input.message,
        amend: input.amend,
      });

      const action = input.amend ? '追加提交' : '提交';
      const summary =
        `${action}成功：${result.shortSha} on ${result.branch}\n` +
        `${result.filesChanged} 个文件变更（+${result.additions} / -${result.deletions}）`;

      return {
        title: `Git: ${action}`,
        output: summary,
        metadata: {
          sha: result.sha,
          shortSha: result.shortSha,
          branch: result.branch,
          filesChanged: result.filesChanged,
          additions: result.additions,
          deletions: result.deletions,
          amend: input.amend,
          message: input.message,
          action: 'commit',
        },
      };
    },
  };
}
