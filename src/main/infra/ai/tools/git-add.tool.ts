// src/main/infra/ai/tools/git-add.tool.ts
// git_add 工具：暂存工作区改动到暂存区（git add）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 将指定路径的工作区改动添加到暂存区
// - paths 为空时执行 git add -A（暂存所有改动）
// - 修改仓库状态，需用户审批后执行
//
// 设计：
// - permission='ask'：修改暂存区会影响后续 commit，需用户确认
// - 路径基于 ctx.workingDir 解析（与 read_file/edit_file 一致）
// - 通过 IGitService 注入，便于测试 mock
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { IGitService } from '../../git/git-service';
import type { Tool, ToolContext, ToolResult } from '../tool';

const GitAddInputSchema = z.object({
  // 要暂存的路径列表（相对 workingDir 或绝对路径）
  // 省略或空数组时暂存所有改动（git add -A）
  paths: z
    .array(z.string().min(1))
    .default([])
    .describe('要暂存的路径列表（相对工作目录或绝对路径，省略时暂存所有改动）'),
});

type GitAddInput = z.infer<typeof GitAddInputSchema>;

export function createGitAddTool(gitService: IGitService): Tool<GitAddInput> {
  return {
    name: 'git_add',
    description:
      '将工作区改动暂存到 Git 暂存区（git add）。paths 为空数组时暂存所有改动（git add -A）；指定具体路径时只暂存这些路径。会修改 Git 仓库状态，需用户审批后执行。建议在 commit 前调用此工具暂存改动。',
    inputSchema: GitAddInputSchema,
    permission: 'ask',
    execute: async (input: GitAddInput, ctx: ToolContext): Promise<ToolResult> => {
      // ctx.workingDir 已是绝对路径，作为 Git 仓库根传给 GitService
      const result = await gitService.add({
        path: ctx.workingDir,
        paths: input.paths,
      });

      const summary =
        input.paths.length === 0
          ? `已暂存全部改动（${result.stagedCount} 个文件已暂存）`
          : `已暂存 ${input.paths.length} 个路径（${result.stagedCount} 个文件已暂存）`;

      return {
        title: 'Git: 暂存改动',
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
