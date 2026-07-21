// packages/shared/src/schemas/git.ts
// Git 域 zod schema 单一真源
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 git:status / git:diff 请求-响应 zod schema
// - 供主进程 GitService 校验入参，封装 git CLI 子进程调用
//
// 设计：
// - GitService 通过 child_process.spawn('git', [...args]) 调用 git CLI
// - path 必须为绝对路径，GitService 内部校验为 git 仓库根目录
// - status 返回结构化数据（非 git status 原始文本），便于渲染层消费
// - diff 返回 unified diff 原始文本 + 结构化统计（additions/deletions/filesChanged）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** git:status 入参 zod schema */
export const GitStatusReqSchema = z.object({
  // Git 仓库路径（绝对路径，可为仓库根或子目录，GitService 内部解析根目录）
  path: z.string().min(1),
});

/**
 * Git 文件状态 zod schema
 *
 * status 取值：
 * - 'modified'：已修改
 * - 'added'：新增（已暂存）
 * - 'deleted'：已删除
 * - 'renamed'：重命名（oldPath 为原路径）
 * - 'untracked'：未跟踪（新文件未 git add）
 * - 'conflicted'：合并冲突
 *
 * staged=true 表示已 git add 到暂存区，false 表示在工作区
 */
export const GitFileStatusSchema = z.object({
  path: z.string(),
  status: z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted']),
  // 是否已暂存（git add 过）
  staged: z.boolean(),
  // rename 时的原路径（仅 status='renamed' 时有值）
  oldPath: z
    .string()
    .optional()
    .transform((v) => v ?? undefined),
});

/** Git 文件状态类型 */
export type GitFileStatus = z.infer<typeof GitFileStatusSchema>;

/**
 * git:status 响应 payload
 *
 * 结构化返回工作区状态，避免渲染层解析 git status 原始文本。
 * clean=true 表示工作区无变更（files 为空数组）。
 */
export interface GitStatusRes {
  /** 当前分支名（如 'master' / 'feature/agent'） */
  readonly branch: string;
  /** 领先远程的 commit 数 */
  readonly ahead: number;
  /** 落后远程的 commit 数 */
  readonly behind: number;
  /** 工作区变更文件列表 */
  readonly files: readonly GitFileStatus[];
  /** 工作区是否干净（无变更） */
  readonly clean: boolean;
}

/** git:diff 入参 zod schema */
export const GitDiffReqSchema = z.object({
  path: z.string().min(1),
  // 对比的 ref（默认 'HEAD'，可为分支名、commit hash、'HEAD~1' 等）
  ref: z.string().default('HEAD'),
  // 是否只看暂存区（git diff --cached）
  staged: z.boolean().default(false),
  // 指定文件路径（可选，省略时查看整个仓库 diff）
  filePath: z
    .string()
    .optional()
    .transform((v) => v ?? undefined),
});

/**
 * git:diff 响应 payload
 *
 * diff 为 unified diff 原始文本，渲染层用 react-diff-viewer-continued 渲染。
 * additions/deletions/filesChanged 为结构化统计，便于顶部摘要展示。
 */
export interface GitDiffRes {
  /** unified diff 原始文本 */
  readonly diff: string;
  /** 新增行数 */
  readonly additions: number;
  /** 删除行数 */
  readonly deletions: number;
  /** 变更文件数 */
  readonly filesChanged: number;
}
