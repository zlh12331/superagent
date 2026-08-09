// src/main/infra/ai/tools/git-push.tool.ts
// git_push 工具：推送本地提交到远程（git push）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 推送本地提交到远程仓库
// - 支持 -u（设置上游）和 --force-with-lease（更安全的强制推送）
// - 修改远程仓库，影响他人，需用户审批后执行
//
// 设计：
// - permission='ask'：推送到远程会影响他人，是高风险操作
// - 禁止 --force：使用 --force-with-lease 替代，避免覆盖他人提交
// - push 失败不抛错，返回 ok=false 便于 LLM 继续对话
// - 通过 IGitService 注入，便于测试 mock
// - 返回 ok/pushedCount 和原始 stderr，便于诊断推送失败
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { IGitService } from '../../git/git-service';
import type { Tool, ToolContext, ToolResult } from './tool';

const GitPushInputSchema = z.object({
  remote: z.string().default('origin').describe('远程名，默认 origin'),
  refspec: z
    .string()
    .default('')
    .describe('引用规格（如 "master"、"feature/x"，省略时推送当前分支到同名远程分支）'),
  // 是否设置上游（首次推送时使用），默认 false
  setUpstream: z
    .boolean()
    .default(false)
    .describe('是否设置上游（git push -u，首次推送时使用以建立追踪关系）'),
  // 是否使用 --force-with-lease（更安全的强制推送），默认 false
  force: z
    .boolean()
    .default(false)
    .describe('是否使用 --force-with-lease 强制推送（比 --force 安全，远程有他人提交时会失败）'),
});

type GitPushInput = z.infer<typeof GitPushInputSchema>;

export function createGitPushTool(gitService: IGitService): Tool<GitPushInput> {
  return {
    name: 'git_push',
    description:
      '推送本地提交到远程仓库（git push）。支持设置上游（-u，首次推送使用）和强制推送（--force-with-lease，比 --force 安全）。push 到远程会影响他人，是高风险操作，需用户审批后执行。push 失败（如远程拒绝、网络问题）会返回 ok=false 而非抛错，便于继续对话。',
    inputSchema: GitPushInputSchema,
    permission: 'ask',
    category: 'edit',
    execute: async (input: GitPushInput, ctx: ToolContext): Promise<ToolResult> => {
      const result = await gitService.push({
        path: ctx.workingDir,
        remote: input.remote,
        refspec: input.refspec,
        setUpstream: input.setUpstream,
        force: input.force,
      });

      if (!result.ok) {
        const target =
          input.refspec.length > 0
            ? `${input.remote}/${input.refspec}`
            : `${input.remote}/<current-branch>`;
        return {
          title: 'Git: 推送失败',
          output: `推送失败：${target}\n${result.stderr}`,
          metadata: {
            ok: false,
            pushedCount: 0,
            remote: result.remote,
            refspec: result.refspec,
            stderr: result.stderr,
            action: 'push',
          },
        };
      }

      const target =
        input.refspec.length > 0
          ? `${input.remote}/${input.refspec}`
          : `${input.remote}/<current-branch>`;
      const summary =
        `推送成功：${target}（${result.pushedCount} 个提交）\n` +
        (result.stderr.length > 0 ? result.stderr : '');

      return {
        title: 'Git: 推送成功',
        output: summary,
        metadata: {
          ok: true,
          pushedCount: result.pushedCount,
          remote: result.remote,
          refspec: result.refspec,
          setUpstream: input.setUpstream,
          force: input.force,
          action: 'push',
        },
      };
    },
  };
}
