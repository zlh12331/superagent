// scripts/check-release-pr-scope.test.ts
// Release PR 内容边界闸门单测：白名单判定 + package.json 版本行约束 +
// #90 越界形态 / #98 干净形态的最小重放（files 注入，不发真实网络请求）

import { describe, expect, it } from 'vitest';

import { findScopeViolations } from './check-release-pr-scope';

describe('findScopeViolations', () => {
  it('#98 干净形态（版本号 + manifest + CHANGELOG）→ 无越界', () => {
    const violations = findScopeViolations([
      {
        filename: '.release-please-manifest.json',
        patch: '@@ -1 +1 @@\n-".": "1.7.0-beta.1"\n+".": "1.7.0-beta.2"',
      },
      { filename: 'CHANGELOG.md', patch: '@@ -1,3 +1,8 @@\n+## 1.7.0-beta.2\n+### Fixes' },
      {
        filename: 'package.json',
        patch: '@@ -3,1 +3,1 @@\n-"version": "1.7.0-beta.1"\n+"version": "1.7.0-beta.2"',
      },
    ]);
    expect(violations).toEqual([]);
  });

  it('#90 越界形态（携带脚本/配置/文档）→ 全部识别', () => {
    const violations = findScopeViolations([
      { filename: '.release-please-manifest.json' },
      { filename: 'CHANGELOG.md' },
      { filename: 'package.json', patch: '-"version": "1.6.1"\n+"version": "1.6.2"' },
      {
        filename: 'scripts/check-release-anchor.ts',
        patch: '+const REPO = "zlh12331/superagent";',
      },
      { filename: 'RELEASING.md', patch: '+## 7.1 护栏' },
      { filename: 'biome.json', patch: '+  "some": "entry"' },
    ]);
    expect(violations.map((v) => v.filename)).toEqual([
      'scripts/check-release-anchor.ts',
      'RELEASING.md',
      'biome.json',
    ]);
  });

  it('package.json 携带版本行以外的新增 → 越界', () => {
    const violations = findScopeViolations([
      {
        filename: 'package.json',
        patch: '-"version": "1.6.1"\n+"version": "1.6.2"\n+"check:evil": "node evil.js"',
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('check:evil');
  });

  it('package.json 无 patch（GitHub 对超 ~400 行 diff 省略）→ fail-closed 报 violation', () => {
    // 2026-10-07 收口：patch 缺失时「仅允许版本行」约束无从执行——静默放行会让
    // package.json 大改借超大 diff 搭车，故按存在性风险处理，要求人工复核
    const violations = findScopeViolations([{ filename: 'package.json' }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.filename).toBe('package.json');
    expect(violations[0]?.reason).toContain('patch');
  });

  it('CHANGELOG.md / manifest 无 patch → 不拦（白名单内且非可执行内容）', () => {
    const violations = findScopeViolations([
      { filename: 'CHANGELOG.md' },
      { filename: '.release-please-manifest.json' },
    ]);
    expect(violations).toEqual([]);
  });

  it('删除行（- 前缀）不触发版本行校验', () => {
    const violations = findScopeViolations([
      { filename: 'package.json', patch: '-"version": "1.6.1"\n+"version": "1.6.2"' },
    ]);
    expect(violations).toEqual([]);
  });
});
