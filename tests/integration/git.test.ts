// tests/integration/git.test.ts
// Git 域集成测试（batch 4/9 · 核心链路）
// ──────────────────────────────────────────────────────────────
// 链路：IPC handler（真实）→ GitService（真实）→ SimpleGit（真实 git 命令）→ 临时仓库
// 替身：无（git 命令为真实外部工具；临时仓库为 IO 边界）
//
// 维度覆盖：接口契约 / 时序编排（add→commit 顺序）/ 状态一致性（git 状态往返）/
//           错误传播（assertGitRepo / push ok=false）
// 场景：持久化往返（commit 后 status 干净）/ 并发（并行 status）/ 外部依赖故障（push 无 remote）
// ──────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getGitService, resetGitService } from '../../src/main/infra/git/git-service';
import { createGitHandlers } from '../../src/main/ipc/git.handler';

/** 在临时目录初始化 git 仓库（含 user 配置） */
function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'it@test.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Integration Test'], { cwd: dir });
}

/** 每用例独立临时 git 仓库 */
async function withGitRepo<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'code-agent-git-'));
  initGitRepo(dir);
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, maxRetries: 5 });
  }
}

/** 初始化本地 bare 远程（bare 仓库路径） */
function initBareRemote(parentDir: string, name = 'origin.git'): string {
  const bare = join(parentDir, name);
  execFileSync('git', ['init', '--bare', '-q', bare]);
  return bare;
}

/**
 * bare 远程独立临时目录（push 测试用）
 * 必须使用独立临时目录：放在 withGitRepo 的 dir 外侧会逃逸其清理，每次运行泄漏一个仓库。
 */
async function withBareRemote<T>(fn: (bare: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'code-agent-git-remote-'));
  try {
    return await fn(initBareRemote(dir));
  } finally {
    rmSync(dir, { recursive: true, maxRetries: 5 });
  }
}

