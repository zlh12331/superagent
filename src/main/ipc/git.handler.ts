// src/main/ipc/git.handler.ts
// Git 域 IPC handler（GitService 暴露给渲染层的入口）
//
// 注册 5 个请求-响应 channel：
// 只读：
// - git:status  获取工作区状态（branch/ahead/behind/files/clean）
// - git:diff    获取 diff（unstaged / staged / 对比任意 ref）
// 写操作：
// - git:add     暂存工作区改动（git add）
// - git:commit  提交暂存区改动（git commit -m，支持 --amend）
// - git:push    推送本地提交到远程（git push，支持 --force-with-lease 和 -u）
//
// 设计要点：
// - 与 file.handler.ts / search.handler.ts 一致的 DI 模式
// - 入参 zod schema 来自 @novel-writer/shared，handler 不内联定义
// - GitService 通过 spawn('git') 调用系统 CLI，handler 不重复实现 git 逻辑
// - 写操作通过 Agent 工具系统触发（git-add.tool / git-commit.tool / git-push.tool），
//   渲染层也可以直接通过 IPC 调用（如 DevPanel 的 Git 面板）
// - 写操作的安全性由两层保护：
//   · 渲染层（DevPanel）：用户主动点击，无需审批
//   · Agent 工具：通过 Tool.permission='ask' 触发审批门
// - git:status / git:diff 都是短任务（spawn 子进程 → 读取 stdout → 子进程退出），
//   不需要管理长期状态，handler 直接转发即可
// - git:push 可能较慢（网络 IO），但仍是请求-响应模式，无流式进度推送
// - ref / staged / filePath / amend / setUpstream / force 默认值由 schema 提供，
//   handler 不再硬编码默认值，保证 schema 单一真源
//

import {
  type GitAddReq,
  GitAddReqSchema,
  type GitAddRes,
  type GitCommitReq,
  GitCommitReqSchema,
  type GitCommitRes,
  type GitDiffReq,
  GitDiffReqSchema,
  type GitDiffRes,
  type GitPushReq,
  GitPushReqSchema,
  type GitPushRes,
  type GitStatusReq,
  GitStatusReqSchema,
  type GitStatusRes,
  IPC_CHANNELS,
} from '@novel-writer/shared';
import type { IGitService } from '../infra/git/git-service';
import { wrap } from '../utils/wrap';

/**
 * Git 域 handler 依赖
 *
 * 通过依赖注入解耦 handler 与具体 GitService 实现：
 * - 生产环境：ServiceContainer 注入默认 GitService 实例（基于 child_process.spawn('git')）
 * - 测试环境：可注入 mock 实现，不依赖真实 git CLI
 */
export interface GitHandlerDeps {
  /** GitService 实例（由 ServiceContainer 注入） */
  readonly gitService: IGitService;
}

/**
 * 注册 Git 域 IPC handler
 *
 * 在 app.whenReady() 后调用一次，与 registerFileHandlers / registerSearchHandlers /
 * registerTerminalHandlers 并列。
 *
 * @param deps 依赖项：包含 IGitService 实例
 *
 * 幂等性：重复调用会因 ipcMain.handle 对同一 channel 重复注册而抛错，
 * 但正常流程不会触发——本函数只在 whenReady 中调用一次。
 */
export function registerGitHandlers(deps: GitHandlerDeps): void {
  const { gitService } = deps;

  // ── 只读操作 ────────────────────────────────────────────

  // 获取工作区状态：基于 `git status --porcelain=v2 -b` 解析
  // 返回结构化数据（branch / ahead / behind / files / clean），
  // 渲染层直接渲染，无需解析 git 原始文本
  // files 包含工作区 + 暂存区所有变更，含 status（modified/added/...）与 staged 标志
  wrap<GitStatusReq, GitStatusRes>(IPC_CHANNELS.GIT_STATUS, GitStatusReqSchema, async (input) => {
    return gitService.status(input.path);
  });

  // 获取 diff：基于 `git diff [--cached] <ref> [-- <filePath>]`
  // 返回 unified diff 原始文本 + 结构化统计（addions/deletions/filesChanged）
  // staged=true 时使用 --cached 查看暂存区 diff
  // filePath 指定时只看单个文件 diff（避免大仓库全量 diff 性能问题）
  wrap<GitDiffReq, GitDiffRes>(IPC_CHANNELS.GIT_DIFF, GitDiffReqSchema, async (input) => {
    return gitService.diff({
      path: input.path,
      ref: input.ref,
      staged: input.staged,
      filePath: input.filePath,
    });
  });

  // ── 写操作 ──────────────────────────────────────────────

  // 暂存工作区改动：基于 `git add -A` 或 `git add -- <paths>`
  // paths 为空时暂存所有改动（git add -A）
  // 返回 stagedCount（已暂存文件数）和原始 stdout
  wrap<GitAddReq, GitAddRes>(IPC_CHANNELS.GIT_ADD, GitAddReqSchema, async (input) => {
    return gitService.add({
      path: input.path,
      paths: input.paths,
    });
  });

  // 提交暂存区改动：基于 `git commit -m <message>` 或 `git commit --amend -m <message>`
  // 返回新提交的 SHA、分支名、filesChanged、additions、deletions
  // 注意：本接口不自动 git add，调用方应先调用 git:add
  wrap<GitCommitReq, GitCommitRes>(IPC_CHANNELS.GIT_COMMIT, GitCommitReqSchema, async (input) => {
    return gitService.commit({
      path: input.path,
      message: input.message,
      amend: input.amend,
    });
  });

  // 推送本地提交到远程：基于 `git push [-u] [--force-with-lease] <remote> [<refspec>]`
  // force=true 时使用 --force-with-lease（更安全的强制推送）
  // 返回 ok=true/false、pushedCount、原始 stdout 和 stderr
  // push 失败（远程拒绝、网络问题）返回 ok=false 而非抛错
  wrap<GitPushReq, GitPushRes>(IPC_CHANNELS.GIT_PUSH, GitPushReqSchema, async (input) => {
    return gitService.push({
      path: input.path,
      remote: input.remote,
      refspec: input.refspec,
      setUpstream: input.setUpstream,
      force: input.force,
    });
  });
}
