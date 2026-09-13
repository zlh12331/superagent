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

// ── Git 引用/远程安全校验（P0 收口共享工具） ──────────────────
//
// 背景：git remote/refspec/ref 曾为自由字符串透传。git 对位置参数处的
// `--flag` 按选项解析（option implantation），且 `ext::<cmd>` 远程传输会
// 由 git 直接运行本地命令——IPC 边界与 agent 工具层都必须拦截。
// 本组校验器同时被 zod schema（IPC 边界）与 GitService（服务层 choke
// point，覆盖 agent git 工具的直连调用）消费。

/** Git 引用段合法字符集（分支/tag/sha 通用）：字母数字与 . _ / - ~ ^ * @ { } */
const GIT_REF_SEGMENT = /^[A-Za-z0-9._~^*@{}/-]+$/;

/**
 * 校验 Git 引用值（ref / refspec 通用）
 *
 * 规则：
 * - 空串合法（push refspec 的省略语义 = 推送当前分支）
 * - 可选 `+` 前缀（引用规格的强制推送语义）
 * - 至多一个 `:`（src[:dst]）；空段合法（git 的删除语义，由调用方业务把关）
 * - 每段不得以 `-` 开头（防 option implantation）、不含空白/控制字符
 */
export function isSafeGitRefValue(value: string): boolean {
  if (value === '') {
    return true;
  }
  const spec = value.startsWith('+') ? value.slice(1) : value;
  const parts = spec.split(':');
  if (parts.length > 2) {
    return false;
  }
  return parts.every(
    (part) =>
      part === '' || (!part.startsWith('-') && !/\s/.test(part) && GIT_REF_SEGMENT.test(part)),
  );
}

/**
 * 校验 Git 远程标识
 *
 * git 远程的「命令运行」原语只有两个，按 denylist 精确拦截：
 * - `<transport>::<addr>` 语法：git 会运行 `git-remote-<transport>` helper，
 *   其中 `ext::<cmd>` 直接运行任意本地命令——拒绝一切含 `::` 的值
 * - `-` 开头：选项形参数（argv 位置上的 --flag 会被 git 当选项解析）——拒绝
 * 其余形态均安全：远程名、https/ssh URL、本地路径（含空格，spawn 走 argv
 * 数组不经 shell）、scp 形态。空串与换行/控制字符同样拒绝（畸形参数）。
 */
export function isSafeGitRemote(value: string): boolean {
  if (value === '' || value.startsWith('-') || value.includes('::')) {
    return false;
  }
  // 控制字符检测不用 \s（空格是合法路径成分），仅拒换行/NUL
  return !/[\n\r\0]/.test(value);
}

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