describe('git 域集成链路（batch 4）', () => {
  it('正向：干净仓库 status（分支 + clean）', async () => {
    resetGitService();
    await withGitRepo(async (dir) => {
      const handlers = createGitHandlers({ gitService: getGitService() });
      const status = await handlers.status({ path: dir });
      expect(status.clean).toBe(true);
      expect(status.branch).toBeDefined();
      expect(status.files).toEqual([]);
    });
  });

  it('正向：变更→add→commit→status 干净（完整生命周期）', async () => {
    resetGitService();
    await withGitRepo(async (dir) => {
      const handlers = createGitHandlers({ gitService: getGitService() });
      writeFileSync(join(dir, 'a.txt'), 'v1', 'utf-8');

      // 未跟踪状态
      const dirty = await handlers.status({ path: dir });
      expect(dirty.clean).toBe(false);

      // add 后 staged
      const addRes = await handlers.add({ path: dir });
      expect(addRes.stagedCount).toBe(1);

      // commit 返回 SHA
      const commitRes = await handlers.commit({ path: dir, message: 'feat: init' });
      expect(commitRes.filesChanged).toBe(1);
      expect(commitRes.sha).toMatch(/^[0-9a-f]{7,40}$/);

      // 持久化往返：commit 后干净
      const clean = await handlers.status({ path: dir });
      expect(clean.clean).toBe(true);
    });
  });

  it('正向：diff（未暂存变更 unified diff + 统计）', async () => {
    resetGitService();
    await withGitRepo(async (dir) => {
      const handlers = createGitHandlers({ gitService: getGitService() });
      writeFileSync(join(dir, 'f.txt'), 'one', 'utf-8');
      await handlers.add({ path: dir });
      await handlers.commit({ path: dir, message: 'init' });
      writeFileSync(join(dir, 'f.txt'), 'two', 'utf-8');

      const diff = await handlers.diff({ path: dir });
      expect(diff.filesChanged).toBe(1);
      expect(diff.additions).toBeGreaterThan(0);
      expect(diff.deletions).toBeGreaterThan(0);
      expect(diff.diff).toContain('one');
      expect(diff.diff).toContain('two');
    });
  });

  it('正向：diff staged（--cached）', async () => {
    resetGitService();
    await withGitRepo(async (dir) => {
      const handlers = createGitHandlers({ gitService: getGitService() });
      writeFileSync(join(dir, 's.txt'), 'a', 'utf-8');
      await handlers.add({ path: dir });
      await handlers.commit({ path: dir, message: 'init' });
      writeFileSync(join(dir, 's.txt'), 'b', 'utf-8');
      await handlers.add({ path: dir });

      const staged = await handlers.diff({ path: dir, staged: true });
      expect(staged.filesChanged).toBe(1);
      expect(staged.diff).toContain('b');
    });
  });

  it('正向：push 到本地 bare remote（含 upstream）', async () => {
    resetGitService();
    await withGitRepo(async (dir) => {
      const handlers = createGitHandlers({ gitService: getGitService() });
      writeFileSync(join(dir, 'p.txt'), 'x', 'utf-8');
      await handlers.add({ path: dir });
      await handlers.commit({ path: dir, message: 'init' });

      await withBareRemote(async (bare) => {
        const pushRes = await handlers.push({
          path: dir,
          remote: bare,
          refspec: 'master',
          setUpstream: true,
        });
        expect(pushRes.ok).toBe(true);
        // 真实验证：bare 仓库收到提交（pushedCount 解析受 simple-git stdout 格式影响）
        const bareLog = execFileSync('git', ['log', '-1', '--format=%H'], {
          cwd: bare,
          encoding: 'utf-8',
        });
        expect(bareLog.trim().length).toBeGreaterThan(0);
      });
    });
  });

  it('边界：空仓库 status（无 commit）', async () => {
    resetGitService();
    await withGitRepo(async (dir) => {
      const handlers = createGitHandlers({ gitService: getGitService() });
      const status = await handlers.status({ path: dir });
      // 无 commit 的仓库：clean 且无分支提交（porcelain -b 输出不同）
      expect(status.files).toEqual([]);
      expect(status.branch).toBeDefined();
    });
  });

  it('边界：diff 空（无任何变更）', async () => {
    resetGitService();
    await withGitRepo(async (dir) => {
      const handlers = createGitHandlers({ gitService: getGitService() });
      const diff = await handlers.diff({ path: dir });
      expect(diff.diff).toBe('');
      expect(diff.filesChanged).toBe(0);
    });
  });

  it('异常：非 git 仓库 → 错误传播', async () => {
    resetGitService();
    const dir = mkdtempSync(join(tmpdir(), 'code-agent-no-git-'));
    try {
      const handlers = createGitHandlers({ gitService: getGitService() });
      await expect(handlers.status({ path: dir })).rejects.toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, maxRetries: 5 });
    }
  });

  it('边界：commit 无暂存 → 返回空 sha（不抛）', async () => {
    resetGitService();
    await withGitRepo(async (dir) => {
      const handlers = createGitHandlers({ gitService: getGitService() });
      const commitRes = await handlers.commit({ path: dir, message: 'nothing' });
      // simple-git 对 nothing to commit 返回空结果（非异常——生产语义）
      expect(commitRes.sha).toBe('');
    });
  });

  it('外部依赖故障：push 无远程 → ok=false 不抛', async () => {
    resetGitService();
    await withGitRepo(async (dir) => {
      const handlers = createGitHandlers({ gitService: getGitService() });
      writeFileSync(join(dir, 'q.txt'), 'x', 'utf-8');
      await handlers.add({ path: dir });
      await handlers.commit({ path: dir, message: 'init' });
      const pushRes = await handlers.push({
        path: dir,
        remote: '/nonexistent-remote',
        refspec: 'master',
      });
      expect(pushRes.ok).toBe(false);
    });
  });

  it('并发：并行 status 互不干扰（只读安全）', async () => {
    resetGitService();
    await withGitRepo(async (dir) => {
      const handlers = createGitHandlers({ gitService: getGitService() });
      const results = await Promise.all(
        Array.from({ length: 8 }, () => handlers.status({ path: dir })),
      );
      for (const r of results) {
        expect(r.clean).toBe(true);
      }
    });
  });
});
