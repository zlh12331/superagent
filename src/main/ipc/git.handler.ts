// src/main/ipc/git.handler.ts
// Git 域 IPC handler（GitService 暴露给渲染层的入口）
//
// 注册 2 个请求-响应 channel：
// - git:status  获取工作区状态（branch/ahead/behind/files/clean）
// - git:diff    获取 diff（unstaged / staged / 对比任意 ref）
//
// 设计要点：
// - 与 file.handler.ts / search.handler.ts 一致的 DI 模式
// - 入参 zod schema 来自 @novel-writer/shared，handler 不内联定义
// - GitService 仅暴露只读查询接口（status / diff），
//   不暴露 commit / push / merge 等写操作，避免 Code Agent 越权修改用户仓库
//   （写操作通过 TerminalService 由用户手动执行，保留人类监督）
// - git:status / git:diff 都是短任务（spawn 子进程 → 读取 stdout → 子进程退出），
//   不需要管理长期状态，handler 直接转发即可
// - ref / staged / filePath 默认值由 schema 提供（ref='HEAD', staged=false, filePath=undefined），
//   handler 不再硬编码默认值，保证 schema 单一真源
//

import {
  type GitDiffReq,
  GitDiffReqSchema,
  type GitDiffRes,
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
}
