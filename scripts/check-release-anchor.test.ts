// scripts/check-release-anchor.test.ts
// 锚点检查单测（fetch 注入，不发真实网络请求）：
//   - fail-closed 回归（2026-10-06）：网络失败必须计 ❌，禁止静默落入「正常」分支
//     （首版两处 catch 曾把 API 抖动当「近期无 Release PR」放过——发版事故场景
//     恰是本检查最该工作的时候）
//   - 404 → null 合法路径（无 open PR 等）
//   - post-merge 模式（CD gate）：manifest 一致性 + tag 不存在断言；
//     刚合并 PR 停在 pending 不参与判定（收尾在 release job 末尾）
//   - compareVersions 方向性判定（含 prerelease 序）

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type CheckResult, collectAnchorChecks, compareVersions } from './check-release-anchor';

const tempDirs: string[] = [];

function makeManifestDir(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-test-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ '.': version }), 'utf8');
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

/** fetch stub：按 path 前缀返回预设响应；未命中抛错（防测试盲飞真实网络） */
interface StubRoute {
  status?: number;
  body?: unknown;
}

function stubFetch(routes: Record<string, StubRoute>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.replace('https://api.github.com', '');
    const hit = Object.keys(routes).find((k) => path === k || path.startsWith(k));
    if (!hit) throw new Error(`stubFetch 未命中路由：${path}`);
    const route: StubRoute | undefined = routes[hit];
    if (route === undefined) throw new Error(`stubFetch 路由命中但取值失败：${path}`);
    if (route.status === 404) {
      return new Response(null, { status: 404 });
    }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const failingFetch = (async () => {
  throw new Error('EAI_AGAIN: 网络不可达（测试模拟）');
}) as unknown as typeof fetch;

const BASE_ARGS = ['--version', '1.7.0-beta.3'];

/**
 * 动态构造 GitHub API 契约对象（number/title/merged_at 等是 API 的 wire 字段名，
 * snake_case 不可改——字面量属性名会触发 useNamingConvention，故经索引写入）。
 */
function ghRecord(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v;
  }
  return out;
}

/** 已合并的 release-please PR（列表项形态；open: true 表示 open PR） */
function ghPull(
  number: number,
  version: string,
  options: { labels?: string[]; open?: boolean } = {},
): Record<string, unknown> {
  const base = ghRecord({
    number,
    title: `chore(main): release ${version}`,
    head: ghRecord({ ref: 'release-please--branches--main' }),
  });
  // merged_at 是 GitHub API wire 字段名（snake_case 不可改），经索引写入
  base['merged_at'] = options.open === true ? null : '2026-10-06T00:00:00Z';
  if (options.labels !== undefined) {
    base['labels'] = options.labels.map((name) => ghRecord({ name }));
  }
  return base;
}

function findResult(results: CheckResult[], namePrefix: string): CheckResult {
  const hit = results.find((r) => r.name.startsWith(namePrefix));
  if (!hit)
    throw new Error(`未找到检查项：${namePrefix}；实际：${results.map((r) => r.name).join(' | ')}`);
  return hit;
}

