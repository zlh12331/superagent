// src/renderer/components/common/diff/DiffRowsTable.test.tsx
// DiffRowsTable 单测：词级差异配对 / 栏标题 / 语法高亮语言直通
// ──────────────────────────────────────────────
// 词级（wordDiff）：配对的 del/add 行渲染 .word-del/.word-add 片段；
// 未配对行退化为整行渲染。shiki 管线在 jsdom 下 mock 为永不 resolve。
// ──────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DiffRowsTable } from './DiffRowsTable';

vi.mock('@/lib/highlight', () => ({
  getHighlighter: vi.fn(() => new Promise<never>(() => {})),
  ensureLangLoaded: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/providers/ThemeProvider', () => ({
  useTheme: (): { resolvedTheme: 'dark' | 'light' } => ({ resolvedTheme: 'dark' }),
}));

describe('DiffRowsTable', () => {
  it('词级差异：配对 del/add 行内渲染变更片段（word-del / word-add）', () => {
    const { container } = render(
      <DiffRowsTable
        rowGroups={[
          [
            { type: 'del', oldNumber: 1, newNumber: null, text: 'const a = 1;' },
            { type: 'add', oldNumber: null, newNumber: 1, text: 'const a = 2;' },
          ],
        ]}
        wordDiff={true}
      />,
    );
    // dmp 片段：等价部分 + 变更词（1 → 2）
    expect(container.querySelectorAll('.word-del').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.word-add').length).toBeGreaterThan(0);
    // 片段拼接还原行内容（del 侧；排除增删标记 span）
    const delCell = container.querySelector('.diff-code.is-del');
    const delText = Array.from(delCell?.querySelectorAll('span:not(.diff-marker)') ?? [])
      .map((s) => s.textContent)
      .join('');
    expect(delText).toBe('const a = 1;');
  });

  it('未开启 wordDiff（默认）：不渲染词级片段，整行底色承载语义', () => {
    const { container } = render(
      <DiffRowsTable
        rowGroups={[
          [
            { type: 'del', oldNumber: 1, newNumber: null, text: 'old' },
            { type: 'add', oldNumber: null, newNumber: 1, text: 'new' },
          ],
        ]}
      />,
    );
    expect(container.querySelectorAll('.word-del')).toHaveLength(0);
    expect(container.querySelectorAll('.word-add')).toHaveLength(0);
    expect(container.querySelector('.diff-code.is-del')?.textContent).toContain('old');
  });

  it('栏标题：leftTitle/rightTitle 渲染为表头（scope=col）', () => {
    render(
      <DiffRowsTable
        rowGroups={[[{ type: 'context', oldNumber: 1, newNumber: 1, text: 'x' }]]}
        leftTitle="变更前"
        rightTitle="变更后"
      />,
    );
    expect(screen.getByRole('columnheader', { name: '变更前' })).toBeDefined();
    expect(screen.getByRole('columnheader', { name: '变更后' })).toBeDefined();
  });

  it('空行：渲染零宽占位保行高，不抛错', () => {
    const { container } = render(
      <DiffRowsTable rowGroups={[[{ type: 'add', oldNumber: null, newNumber: 1, text: '' }]]} />,
    );
    const code = container.querySelector('.diff-code.is-add');
    expect(code?.textContent).toContain('\u200B');
  });

  it('a11y：行号单元格 aria-hidden（读屏顺序读代码即可）', () => {
    const { container } = render(
      <DiffRowsTable rowGroups={[[{ type: 'context', oldNumber: 3, newNumber: 4, text: 'x' }]]} />,
    );
    const gutters = container.querySelectorAll('td.diff-gutter');
    expect(gutters).toHaveLength(2);
    for (const gutter of gutters) {
      expect(gutter.getAttribute('aria-hidden')).toBe('true');
    }
  });
});
