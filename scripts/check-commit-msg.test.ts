// scripts/check-commit-msg.test.ts
// check-commit-msg 路径安全判定单测：常规仓库 / git worktree 双布局
// ──────────────────────────────────────────────────────────────
// 背景：worktree 布局下 <cwd>/.git 是指针文件（gitdir: 主仓/worktrees/<名>），
//   钩子传入的 COMMIT_EDITMSG 在主仓 .git 下——此前只认 <cwd>/.git/ 目录导致
//   worktree 内一切提交被拒（2026-09-27 实测）。
// ──────────────────────────────────────────────────────────────

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { extractHeader, resolveCommitMsgPath, resolveGitDir } from './check-commit-msg';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('resolveGitDir', () => {
  it('常规仓库：.git 为目录 → 返回该目录', () => {
    const cwd = makeTempDir('commit-msg-regular-');
    mkdirSync(join(cwd, '.git'));
    expect(resolveGitDir(cwd)).toBe(join(cwd, '.git'));
  });

  it('worktree：.git 为指针文件 → 解析 gitdir 指向的主仓目录', () => {
    const cwd = makeTempDir('commit-msg-wt-');
    const mainGit = makeTempDir('commit-msg-main-git-');
    writeFileSync(join(cwd, '.git'), `gitdir: ${join(mainGit, 'worktrees', 't5')}\n`, 'utf8');
    expect(resolveGitDir(cwd)).toBe(join(mainGit, 'worktrees', 't5'));
  });

  it('.git 不存在 → null', () => {
    const cwd = makeTempDir('commit-msg-empty-');
    expect(resolveGitDir(cwd)).toBeNull();
  });
});

describe('resolveCommitMsgPath', () => {
  it('常规仓库：接受 .git 内的 COMMIT_EDITMSG', () => {
    const cwd = makeTempDir('commit-msg-regular-');
    const gitDir = join(cwd, '.git');
    mkdirSync(gitDir);
    const msgPath = join(gitDir, 'COMMIT_EDITMSG');
    writeFileSync(msgPath, 'feat: ok\n', 'utf8');
    expect(resolveCommitMsgPath(msgPath, cwd)).toBe(msgPath);
  });

  it('worktree：接受主仓 .git/worktrees/<名>/COMMIT_EDITMSG（回归）', () => {
    const cwd = makeTempDir('commit-msg-wt-');
    const worktreeGitDir = join(makeTempDir('commit-msg-main-git-'), 'worktrees', 't5');
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(cwd, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');
    const msgPath = join(worktreeGitDir, 'COMMIT_EDITMSG');
    writeFileSync(msgPath, 'feat: ok\n', 'utf8');
    expect(resolveCommitMsgPath(msgPath, cwd)).toBe(msgPath);
  });

  it('拒绝 git 目录之外的路径（防任意文件读取）', () => {
    const cwd = makeTempDir('commit-msg-regular-');
    mkdirSync(join(cwd, '.git'));
    const outside = makeTempDir('commit-msg-outside-');
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'nope', 'utf8');
    expect(resolveCommitMsgPath(secret, cwd)).toBeNull();
  });

  it('拒绝仅前缀相似的同级目录（worktreeGitDir + sep 判定）', () => {
    const cwd = makeTempDir('commit-msg-wt-');
    const mainGit = makeTempDir('commit-msg-main-git-');
    const worktreeGitDir = join(mainGit, 'worktrees', 't5');
    mkdirSync(join(mainGit, 'worktrees', 't5-evil'), { recursive: true });
    writeFileSync(join(cwd, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');
    const evilMsg = join(mainGit, 'worktrees', 't5-evil', 'COMMIT_EDITMSG');
    expect(resolveCommitMsgPath(evilMsg, cwd)).toBeNull();
  });
});

describe('extractHeader', () => {
  it('取首个非空非注释行', () => {
    expect(extractHeader('# comment\n\nperf(x): 标题\nbody')).toBe('perf(x): 标题');
  });

  it('全空输入 → 空串', () => {
    expect(extractHeader('\n\n')).toBe('');
  });
});