describe('check-release-anchor pre-merge', () => {
  it('网络失败 → fail-closed：最近 Release PR 与待合并 PR 两项均 ❌（回归 2026-10-06）', async () => {
    const dir = makeManifestDir('1.7.0-beta.3');
    const results = await collectAnchorChecks({
      argv: BASE_ARGS,
      manifestPath: join(dir, 'manifest.json'),
      fetchFn: failingFetch,
    });
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const name of ['最近 Release PR', '待合并 Release PR']) {
      const r = findResult(results, name);
      expect(r.ok, `${r.name} 应 fail-closed，实际 detail：${r.detail}`).toBe(false);
      expect(r.detail).toContain('fail-closed');
    }
  });

  it('已合并 PR 停在 autorelease: pending → ❌（发版未收尾事故形态）', async () => {
    const dir = makeManifestDir('1.7.0-beta.3');
    const results = await collectAnchorChecks({
      argv: BASE_ARGS,
      manifestPath: join(dir, 'manifest.json'),
      fetchFn: stubFetch({
        '/repos/zlh12331/superagent/pulls?state=closed': {
          body: [ghPull(101, '1.7.0-beta.2', { labels: ['autorelease: pending'] })],
        },
        '/repos/zlh12331/superagent/pulls/101': {
          body: ghPull(101, '1.7.0-beta.2', { labels: ['autorelease: pending'] }),
        },
        '/repos/zlh12331/superagent/pulls?state=open': { body: [] },
      }),
    });
    expect(findResult(results, '最近 Release PR #101').ok).toBe(false);
  });

  it('tagged 但 tag 不存在 → ❌（1.6.x 锚点断裂事故形态）', async () => {
    const dir = makeManifestDir('1.7.0-beta.3');
    const results = await collectAnchorChecks({
      argv: BASE_ARGS,
      manifestPath: join(dir, 'manifest.json'),
      fetchFn: stubFetch({
        '/repos/zlh12331/superagent/pulls?state=closed': {
          body: [ghPull(101, '1.7.0-beta.2', { labels: ['autorelease: tagged'] })],
        },
        '/repos/zlh12331/superagent/pulls/101': {
          body: ghPull(101, '1.7.0-beta.2', { labels: ['autorelease: tagged'] }),
        },
        '/repos/zlh12331/superagent/git/ref/tags/v1.7.0-beta.2': { status: 404 },
        '/repos/zlh12331/superagent/pulls?state=open': { body: [] },
      }),
    });
    expect(findResult(results, '已收尾 Release PR 的版本 v1.7.0-beta.2 有 tag').ok).toBe(false);
  });

  it('健康态（tagged + tag 存在 + 无 open PR）→ 全 ✅', async () => {
    const dir = makeManifestDir('1.7.0-beta.3');
    const results = await collectAnchorChecks({
      argv: BASE_ARGS,
      manifestPath: join(dir, 'manifest.json'),
      fetchFn: stubFetch({
        '/repos/zlh12331/superagent/pulls?state=closed': {
          body: [ghPull(101, '1.7.0-beta.2', { labels: ['autorelease: tagged'] })],
        },
        '/repos/zlh12331/superagent/pulls/101': {
          body: ghPull(101, '1.7.0-beta.2', { labels: ['autorelease: tagged'] }),
        },
        '/repos/zlh12331/superagent/git/ref/tags/v1.7.0-beta.2': {
          body: ghRecord({ object: ghRecord({ sha: '2d96ad5a' }) }),
        },
        '/repos/zlh12331/superagent/pulls?state=open': { body: [] },
      }),
    });
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('open PR 版本 ≤ lastReleased → ❌（版本倒退）', async () => {
    const dir = makeManifestDir('1.7.0-beta.3');
    const results = await collectAnchorChecks({
      argv: BASE_ARGS,
      manifestPath: join(dir, 'manifest.json'),
      fetchFn: stubFetch({
        '/repos/zlh12331/superagent/pulls?state=closed': {
          body: [ghPull(101, '1.7.0-beta.2', { labels: ['autorelease: tagged'] })],
        },
        '/repos/zlh12331/superagent/pulls/101': {
          body: ghPull(101, '1.7.0-beta.2', { labels: ['autorelease: tagged'] }),
        },
        '/repos/zlh12331/superagent/git/ref/tags/v1.7.0-beta.2': {
          body: ghRecord({ object: ghRecord({ sha: '2d96ad5a' }) }),
        },
        '/repos/zlh12331/superagent/pulls?state=open': {
          body: [ghPull(102, '1.7.0-beta.1', { open: true })],
        },
      }),
    });
    expect(findResult(results, '待合并 Release PR #102').ok).toBe(false);
  });

  it('版本缺失/不合法 → 抛错拒绝发起任何请求', async () => {
    const dir = makeManifestDir('not-a-semver');
    await expect(
      collectAnchorChecks({
        argv: [],
        manifestPath: join(dir, 'manifest.json'),
        fetchFn: failingFetch,
      }),
    ).rejects.toThrow('SemVer');
  });
});

describe('check-release-anchor post-merge（CD gate）', () => {
  it('manifest 一致 + tag 不存在 → 全 ✅', async () => {
    const dir = makeManifestDir('1.7.0-beta.3');
    const results = await collectAnchorChecks({
      argv: ['--phase', 'post-merge', ...BASE_ARGS],
      manifestPath: join(dir, 'manifest.json'),
      fetchFn: stubFetch({
        '/repos/zlh12331/superagent/git/ref/tags/v1.7.0-beta.3': { status: 404 },
      }),
    });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('tag 已存在 → ❌（重跑挪位/重复发版事故形态）', async () => {
    const dir = makeManifestDir('1.7.0-beta.3');
    const results = await collectAnchorChecks({
      argv: ['--phase', 'post-merge', ...BASE_ARGS],
      manifestPath: join(dir, 'manifest.json'),
      fetchFn: stubFetch({
        '/repos/zlh12331/superagent/git/ref/tags/v1.7.0-beta.3': {
          body: { object: { sha: '2d96ad5a' } },
        },
      }),
    });
    expect(results.every((r) => r.ok)).toBe(false);
  });

  it('tag 查询网络失败 → ❌ fail-closed', async () => {
    const dir = makeManifestDir('1.7.0-beta.3');
    const results = await collectAnchorChecks({
      argv: ['--phase', 'post-merge', ...BASE_ARGS],
      manifestPath: join(dir, 'manifest.json'),
      fetchFn: failingFetch,
    });
    expect(results.every((r) => r.ok)).toBe(false);
  });
});

describe('compareVersions（方向性判定）', () => {
  it('core 逐段比较', () => {
    expect(compareVersions('1.7.1', '1.7.0')).toBeGreaterThan(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.7.0', '1.7.0')).toBe(0);
  });

  it('prerelease 低于正式版', () => {
    expect(compareVersions('1.7.0-beta.1', '1.7.0')).toBeLessThan(0);
    expect(compareVersions('1.7.0', '1.7.0-beta.1')).toBeGreaterThan(0);
  });

  it('prerelease 序号递增', () => {
    expect(compareVersions('1.7.0-beta.2', '1.7.0-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('1.7.0-beta.10', '1.7.0-beta.9')).toBeGreaterThan(0);
    expect(compareVersions('1.7.0-beta.1', '1.7.0-alpha.1')).toBeGreaterThan(0);
  });

  it('不同 core 的 prerelease 按 core 比较', () => {
    expect(compareVersions('1.8.0-beta.1', '1.7.0-beta.99')).toBeGreaterThan(0);
  });
});
