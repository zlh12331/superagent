// scripts/check-commit-msg.test.ts
// check-commit-msg 单测：路径安全判定（常规仓库 / linked worktree gitdir 指针 / 越界拒绝）
//   + extractHeader 首行提取
// （2026-09-27 worktree 修复的回归测试——指针文件此前被路径守卫一刀切拒绝；
//   合并双方用例：wt/t3「路径守卫支持 linked worktree」+ wt/t5「校验兼容 git worktree 布局」）

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
