// src/renderer/components/$1/UnifiedDiffView.integration.test.tsx
// UnifiedDiffView 集成测试（真实 react-diff-viewer-continued，不 mock）
// ──────────────────────────────────────────────────────────────
// 与同目录 UnifiedDiffView.test.tsx 的分工：
// - 单元测试 mock 掉重依赖，断言传给 viewer 的 props（oldValue/newValue/主题/选项）
// - 本文件走真实渲染，断言「组件 + 第三方库」整体落地（表结构、hunk 分块）——
//   补的是依赖升级/包裹方式变化这类集成风险，props 断言覆盖不到。
//
// 来源：原 components/$1/dev-common-gaps.test.tsx 的 UnifiedDiffView 段。
// 该文件跨 dev/common 两域且与单元测试重复，故拆解：browser-pane 部分随组件迁至
// components/$1/browser-pane.test.tsx；本段并入此处。
// 纯解析断言（parseUnifiedDiff）由 lib/diff/unified-diff.test.ts 覆盖，不在此重复。
// ──────────────────────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { UnifiedDiffView } from './UnifiedDiffView';

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

/** 组件依赖主题（viewer 明暗方案），统一包一层 */
function renderInTheme(node: React.ReactElement): ReturnType<typeof render> {
  return render(<ThemeProvider>{node}</ThemeProvider>);
}

describe('UnifiedDiffView（真实渲染集成）', () => {
  it('空 diff：显示无差异兜底文案，且不渲染 diff 表', () => {
    renderInTheme(<UnifiedDiffView diff="" />);
    expect(screen.getByText(i18n.t('common.noDiff'))).toBeDefined();
    expect(document.querySelector('table')).toBeNull();
  });

  it('单 hunk：真实渲染出 diff 表', () => {
    renderInTheme(<UnifiedDiffView diff={DIFF_SAMPLE} />);
    expect(document.querySelector('table')).not.toBeNull();
  });

  it('多 hunk：按 hunk 分块渲染（多个表）', () => {
    renderInTheme(<UnifiedDiffView diff={DIFF_TWO_HUNKS} />);
    expect(document.querySelectorAll('table')).toHaveLength(2);
  });

  it('空 diff → 有效 diff：重渲染后表出现（解析结果随 props 重算）', () => {
    const { rerender } = renderInTheme(<UnifiedDiffView diff="" />);
    expect(screen.getByText(i18n.t('common.noDiff'))).toBeDefined();
    rerender(
      <ThemeProvider>
        <UnifiedDiffView diff={DIFF_SAMPLE} />
      </ThemeProvider>,
    );
    expect(document.querySelector('table')).not.toBeNull();
  });
});
