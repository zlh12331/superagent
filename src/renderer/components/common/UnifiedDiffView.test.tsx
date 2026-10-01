// src/renderer/components/$1/UnifiedDiffView.test.tsx
// UnifiedDiffView 单测：自研 diff 表格渲染（hunk 分组 / 行号 / 空兜底 / 语言检测）
// ──────────────────────────────────────────────
// 背景：渲染方案已从 react-diff-viewer-continued 迁移为自研 DiffRowsTable
// （2026-09）。断言策略随之从「mock 渲染库断 props」改为「真实渲染断 DOM」：
// 表结构 / hunk 分组（多 tbody）/ 行号语义 / className 透传 / 目标语言检测。
// shiki 高亮为异步纯视觉增强，jsdom 下 mock 为永不 resolve，行结构先行断言。
// ──────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { UnifiedDiffView } from './UnifiedDiffView';

vi.mock('@/lib/highlight', () => ({
  // 永不 resolve：jsdom 下跳过 shiki 异步管线（高亮失败自动退化为纯文本，属正常路径）
  getHighlighter: vi.fn(() => new Promise<never>(() => {})),
  ensureLangLoaded: vi.fn(() => Promise.resolve()),
  // 语言检测链路（file-viewer-utils）依赖：identity 即可（扩展名映射在查表层完成）
  normalizeLang: vi.fn((lang: string): string => lang),
}));

vi.mock('@/providers/ThemeProvider', () => ({
  useTheme: (): { resolvedTheme: 'dark' | 'light' } => ({ resolvedTheme: 'dark' }),
}));

const t = i18n.t.bind(i18n);

/** 构造单 hunk 的 unified diff 原文 */
const oneHunk = ['@@ -1,2 +1,2 @@', '-old line', '+new line', ' context'].join('\n');
/** 构造双 hunk 的 unified diff 原文 */
const twoHunks = ['@@ -1,1 +1,1 @@', '-a', '+b', '@@ -10,1 +10,1 @@', '-c', '+d'].join('\n');

/** 取渲染后的全部 diff 行（tr.diff-line） */
function diffRows(container: HTMLElement): readonly Element[] {
  return Array.from(container.querySelectorAll('tr.diff-line'));
}

describe('UnifiedDiffView', () => {
  it('正向：单 hunk → 渲染一张 diff 表，删除/新增/上下文行齐备', () => {
    const { container } = render(<UnifiedDiffView diff={oneHunk} />);
    expect(container.querySelectorAll('table.diff-table')).toHaveLength(1);
    expect(screen.getByText('old line')).toBeDefined();
    expect(screen.getByText('new line')).toBeDefined();
    // 上下文行双栏同现（文本出现两次）
    expect(screen.getAllByText('context')).toHaveLength(2);
  });

  it('多 hunk：单表内按 hunk 分组（两个 tbody，hunk 边界保留）', () => {
    const { container } = render(<UnifiedDiffView diff={twoHunks} />);
    expect(container.querySelectorAll('table.diff-table')).toHaveLength(1);
    expect(container.querySelectorAll('table.diff-table tbody')).toHaveLength(2);
  });

  it('行号语义：del 行只占左栏（oldNumber），add 行只占右栏（newNumber）', () => {
    const { container } = render(<UnifiedDiffView diff={oneHunk} />);
    const [delRow, addRow] = diffRows(container);
    // 单元格顺序：old 行号 | old 代码 | new 行号 | new 代码
    expect(delRow?.children[0]?.textContent).toBe('1');
    expect(delRow?.children[1]?.textContent).toContain('old line');
    expect(delRow?.children[2]?.textContent).toBe('');
    expect(delRow?.children[3]?.textContent).toBe('');
    expect(addRow?.children[0]?.textContent).toBe('');
    expect(addRow?.children[1]?.textContent).toBe('');
    expect(addRow?.children[2]?.textContent).toBe('1');
    expect(addRow?.children[3]?.textContent).toContain('new line');
  });

  it('上下文行：双栏同现（同一行内容在 old/new 两侧）', () => {
    const { container } = render(<UnifiedDiffView diff={oneHunk} />);
    const contextRow = diffRows(container)[2];
    expect(contextRow?.children[1]?.textContent).toContain('context');
    expect(contextRow?.children[3]?.textContent).toContain('context');
    expect(contextRow?.children[0]?.textContent).toBe('2');
    expect(contextRow?.children[2]?.textContent).toBe('2');
  });

  it('边界：空 diff 串 → 不渲染表，显示无差异兜底文案', () => {
    const { container } = render(<UnifiedDiffView diff="" />);
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getByText(t('common.noDiff'))).toBeDefined();
  });

  it('异常：非 diff 格式文本（无 @@ 头）→ 解析为空 → 走兜底文案，不抛错', () => {
    const { container } = render(<UnifiedDiffView diff="这只是一段普通文本" />);
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getByText(t('common.noDiff'))).toBeDefined();
  });

  it('className 透传：自定义类名并入容器', () => {
    const { container } = render(<UnifiedDiffView diff={oneHunk} className="my-diff" />);
    expect(container.firstElementChild?.className).toContain('my-diff');
  });

  it('语言检测：+++ b/foo.ts → 目标语言写入 data-lang（shiki 高亮管线输入）', () => {
    const diff = ['--- a/foo.ts', '+++ b/foo.ts', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n');
    const { container } = render(<UnifiedDiffView diff={diff} />);
    expect(container.querySelector('.diff-table-wrap')?.getAttribute('data-lang')).toBe(
      'typescript',
    );
  });

  it('大 diff：行数超预算折叠进「展开更多」，点击后补齐且按钮消失（键盘可达）', async () => {
    const user = userEvent.setup();
    const lines: string[] = ['@@ -0,0 +1,450 @@'];
    for (let i = 1; i <= 450; i += 1) {
      lines.push(`+line ${i}`);
    }
    const { container } = render(<UnifiedDiffView diff={lines.join('\n')} />);
    // 初始预算 400 行：可见 400，折叠 50
    expect(diffRows(container)).toHaveLength(400);
    const more = screen.getByRole('button');
    expect(more.textContent).toBe(t('diff.showMoreRows', { remaining: 50 }));
    await user.click(more);
    expect(diffRows(container)).toHaveLength(450);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
