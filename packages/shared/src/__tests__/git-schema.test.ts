// packages/shared/src/__tests__/git-schema.test.ts
// git schema 单测：P0 收口——remote/refspec/ref 透传曾可携带选项形参数
// 与 `ext::` 传输串（git 直接运行本地命令）。锁死字符集边界。

import { describe, expect, it } from 'vitest';
import {
  GitDiffReqSchema,
  GitPushReqSchema,
  isSafeGitRefValue,
  isSafeGitRemote,
} from '../schemas/git';

describe('isSafeGitRemote', () => {
  it('合法远程名与安全 URL', () => {
    for (const value of [
      'origin',
      'upstream',
      'github-mirror',
      'https://github.com/u/r.git',
      'ssh://git@host:22/srv/r',
      'file:///srv/git/r',
    ]) {
      expect(isSafeGitRemote(value)).toBe(true);
    }
  });

  it('本地路径远程合法（真实用法：本地 bare 仓库；argv 数组不经 shell）', () => {
    for (const value of [
      'C:\\Users\\me\\repos\\origin.git',
      '/srv/git/origin.git',
      '/nonexistent-remote',
      'D:\\My Repos\\x.git',
    ]) {
      expect(isSafeGitRemote(value)).toBe(true);
    }
  });

  it('`::` 传输语法拒绝（ext::<cmd> 让 git 直接运行本地命令；<transport>::<addr> 运行 helper）', () => {
    expect(isSafeGitRemote('ext::evil')).toBe(false);
    expect(isSafeGitRemote('EXT::evil')).toBe(false);
    expect(isSafeGitRemote('evil-helper::arg')).toBe(false);
    expect(isSafeGitRemote('file:://x')).toBe(false);
  });

  it('`-` 开头选项形参数拒绝', () => {
    expect(isSafeGitRemote('-oProxyCommand=evil')).toBe(false);
    expect(isSafeGitRemote('--upload-pack=evil')).toBe(false);
  });

  it('空串 / 换行 / NUL 拒绝（畸形参数）', () => {
    expect(isSafeGitRemote('')).toBe(false);
    expect(isSafeGitRemote('origin\n--upload-pack=evil')).toBe(false);
    expect(isSafeGitRemote('a\0b')).toBe(false);
  });
});

describe('isSafeGitRefValue', () => {
  it('空串合法（push refspec 省略语义 = 推送当前分支）', () => {
    expect(isSafeGitRefValue('')).toBe(true);
  });

  it('合法引用与引用规格', () => {
    for (const value of [
      'main',
      'feature/x',
      'HEAD~1',
      'HEAD@{1}',
      'v1.0.0-beta.1',
      'refs/heads/main',
      'a1b2c3d',
      '+main:main',
      'main:feature/preview',
      'main:',
    ]) {
      expect(isSafeGitRefValue(value)).toBe(true);
    }
  });

  it('选项形参数拒绝（位置参数处的 --flag 会被 git 按选项解析）', () => {
    expect(isSafeGitRefValue('--upload-pack=evil')).toBe(false);
    expect(isSafeGitRefValue('-q')).toBe(false);
    expect(isSafeGitRefValue('+--upload-pack=evil')).toBe(false);
  });

  it('空白与控制形态拒绝', () => {
    expect(isSafeGitRefValue('main feature')).toBe(false);
    expect(isSafeGitRefValue('main\nfeature')).toBe(false);
  });

  it('多个冒号拒绝（引用规格至多 src:dst）', () => {
    expect(isSafeGitRefValue('a:b:c')).toBe(false);
  });
});

describe('GitDiffReqSchema · ref 收口', () => {
  it('默认 HEAD 与常规引用通过', () => {
    expect(GitDiffReqSchema.safeParse({ path: '/repo' }).success).toBe(true);
    expect(GitDiffReqSchema.safeParse({ path: '/repo', ref: 'HEAD~1' }).success).toBe(true);
  });

  it('选项形参数 ref 拒绝（git diff --output=<file> 可任意写文件）', () => {
    const result = GitDiffReqSchema.safeParse({ path: '/repo', ref: '--output=/tmp/pwned' });
    expect(result.success).toBe(false);
  });
});

describe('GitPushReqSchema · remote/refspec 收口', () => {
  it('默认 origin + 空 refspec 通过', () => {
    const result = GitPushReqSchema.safeParse({ path: '/repo' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.remote).toBe('origin');
      expect(result.data.refspec).toBe('');
    }
  });

  it('ext:: 远程拒绝', () => {
    const result = GitPushReqSchema.safeParse({ path: '/repo', remote: 'ext::evil' });
    expect(result.success).toBe(false);
  });

  it('选项形参数 refspec 拒绝', () => {
    const result = GitPushReqSchema.safeParse({ path: '/repo', refspec: '--upload-pack=evil' });
    expect(result.success).toBe(false);
  });
});
