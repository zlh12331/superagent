// scripts/check-commit-msg.ts
// 提交信息严格校验（.husky/commit-msg 钩子调用；CI 亦可单独跑）
// ──────────────────────────────────────────────────────────────
// 用法（钩子）：tsx scripts/check-commit-msg.ts <commit-msg-文件路径>
//   Git 约定：钩子收到 `.git/COMMIT_EDITMSG` 路径，首行即 header。
//   带 --stdin 时从标准输入读标题（便于手工验证）。
//
// 为什么需要（2026-09-20 实证）：commitlint 的默认 header 解析对
// `fix(autostart)+build(release): …` 会贪婪地把 `(autostart)+build(release)`
// 当作 scope 吞掉，于是只触发 warning 级的 scope-enum 而放行；但 release-please
// 用严格解析器，对该 header 抛 `unexpected token '+' at 1:15` 并跳过提交——
// 当它是版本区间内唯一提交时即「0 commits」→ 不开 Release PR（发版通道静默阻断）。
// commitlint 21.x 无 header-pattern 规则（未知规则会抛错），故以本脚本补齐。
//
// 路径安全：本脚本只应读取仓库 git 目录下的提交信息文件（钩子约定）。传入的路径经
// resolve 后必须位于该目录之内，否则拒绝——避免被用作任意文件读取入口。
// linked worktree 的 git 目录不在 <cwd>/.git/ 而在主仓 .git/worktrees/<name>/，
// 按 .git 指针文件解析（见 resolveGitDir）。
// ──────────────────────────────────────────────────────────────

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
 * 解析当前仓库的 git 目录
 *
 * - 常规仓库：`<cwd>/.git` 为目录，直接返回；
 * - linked worktree：`<cwd>/.git` 是指针文件（`gitdir: <主仓>/.git/worktrees/<name>`），
 *   提交信息文件（COMMIT_EDITMSG 等）落在主仓该子目录下——必须按指针解析，
 *   否则 worktree 内所有提交都会被路径守卫拒绝（2026-09-27 实测）。
 *
 * @returns git 目录绝对路径；`.git` 不存在或指针格式不符时返回 null
 */
function resolveGitDir(cwd: string): string | null {
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
 * 只允许仓库 git 目录内的文件（Git 钩子的约定：`.git/COMMIT_EDITMSG`，
 * rebase 时为 `.git/rebase-merge/…`，linked worktree 时为主仓
 * `.git/worktrees/<name>/…`，均在该目录下）。
 *
 * @returns 规范化后的绝对路径；不合法时返回 null
 */
export function resolveCommitMsgPath(input: string, cwd: string): string | null {
  const absolute = resolve(cwd, input);
  const gitDir = resolveGitDir(cwd);
  if (gitDir === null) {
    return null;
  }
  return absolute.startsWith(gitDir + sep) ? absolute : null;
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
    // 读不到文件（如首次提交尚无 COMMIT_EDITMSG）：不阻断，交由 commitlint 处理
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
