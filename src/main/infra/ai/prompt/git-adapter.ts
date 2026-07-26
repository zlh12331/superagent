// src/main/infra/ai/prompt/git-adapter.ts
// GitService → GitSummaryProvider 适配器
// ──────────────────────────────────────────────────────────────
// 职责：
// - 把 IGitService.status(path) 转换为简化的 GitSummary
// - 供 PromptService 注入到 System Prompt 模板
//
// 设计：
// - 适配器函数：返回闭包，捕获 gitService 实例
// - 错误容忍：任何 git 失败（非 git 仓库 / git 不可用）都返回 null
//   让 dynamic-context.ts 显示"非 git 仓库"占位符
// - 解耦：PromptService 不直接依赖 GitService，仅依赖 GitSummaryProvider 函数签名
// ──────────────────────────────────────────────────────────────

import type { GitStatusRes } from '@novel-writer/shared';
import type { IGitService } from '../../git/git-service';
import type { GitSummaryProvider } from './dynamic-context';

/**
 * 把 IGitService 适配为 GitSummaryProvider
 *
 * PromptService 不直接依赖 GitService（避免主进程启动顺序耦合），
 * 而是通过 ServiceContainer 注入此适配器。
 *
 * @param gitService GitService 实例（由 ServiceContainer 注入）
 * @returns GitSummaryProvider 函数，供 PromptServiceOptions 使用
 */
export function createGitSummaryProvider(gitService: IGitService): GitSummaryProvider {
  return async (workingDir: string) => {
    try {
      const status: GitStatusRes = await gitService.status(workingDir);
      return {
        branch: status.branch,
        clean: status.clean,
        changedFiles: status.files.length,
      };
    } catch {
      // 非 git 仓库 / git 不可用 / 路径错误 → 返回 null
      // dynamic-context.ts 会显示"非 git 仓库"占位符
      return null;
    }
  };
}
