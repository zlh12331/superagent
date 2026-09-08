// tests/integration/search.test.ts
// Search 域集成测试（batch 7/9）
// ──────────────────────────────────────────────────────────────
// 链路：IPC handler（真实）→ SearchService（真实）→ ripgrep（真实 rg 子进程）→ 临时目录
// 替身：无（rg 为真实外部工具；spawnFn DI 默认真实）
//
// 维度覆盖：接口契约 / 错误传播（rg 失败分类）
// 场景：并发（并行 grep）/ 边界（大小写/无命中）
// ──────────────────────────────────────────────────────────────

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SearchService } from '../../src/main/infra/search/search-service';
import { createSearchHandlers } from '../../src/main/ipc/search.handler';

/**
 * 创建 handler（2026-09-08：handler 现做工作区收口，需注入根集合）
 *
 * @param dir 当前用例的临时目录（作为唯一工作区根）
 */
function makeHandlers(dir: string): ReturnType<typeof createSearchHandlers> {
  return createSearchHandlers({
    searchService: new SearchService(),
    workspaceRoots: async () => [dir],
  });
}

/** 每用例独立临时目录（含样本文件） */
async function withSearchDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'code-agent-search-'));
  try {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a.ts'), 'export const target = 1;\n// 注释 target', 'utf-8');
    writeFileSync(join(dir, 'b.md'), 'TARGET 大写命中', 'utf-8');
    writeFileSync(join(dir, 'sub', 'c.txt'), 'target 深层命中', 'utf-8');
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, maxRetries: 5 });
  }
}

describe('search 域集成链路（batch 7）', () => {
  it('正向：grep 命中（真实 ripgrep）', async () => {
    await withSearchDir(async (dir) => {
      const handlers = makeHandlers(dir);
      const res = await handlers.grep({ pattern: 'target', paths: [dir] });
      expect(res.matches.length).toBeGreaterThan(0);
      expect(res.matches.some((m) => m.file.endsWith('a.ts'))).toBe(true);
    });
  });

  it('正向：glob 匹配文件', async () => {
    await withSearchDir(async (dir) => {
      const handlers = makeHandlers(dir);
      const res = await handlers.glob({ pattern: '*.ts', path: dir });
      expect(res.files).toHaveLength(1);
      expect(res.files[0]?.endsWith('a.ts')).toBe(true);
    });
  });

  it('边界：grep 无命中（空结果）', async () => {
    await withSearchDir(async (dir) => {
      const handlers = makeHandlers(dir);
      const res = await handlers.grep({ pattern: '不存在的词xyz', paths: [dir] });
      expect(res.matches).toEqual([]);
    });
  });

  it('边界：大小写敏感/不敏感', async () => {
    await withSearchDir(async (dir) => {
      const handlers = makeHandlers(dir);
      const sensitive = await handlers.grep({
        pattern: 'TARGET',
        paths: [dir],
        caseSensitive: true,
      });
      expect(sensitive.matches.length).toBeGreaterThan(0);
      const insensitive = await handlers.grep({
        pattern: 'target',
        paths: [dir],
        caseSensitive: false,
      });
      expect(insensitive.matches.length).toBeGreaterThanOrEqual(sensitive.matches.length);
    });
  });

  it('异常：目录不存在 → 错误传播', async () => {
    // 2026-09-08：注入该路径为工作区根，使收口放行、由 ripgrep 报「目录不存在」
    const handlers = createSearchHandlers({
      searchService: new SearchService(),
      workspaceRoots: async () => ['/'],
    });
    await expect(
      handlers.grep({ pattern: 'x', paths: ['/nonexistent-search-dir'] }),
    ).rejects.toBeDefined();
  });

  it('并发：并行 grep 互不干扰', async () => {
    await withSearchDir(async (dir) => {
      const handlers = makeHandlers(dir);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => handlers.grep({ pattern: 'target', paths: [dir] })),
      );
      for (const r of results) {
        expect(r.matches.length).toBeGreaterThan(0);
      }
    });
  });
});
