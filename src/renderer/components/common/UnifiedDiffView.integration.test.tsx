import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { UnifiedDiffView } from './UnifiedDiffView';

vi.mock('@/lib/highlight', () => ({
  getHighlighter: vi.fn(() => new Promise<never>(() => {})),
  ensureLangLoaded: vi.fn(() => Promise.resolve()),
  normalizeLang: vi.fn((lang: string): string => lang),
}));

const DIFF_SAMPLE = `--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,4 @@
 line1
+line2
 line3`;

const DIFF_TWO_HUNKS = `${DIFF_SAMPLE}
@@ -10,2 +11,2 @@
 old
+new`;

/** 组件依赖主题（shiki 明暗方案选择），统一包一层 */
function renderInTheme(node: React.ReactElement): ReturnType<typeof render> {
  return render(<ThemeProvider>{node}</ThemeProvider>);
}

describe('UnifiedDiffView（真实渲染集成）', () => {
  it('空 diff：显示无差异兜底文案，且不渲染 diff 表', () => {
    renderInTheme(<UnifiedDiffView diff="" />);
    expect(screen.getByText(i18n.t('common.noDiff'))).toBeDefined();
    expect(document.querySelector('table')).toBeNull();
  });

  it('单 hunk：真实渲染出 diff 表与行内容', () => {
    renderInTheme(<UnifiedDiffView diff={DIFF_SAMPLE} />);
    expect(document.querySelector('table.diff-table')).not.toBeNull();
    expect(screen.getByText('line2')).toBeDefined();
  });

  it('多 hunk：单表内按 hunk 分组（每 hunk 一个 tbody）', () => {
    renderInTheme(<UnifiedDiffView diff={DIFF_TWO_HUNKS} />);
    expect(document.querySelectorAll('table.diff-table')).toHaveLength(1);
    expect(document.querySelectorAll('table.diff-table tbody')).toHaveLength(2);
  });

  it('空 diff → 有效 diff：重渲染后表出现（解析结果随 props 重算）', () => {
    const { rerender } = renderInTheme(<UnifiedDiffView diff="" />);
    expect(screen.getByText(i18n.t('common.noDiff'))).toBeDefined();
    rerender(
      <ThemeProvider>
        <UnifiedDiffView diff={DIFF_SAMPLE} />
      </ThemeProvider>,
    );
    expect(document.querySelector('table.diff-table')).not.toBeNull();
  });
});
