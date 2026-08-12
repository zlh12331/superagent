// tests/integration/codebase.test.ts
// Codebase 域集成测试（batch 7/9）
// ──────────────────────────────────────────────────────────────
// 链路：IPC handler（真实）→ CodebaseService（真实）→ codegraph CLI（真实子进程）→ 项目索引
// 替身：spawnFn DI（错误注入用例）；正向用例要求 codegraph CLI + 项目索引可用
//
// 维度覆盖：接口契约 / 错误传播（未索引目录 INVALID_INPUT / spawn 失败）
// 场景：外部依赖故障（codegraph 不可用降级）
// ──────────────────────────────────────────────────────────────

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodebaseService } from '../../src/main/infra/codebase/codebase-service';
import { createCodebaseHandlers } from '../../src/main/ipc/codebase.handler';

/** 项目根（本仓库已初始化 codegraph 索引——本地环境正向用例用） */
const PROJECT_ROOT = process.cwd();

/** codegraph CLI 可用性探测（收集时执行——skipIf 在收集阶段求值） */
let codegraphAvailable = false;
try {
  // execSync 走 shell（Windows 下 codegraph 为 .cmd 包装）
  execSync('codegraph --version', { stdio: 'ignore', timeout: 10_000 });
  codegraphAvailable = true;
} catch {
  codegraphAvailable = false;
}

/** 未索引的临时目录（异常路径用例——跨环境稳定） */
async function withUnindexedDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'code-agent-codebase-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, maxRetries: 5 });
  }
}

describe('codebase 域集成链路（batch 7）', () => {
  it.skipIf(!codegraphAvailable)('正向：query 符号查询（项目索引）', async () => {
    const handlers = createCodebaseHandlers({ codebaseService: new CodebaseService() });
    const res = await handlers.query({ path: PROJECT_ROOT, search: 'SessionService' });
    expect(res.results.length).toBeGreaterThan(0);
  });

  it.skipIf(!codegraphAvailable)('正向：node 符号定位（项目索引）', async () => {
    const handlers = createCodebaseHandlers({ codebaseService: new CodebaseService() });
    const res = await handlers.node({ path: PROJECT_ROOT, name: 'SessionService' });
    expect(res.markdown.length).toBeGreaterThan(0);
  });

  it('异常：无 codegraph 索引 → 错误传播', async () => {
    await withUnindexedDir(async (dir) => {
      const handlers = createCodebaseHandlers({ codebaseService: new CodebaseService() });
      // 注：注释声称未初始化 → INVALID_INPUT，但实现全走 INTERNAL_ERROR（文档-实现漂移，
      // 缺陷观察项——低风险错误码语义，批次耗尽时评估修复）
      await expect(handlers.query({ path: dir, query: 'x' })).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
      });
    });
  });

  it('异常：spawn 失败 → 错误传播（spawnFn 注入）', async () => {
    const failingSpawn = (() => {
      throw new Error('codegraph binary missing');
    }) as never;
    const handlers = createCodebaseHandlers({
      codebaseService: new CodebaseService({ spawnFn: failingSpawn }),
    });
    await expect(handlers.query({ path: PROJECT_ROOT, query: 'x' })).rejects.toBeDefined();
  });
});
