// git.ts：Git 域 IPC 契约单一真源——git:status / diff / add / commit / push 的入参 zod schema、
// 响应接口与响应契约 schema，以及 git 引用 / 远程参数的安全校验器。
// 边界：只定义契约（校验 + 默认值）；git 命令的拼装与执行在 src/main/infra/git/git-service.ts。

import { z } from 'zod';

// ── Git 引用 / 远程安全校验（IPC schema 与服务层共用）───────────────────
// 拦两类参数注入：位置参数处的 `--flag` 被 git 按选项解析（option implantation）；
// `<transport>::<addr>` 让 git 运行 git-remote-<transport> helper（ext:: 直接执行本地命令）。
// 两个校验器被本文件 schema 与 GitService 共用，后者覆盖 agent git 工具不经 IPC 的直连路径。

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
  // 先剥离 `+` 强制前缀再逐段校验：否则 `+--upload-pack=evil` 可借前缀绕过「段首不得为 -」
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
  // 控制字符检测不用 \s：空格是合法本地路径成分，仅拒换行 / NUL
  return !/[\n\r\0]/.test(value);
}

// ── 读操作（status / diff）────────────────────────────────

/** git:status 入参 zod schema */
export const GitStatusReqSchema = z.object({
  // Git 仓库路径（绝对路径；可为仓库根或子目录）
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
  staged: z.boolean(),
  // 用 .optional().transform 而非裸 .optional()：推断结果是「必填属性、值可为 undefined」，
  // 在 exactOptionalPropertyTypes 下可直接喂给 GitFileStatus 消费方；值仅 status='renamed' 时有意义
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
  /** 当前分支名（如 'master' / 'feature/agent'；git 读不到分支信息时回落为字面量 '(unknown)'） */
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

/** git:status 响应 zod schema（响应契约校验用：wrap 校验 handler 返回值，防手写接口漂移） */
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
  // 拒绝选项形 ref：`git diff --output=<file>` 可被 git 当选项解析并任意写文件
  ref: z
    .string()
    .default('HEAD')
    .refine(isSafeGitRefValue, 'ref 含非法字符或选项形参数（- 开头 / 空白）'),
  // 是否只看暂存区（git diff --cached）
  staged: z.boolean().default(false),
  // 指定文件路径（可选；省略时查看整个仓库 diff）
  filePath: z
    .string()
    .optional()
    .transform((v) => v ?? undefined),
});

/**
 * git:diff 响应 payload
 *
 * diff 为 unified diff 原始文本，渲染层用 DiffRowsTable
 * （src/renderer/components/common/diff/DiffRowsTable.tsx）渲染（shiki 行高亮）。
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

// ── 写操作（add / commit / push）──────────────────────────

/**
 * git:add 入参 zod schema
 *
 * 将工作区改动添加到暂存区。可指定 paths（相对仓库根或绝对路径），
 * 省略 paths 时执行 `git add -A`（暂存所有改动，含新增/修改/删除）。
 *
 * path 为仓库根或子目录；paths 内若含相对路径，则相对于 path 解析。
 */
export const GitAddReqSchema = z.object({
  path: z.string().min(1),
  paths: z.array(z.string().min(1)).default([]).describe('要暂存的路径列表（省略时暂存所有改动）'),
});

/** git:add 响应 payload */
export interface GitAddRes {
  /** 已暂存的文件数（git add 的输出无法精确解析，此处为统计 staged 文件数） */
  readonly stagedCount: number;
  /** git 命令的原始 stdout（用于调试） */
  readonly stdout: string;
}

/** git:add 响应 zod schema（响应契约校验用） */
export const GitAddResSchema = z.object({
  stagedCount: z.number().int().nonnegative(),
  stdout: z.string(),
});

/**
 * git:commit 入参 zod schema
 *
 * 提交暂存区改动。message 为必填（支持多行，用 \n 分隔）。
 *
 * 只提交已暂存内容，不会自动 git add——调用方须先经 git:add 暂存改动。
 *
 * amend=true 时执行 `git commit --amend -m <message>`（message 覆盖原提交信息，
 * 不豁免必填）。
 */
export const GitCommitReqSchema = z.object({
  path: z.string().min(1),
  message: z.string().min(1).describe('提交信息（支持多行，用 \\n 分隔）'),
  amend: z.boolean().default(false).describe('是否追加到上一次提交（git commit --amend）'),
});

/** git:commit 响应 payload */
export interface GitCommitRes {
  /** 新提交的 SHA（完整 40 字符） */
  readonly sha: string;
  /** 新提交的简短 SHA（前 7 字符；SHA 不足 7 位时原样返回） */
  readonly shortSha: string;
  /** 提交的分支 */
  readonly branch: string;
  /** 本次提交涉及的文件数 */
  readonly filesChanged: number;
  /** 本次提交的增删行数统计（additions/deletions） */
  readonly additions: number;
  readonly deletions: number;
  /** git commit 原始 stdout（GitService 以空串填充：结果已由上方结构化字段表达，勿依赖此字段） */
  readonly stdout: string;
}

/** git:commit 响应 zod schema（响应契约校验用） */
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
 * 推送本地提交到远程。可指定 remote（默认 'origin'）和 refspec（默认空串 = 推送当前分支）。
 *
 * setUpstream=true 时附加 `--set-upstream`（首次推送建立追踪关系）。
 * force=true 时执行 `git push --force-with-lease`（比 `--force` 安全：远程有他人
 * 新提交即失败，不覆盖他人工作）；本 schema 不提供裸 `--force` 通道。
 *
 * 失败不抛错属响应侧约定：ok=false + stderr 供 UI 提示（见 GitPushRes）。
 */
export const GitPushReqSchema = z.object({
  path: z.string().min(1),
  // 拒绝 `::` 传输语法（ext::<cmd> 让 git 直接运行本地命令）与 `-` 开头选项；远程名 / URL / 本地路径均合法
  remote: z
    .string()
    .default('origin')
    .refine(isSafeGitRemote, 'remote 含非法形态（:: 传输语法 / - 开头选项 / 空串 / 换行）')
    .describe('远程名，默认 origin'),
  // 拒绝选项形参数与空白（位置参数处的 --flag 会被 git 按选项解析）
  refspec: z
    .string()
    .default('')
    .refine(isSafeGitRefValue, 'refspec 含非法字符或选项形参数（- 开头 / 空白 / 多个冒号）')
    .describe('引用规格（省略时推送当前分支到同名远程分支）'),
  setUpstream: z.boolean().default(false).describe('是否设置上游（git push -u）'),
  force: z.boolean().default(false).describe('是否使用 --force-with-lease 强制推送'),
});

/** git:push 响应 payload */
export interface GitPushRes {
  /** 推送是否成功（exit code === 0；失败为 false 而非抛错） */
  readonly ok: boolean;
  /** 推送的提交数（推送前后远程 HEAD SHA 对比得出；无法对比时为 0） */
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

/** git:push 响应 zod schema（响应契约校验用） */
export const GitPushResSchema = z.object({
  ok: z.boolean(),
  pushedCount: z.number().int().nonnegative(),
  remote: z.string(),
  refspec: z.string(),
  stdout: z.string(),
  stderr: z.string(),
});
