import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverAgentsMd,
  formatAgentsMdSection,
  resetAgentsMdMemo,
  resolveAgentsMd,
} from './agents-md';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agents-md-test-'));
  mkdirSync(join(root, 'sub', 'proj'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), 'ROOT_RULES', 'utf-8');
  writeFileSync(join(root, 'sub', 'proj', 'AGENTS.md'), 'PROJ_RULES', 'utf-8');
});

beforeEach(() => {
  resetAgentsMdMemo();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('discoverAgentsMd（从工作目录向上查找）', () => {
  it('收集路径上所有 AGENTS.md，靠近工作目录的在最前', () => {
    const found = discoverAgentsMd(join(root, 'sub', 'proj'));
    expect(found.map((f) => f.path)).toEqual([
      join(root, 'sub', 'proj', 'AGENTS.md'),
      join(root, 'AGENTS.md'),
    ]);
    expect(found.map((f) => f.content)).toEqual(['PROJ_RULES', 'ROOT_RULES']);
  });

  it('小写 agents.md 兼容', () => {
    const subRoot = mkdtempSync(join(tmpdir(), 'agents-md-lower-'));
    writeFileSync(join(subRoot, 'agents.md'), 'LOWER_RULES', 'utf-8');
    try {
      const found = discoverAgentsMd(subRoot);
      expect(found).toHaveLength(1);
      expect(found[0]?.content).toBe('LOWER_RULES');
    } finally {
      rmSync(subRoot, { recursive: true, force: true });
    }
  });

  it('无 AGENTS.md 返回空数组', () => {
    expect(discoverAgentsMd(mkdtempSync(join(tmpdir(), 'agents-md-empty-')))).toEqual([]);
  });

  it('字节预算截断：超出 maxBytes 后停止收集', () => {
    const bigRoot = mkdtempSync(join(tmpdir(), 'agents-md-budget-'));
    mkdirSync(join(bigRoot, 'sub'), { recursive: true });
    writeFileSync(join(bigRoot, 'AGENTS.md'), 'x'.repeat(64), 'utf-8');
    writeFileSync(join(bigRoot, 'sub', 'AGENTS.md'), 'y'.repeat(64), 'utf-8');
    try {
      const found = discoverAgentsMd(join(bigRoot, 'sub'), 80);
      expect(found.map((f) => f.content)).toEqual(['y'.repeat(64), 'x'.repeat(64)]);
    } finally {
      rmSync(bigRoot, { recursive: true, force: true });
    }
  });

  it('memo（P2-32）：同根连续发现返回一致结果；命中文件内容修改后失效刷新', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-md-memo-'));
    try {
      writeFileSync(join(dir, 'AGENTS.md'), 'V1', 'utf-8');
      const first = discoverAgentsMd(dir);
      const second = discoverAgentsMd(dir);
      expect(second.map((f) => f.content)).toEqual(first.map((f) => f.content));
      expect(second[0]?.content).toBe('V1');

      await new Promise((resolve) => setTimeout(resolve, 15));
      writeFileSync(join(dir, 'AGENTS.md'), 'V2', 'utf-8');
      const refreshed = discoverAgentsMd(dir);
      expect(refreshed[0]?.content).toBe('V2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('memo（P2-32）：解析根目录新增 AGENTS.md 后失效并纳入', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-md-memo-new-'));
    try {
      expect(discoverAgentsMd(dir)).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 15));
      writeFileSync(join(dir, 'AGENTS.md'), 'NEW_RULES', 'utf-8');
      const found = discoverAgentsMd(dir);
      expect(found).toHaveLength(1);
      expect(found[0]?.content).toBe('NEW_RULES');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('formatAgentsMdSection / resolveAgentsMd', () => {
  it('格式化含标题与路径段', () => {
    const text = formatAgentsMdSection([
      { path: '/a/AGENTS.md', content: 'A' },
      { path: '/b/AGENTS.md', content: 'B' },
    ]);
    expect(text).toContain('# 项目约定（AGENTS.md）');
    expect(text).toContain('## /a/AGENTS.md\nA');
    expect(text).toContain('## /b/AGENTS.md\nB');
  });

  it('无文件返回空字符串', () => {
    expect(formatAgentsMdSection([])).toBe('');
  });

  it('resolveAgentsMd 一站式：有文件生成注入块，无文件为空串', () => {
    expect(resolveAgentsMd(join(root, 'sub', 'proj'))).toContain('PROJ_RULES');
    expect(resolveAgentsMd(mkdtempSync(join(tmpdir(), 'agents-md-none-')))).toBe('');
  });
});
