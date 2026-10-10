import { readFileSync, type Stats, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { checkCommitHeader } from './lib/commit-header';

/** 取提交信息首行作为 header（忽略注释行与空行） */
export function extractHeader(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    return trimmed;
  }
  return '';
}

/**
 * 解析当前仓库的 git 目录（worktree 感知）
 *
 * - 常规仓库：`<cwd>/.git` 为目录，直接返回；
 * - linked worktree（并行 worktree 工作流，见 .worktrees/）：`<cwd>/.git` 是指针文件
 *   （`gitdir: <主仓>/.git/worktrees/<name>`），提交信息文件（COMMIT_EDITMSG 等）落在
 *   主仓该子目录下——只认 `<cwd>/.git/` 会把钩子传入的 COMMIT_EDITMSG 误判为越界，
 *   导致 worktree 内所有提交都会被路径守卫拒绝（2026-09-27 实测）。
 *
 * 纯 fs 实现（不派生 git 子进程）：单测以假指针文件模拟 worktree 布局，
 * `git rev-parse --absolute-git-dir` 在该场景下不可用。
 *
 * @returns git 目录绝对路径；`.git` 不存在或指针格式不符时返回 null
 */
export function resolveGitDir(cwd: string): string | null {
  const dotGit = resolve(cwd, '.git');
  let stats: Stats;
  try {
    stats = statSync(dotGit);
  } catch {
    return null;
  }
  if (stats.isDirectory()) {
    return dotGit;
  }
  const pointer = /^gitdir:\s*(.+)$/.exec(readFileSync(dotGit, 'utf8').trim());
  const target = pointer !== null ? pointer[1] : undefined;
  return target !== undefined ? resolve(cwd, target) : null;
}

/**
 * 校验提交信息文件路径是否合法
 *
 * 只允许真实 git 目录内的文件（Git 钩子的约定：`.git/COMMIT_EDITMSG`，
 * rebase 时为 `.git/rebase-merge/…`，linked worktree 时为主仓
 * `.git/worktrees/<name>/…`，均在该目录下）。2026-09-27 修复：此前按
 * `<cwd>/.git` 前缀判定，worktree 内提交被误拒。
 *
 * @param gitDir 显式指定真实 git 目录（调用方已知晓时跳过解析；传 posix
 * 风格路径亦可，resolve 会统一为平台分隔符）
 * @returns 规范化后的绝对路径；不合法时返回 null
 */
export function resolveCommitMsgPath(
  input: string,
  cwd: string,
  gitDir?: string | null,
): string | null {
  const absolute = resolve(cwd, input);
  const base = gitDir ?? resolveGitDir(cwd);
  if (base === null) {
    return null;
  }
  const dir = resolve(base) + sep;
  return absolute.startsWith(dir) ? absolute : null;
}

function readInput(argv: readonly string[], cwd: string): string | null {
  if (argv.includes('--stdin')) {
    return readFileSync(0, 'utf8');
  }
  const file = argv.find((a) => !a.startsWith('--'));
  if (file === undefined) {
    console.error('[check-commit-msg] 用法：tsx scripts/check-commit-msg.ts <文件> | --stdin');
    process.exit(2);
  }
  const safePath = resolveCommitMsgPath(file, cwd);
  if (safePath === null) {
    console.error(`[check-commit-msg] 拒绝读取 .git/ 之外的路径：${file}`);
    process.exit(2);
  }
  return readFileSync(safePath, 'utf8');
}

function main(): void {
  const argv = process.argv.slice(2);
  let raw: string | null;
  try {
    raw = readInput(argv, process.cwd());
  } catch (error) {
    console.error(`[check-commit-msg] 跳过：无法读取提交信息（${String(error)}）`);
    return;
  }
  if (raw === null) {
    return;
  }

  const header = extractHeader(raw);
  const result = checkCommitHeader(header);
  if (result.ok) {
    return;
  }

  console.error('[check-commit-msg] ❌ 提交标题不合规：');
  console.error(`  ${header}`);
  console.error(`  ${result.reason ?? '格式不符'}`);
  console.error('');
  console.error('  正确示例：fix(update): 修复检查超时 / feat: 新增多架构发布');
  process.exit(1);
}

main();