/** git:status 响应 zod schema（响应契约校验用） */
export const GitStatusResSchema = z.object({
  branch: z.string(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(GitFileStatusSchema),
  clean: z.boolean(),
});

/** git:diff 入参 zod schema */
export const GitDiffReqSchema = z.object({
  path: z.string().min(1),
  // 对比的 ref（默认 'HEAD'，可为分支名、commit hash、'HEAD~1' 等）
  // 安全：拒绝 `--` 开头的选项形参数（git diff --output=<file> 可任意写文件）
  ref: z
    .string()
    .default('HEAD')
    .refine(isSafeGitRefValue, 'ref 含非法字符或选项形参数（- 开头 / 空白）'),
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

/** git:diff 响应 zod schema（响应契约校验用） */
export const GitDiffResSchema = z.object({
  diff: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  filesChanged: z.number().int().nonnegative(),
});

// ── Git 写操作（add / commit / push）──────────────────────

/**
 * git:add 入参 zod schema
 *
 * 将工作区改动添加到暂存区。可指定 paths（相对仓库根或绝对路径），
 * 省略 paths 时执行 `git add -A`（暂存所有改动，含新增/修改/删除）。
 *
 * path 为仓库根或子目录（GitService 内部解析根目录）。
 * paths 内若含相对路径，则相对于 path 解析。
 */
export const GitAddReqSchema = z.object({
  // 仓库路径（绝对路径，可为仓库根或子目录）
  path: z.string().min(1),
  // 要暂存的路径列表（相对 path 或绝对路径）
  // 省略或空数组时执行 git add -A（暂存所有改动）
  paths: z.array(z.string().min(1)).default([]).describe('要暂存的路径列表（省略时暂存所有改动）'),
});

/** git:add 响应 payload */
export interface GitAddRes {
  /** 已暂存的文件数（git add 的输出无法精确解析，此处为统计 staged 文件数） */
  readonly stagedCount: number;
  /** git 命令的原始 stdout（用于调试） */
  readonly stdout: string;
}

/** git:add 响应 zod schema（R2：响应契约校验） */
export const GitAddResSchema = z.object({
  stagedCount: z.number().int().nonnegative(),
  stdout: z.string(),
});

/**
 * git:commit 入参 zod schema
 *
 * 提交暂存区改动。message 为必填，支持多行（用 \n 分隔）。
 *
 * 注意：本工具只执行 `git commit -m <message>`，不会自动 git add。
 * 调用方应先调用 git:add 暂存改动，再调用 git:commit 提交。
 *
 * amend=true 时执行 `git commit --amend --no-edit`（保留原 message），
 * 此时 message 可省略；若同时提供 message 则覆盖原 message。
 */
export const GitCommitReqSchema = z.object({
  path: z.string().min(1),
  message: z.string().min(1).describe('提交信息（支持多行，用 \\n 分隔）'),
  // 是否追加到上一次提交（amend），默认 false
  amend: z.boolean().default(false).describe('是否追加到上一次提交（git commit --amend）'),
});

/** git:commit 响应 payload */
export interface GitCommitRes {
  /** 新提交的 SHA（完整 40 字符） */
  readonly sha: string;
  /** 新提交的简短 SHA（前 7 字符） */
  readonly shortSha: string;
  /** 提交的分支 */
  readonly branch: string;
  /** 本次提交涉及的文件数 */
  readonly filesChanged: number;
  /** 本次提交的增删行数统计（additions/deletions） */
  readonly additions: number;
  readonly deletions: number;
  /** git commit 原始 stdout（用于调试） */
  readonly stdout: string;
}

/** git:commit 响应 zod schema（R2：响应契约校验） */
export const GitCommitResSchema = z.object({
  sha: z.string().min(1),
  shortSha: z.string().min(1),
  branch: z.string(),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  stdout: z.string(),
});

/**
 * git:push 入参 zod schema
 *
 * 推送本地提交到远程。可指定 remote（默认 'origin'）和 refspec（默认当前分支）。
 *
 * setUpstream=true 时附加 `--set-upstream`（首次推送时建立追踪关系）。
 * force=true 时执行 `git push --force-with-lease`（更安全的强制推送，
 * 若远程有他人新提交则会失败，避免覆盖他人工作）。
 *
 * 安全策略：
 * - 禁止 `--force` 直接推送（用 `--force-with-lease` 替代）
 * - 禁止推送到 protected 分支（由调用方业务层校验，本 schema 不约束）
 */
export const GitPushReqSchema = z.object({
  path: z.string().min(1),
  // 远程名（默认 'origin'）
  // 安全：拒绝 `::` 传输语法（ext::<cmd> 会让 git 直接运行本地命令）
  // 与 `-` 开头的选项形参数；远程名/URL/本地路径均合法
  remote: z
    .string()
    .default('origin')
    .refine(isSafeGitRemote, 'remote 含非法形态（:: 传输语法 / - 开头选项 / 空串 / 换行）')
    .describe('远程名，默认 origin'),
  // 引用规格（默认当前分支，可为 'master'、'feature/x' 等）
  // 安全：拒绝选项形参数与空白（位置参数处的 --flag 会被 git 按选项解析）
  refspec: z
    .string()
    .default('')
    .refine(isSafeGitRefValue, 'refspec 含非法字符或选项形参数（- 开头 / 空白 / 多个冒号）')
    .describe('引用规格（省略时推送当前分支到同名远程分支）'),
  // 是否设置上游（首次推送时使用），默认 false
  setUpstream: z.boolean().default(false).describe('是否设置上游（git push -u）'),
  // 是否使用 --force-with-lease（更安全的强制推送），默认 false
  force: z.boolean().default(false).describe('是否使用 --force-with-lease 强制推送'),
});

/** git:push 响应 payload */
export interface GitPushRes {
  /** 推送是否成功（exit code === 0） */
  readonly ok: boolean;
  /** 推送的提交数（从 git push 输出解析） */
  readonly pushedCount: number;
  /** 推送的目标远程 */
  readonly remote: string;
  /** 推送的目标 refspec */
  readonly refspec: string;
  /** git push 的原始 stdout（含远程拒绝信息） */
  readonly stdout: string;
  /** git push 的原始 stderr（含进度信息） */
  readonly stderr: string;
}

/** git:push 响应 zod schema（R2：响应契约校验） */
export const GitPushResSchema = z.object({
  ok: z.boolean(),
  pushedCount: z.number().int().nonnegative(),
  remote: z.string(),
  refspec: z.string(),
  stdout: z.string(),
  stderr: z.string(),
});
