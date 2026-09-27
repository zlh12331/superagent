// scripts/check-commit-msg.test.ts
// resolveCommitMsgPath 单测：常规仓库 / linked worktree gitdir 指针 / 越界拒绝
// （2026-09-27 worktree 修复的回归测试——指针文件此前被路径守卫一刀切拒绝）

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCommitMsgPath } from './check-commit-msg';

/** 构造临时仓库根 + 嵌套的提交信息文件，返回根目录路径 */
function makeRoot(kind: 'repo' | 'worktree'): string {
  const root = mkdtempSync(join(tmpdir(), 'commit-msg-guard-'));
  const mainGitDir = join(root, 'main-repo', '.git');
  mkdirSync(mainGitDir, { recursive: true });
  if (kind === 'repo') {
    // 常规仓库：root 自身即仓库根，.git 为目录
    mkdirSync(join(root, '.git'), { recursive: true });
  } else {
    // linked worktree：.git 为指针文件，gitdir 指向主仓 .git/worktrees/<name>
    const worktreeGitDir = join(mainGitDir, 'worktrees', 't3');
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(root, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');
  }
  return root;
}

describe('resolveCommitMsgPath', () => {
  const roots: string[] = [];

  function trackedRoot(kind: 'repo' | 'worktree'): string {
    const root = makeRoot(kind);
    roots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it('常规仓库：.git 目录内的提交信息文件放行', () => {
    const root = trackedRoot('repo');
    const msgPath = join(root, '.git', 'COMMIT_EDITMSG');
    expect(resolveCommitMsgPath(msgPath, root)).toBe(resolve(msgPath));
  });

  it('linked worktree：.git 指针文件指向主仓 gitdir → 主仓内提交信息文件放行', () => {
    const root = trackedRoot('worktree');
    const msgPath = join(root, 'main-repo', '.git', 'worktrees', 't3', 'COMMIT_EDITMSG');
    expect(resolveCommitMsgPath(msgPath, root)).toBe(resolve(msgPath));
  });

  it('越界路径：常规仓库与 worktree 下均拒绝（防任意文件读取）', () => {
    for (const kind of ['repo', 'worktree'] as const) {
      const root = trackedRoot(kind);
      const outside = join(root, 'package.json');
      expect(resolveCommitMsgPath(outside, root)).toBeNull();
    }
  });

  it('.git 不存在 → 拒绝', () => {
    const root = trackedRoot('repo');
    const emptyRoot = resolve(root, 'not-a-repo');
    expect(resolveCommitMsgPath(join(emptyRoot, '.git', 'COMMIT_EDITMSG'), emptyRoot)).toBeNull();
  });

  it('前缀相似目录不误放行：worktrees/t3-evil ≠ worktrees/t3', () => {
    const root = trackedRoot('worktree');
    const evil = join(root, 'main-repo', '.git', 'worktrees', 't3-evil', 'COMMIT_EDITMSG');
    expect(resolveCommitMsgPath(evil, root)).toBeNull();
  });
});
