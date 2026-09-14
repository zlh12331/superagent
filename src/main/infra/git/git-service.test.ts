// src/main/infra/git/git-service.test.ts
// GitService 单测（simple-git 实现）· 真实 git 仓库
// 无业务 mock：每次用例在临时目录 init 真实 git 仓库驱动。

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode } from '@code-agent/shared/main';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGitService, type IGitService, resetGitService } from './git-service';

/** 用系统 git CLI 执行命令（测试环境有 git；避免用被测库自证初始化） */
function spawnGit(args: string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败: ${result.stderr}`);
  }
}

/**
 * 真实 git 集成测试的用例注册（R3 修复：显式放宽单测超时）
 *
 * 根因：全量并发跑主进程测试时（111 个测试文件并行），git 子进程 spawn
 * 受 CPU/IO 饱和影响，单用例耗时从隔离跑的 ~1.2s 涨到 5-6s——恰好超过
 * vitest 默认 5s 单测超时被强杀，且每次失败的是不同用例（表现似随机偶发）。
 * 隔离重跑永远通过的原因即在此。真实 git CLI 集成测试放宽到 30s 属合理边界。
 */
const gitIt = (name: string, fn: () => Promise<void>): void => {
  it(name, fn, 30_000);
};

describe('GitService（真实 git 仓库）', () => {
  let dir: string;
  let svc: IGitService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'git-svc-test-'));
    svc = getGitService();
  });

  afterEach(async () => {
    resetGitService();
    // Windows 上 git 子进程退出后目录句柄延迟释放，rm 立即执行会 EBUSY（push 用例最易触发）；
    // 用 fs.rm 原生重试（maxRetries/retryDelay）兜底，避免环境性清理竞态导致测试失败
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** 初始化 git 仓库 + 提交初始文件 */
  async function initRepo(): Promise<void> {
    spawnGit(['init'], dir);
    spawnGit(['config', 'user.email', 'test@example.com'], dir);
    spawnGit(['config', 'user.name', 'GitService Test'], dir);
    await writeFile(join(dir, 'a.txt'), 'line1\nline2\n');
    spawnGit(['add', '-A'], dir);
    spawnGit(['commit', '-m', 'init'], dir);
  }

  gitIt('status：非 git 仓库 → INVALID_INPUT', async () => {
    await expect(svc.status(dir)).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
    });
  });

  gitIt('status：干净仓库 → clean=true 且分支非空', async () => {
    await initRepo();
    const res = await svc.status(dir);
    expect(res.clean).toBe(true);
    expect(res.files).toEqual([]);
    expect(res.branch.length).toBeGreaterThan(0);
  });

  gitIt('status：修改文件 → modified（未暂存）；add 后 → staged', async () => {
    await initRepo();
    await writeFile(join(dir, 'a.txt'), 'changed\n');
    const dirty = await svc.status(dir);
    const file = dirty.files.find((f) => f.path === 'a.txt');
    expect(file?.status).toBe('modified');
    expect(file?.staged).toBe(false);

    await svc.add({ path: dir, paths: [] });
    const staged = await svc.status(dir);
    expect(staged.files.find((f) => f.path === 'a.txt')?.staged).toBe(true);
  });

  gitIt('status：新建文件 → untracked', async () => {
    await initRepo();
    await writeFile(join(dir, 'new.txt'), 'new');
    const res = await svc.status(dir);
    expect(res.files).toContainEqual({
      path: 'new.txt',
      status: 'untracked',
      staged: false,
    });
  });

  gitIt('diff：修改后返回 unified diff + 统计', async () => {
    await initRepo();
    await writeFile(join(dir, 'a.txt'), 'line1\nline2-changed\nline3\n');
    const res = await svc.diff({ path: dir, ref: 'HEAD', staged: false, filePath: undefined });
    expect(res.diff).toContain('a.txt');
    expect(res.additions).toBeGreaterThan(0);
    expect(res.deletions).toBeGreaterThan(0);
    expect(res.filesChanged).toBe(1);
  });

  gitIt('add：指定路径只暂存该文件', async () => {
    await initRepo();
    await writeFile(join(dir, 'a.txt'), 'changed\n');
    await writeFile(join(dir, 'b.txt'), 'b');
    const res = await svc.add({ path: dir, paths: ['b.txt'] });
    expect(res.stagedCount).toBe(1);
    const status = await svc.status(dir);
    expect(status.files.find((f) => f.path === 'b.txt')?.staged).toBe(true);
    expect(status.files.find((f) => f.path === 'a.txt')?.staged).toBe(false);
  });

  gitIt('commit：提交后返回 sha/branch/统计', async () => {
    await initRepo();
    await writeFile(join(dir, 'a.txt'), 'line1\nline2\nline3\n');
    await svc.add({ path: dir, paths: [] });
    const res = await svc.commit({ path: dir, message: 'feat: test', amend: false });
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.shortSha).toMatch(/^[0-9a-f]{7}$/);
    expect(res.branch.length).toBeGreaterThan(0);
    expect(res.filesChanged).toBe(1);
  });

  gitIt('push：首推建立基准，二次推送可计算 pushedCount', async () => {
    // 真实 git 操作在全量并发下可能 >5s（init + bare 远程 + 2 次 push），放宽超时
    await initRepo();
    // 创建 bare 远程仓库
    const remoteDir = await mkdtemp(join(tmpdir(), 'git-remote-test-'));
    try {
      spawnGit(['init', '--bare'], remoteDir);
      spawnGit(['remote', 'add', 'origin', remoteDir], dir);

      // 第一次推送（无基准 SHA，pushedCount 不可精确计算，仅断言成功 + 上游建立）
      await writeFile(join(dir, 'a.txt'), 'line1\nline2\nline3\n');
      await svc.add({ path: dir, paths: [] });
      await svc.commit({ path: dir, message: 'feat: push test 1', amend: false });
      const first = await svc.push({
        path: dir,
        remote: 'origin',
        refspec: '',
        setUpstream: true,
        force: false,
      });
      expect(first.ok).toBe(true);

      // 第二次推送：有基准 SHA，pushedCount 应为 1
      await writeFile(join(dir, 'a.txt'), 'line1\nline2\nline3\nline4\n');
      await svc.add({ path: dir, paths: [] });
      await svc.commit({ path: dir, message: 'feat: push test 2', amend: false });
      const second = await svc.push({
        path: dir,
        remote: 'origin',
        refspec: '',
        setUpstream: false,
        force: false,
      });
      expect(second.ok).toBe(true);
      expect(second.pushedCount).toBe(1);
    } finally {
      await rm(remoteDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  gitIt('push：无远程 → ok=false 不抛错', async () => {
    await initRepo();
    const res = await svc.push({
      path: dir,
      remote: 'origin',
      refspec: '',
      setUpstream: false,
      force: false,
    });
    expect(res.ok).toBe(false);
  });

  gitIt('push：ext:: 传输串远程 → INVALID_INPUT（服务层守卫，覆盖 agent 工具直连）', async () => {
    await initRepo();
    await expect(
      svc.push({
        path: dir,
        remote: 'ext::evil',
        refspec: '',
        setUpstream: false,
        force: false,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_INPUT });
  });

  gitIt('diff：选项形参数 ref（--output）→ INVALID_INPUT', async () => {
    await initRepo();
    await expect(
      svc.diff({ path: dir, ref: '--output=pwned.txt', staged: false, filePath: undefined }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_INPUT });
  });
});
