// src/renderer/components/common/__tests__/UnifiedDiffView.test.tsx
// UnifiedDiffView 单测：hunk 分块渲染 / 空 diff 兜底 / 主题透传 / className
// ──────────────────────────────────────────────
// 覆盖动机：组件此前 0% 覆盖。它把 git:diff 原始文本转成 ReactDiffViewer——
// 解析结果为空时的兜底文案、多 hunk 的 key、暗色主题透传均无回归锚。
// 断言策略：mock react-diff-viewer-continued（重依赖），断言其收到的 props
// （oldValue/newValue/useDarkTheme）与 hunk 数量；parseUnifiedDiff 保持真实。
// ──────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { UnifiedDiffView } from './UnifiedDiffView';

const viewerSpy = vi.hoisted(() => vi.fn());
const themeState = vi.hoisted(() => ({ resolved: 'dark' as 'dark' | 'light' }));

vi.mock('react-diff-viewer-continued', () => ({
  default: (props: Record<string, unknown>): React.ReactElement => {
    viewerSpy(props);
    return <div data-testid="diff-viewer" />;
  },
  // biome-ignore lint/style/useNamingConvention: 第三方枚举名（DiffMethod.LINES），mock 必须保持原形
  DiffMethod: { LINES: 'LINES' },
}));

vi.mock('@/providers/ThemeProvider', () => ({
  useTheme: (): { resolvedTheme: 'dark' | 'light' } => ({ resolvedTheme: themeState.resolved }),
}));

const t = i18n.t.bind(i18n);

/** 构造单 hunk 的 unified diff 原文 */
const oneHunk = ['@@ -1,2 +1,2 @@', '-old line', '+new line', ' context'].join('\n');
/** 构造双 hunk 的 unified diff 原文 */
const twoHunks = ['@@ -1,1 +1,1 @@', '-a', '+b', '@@ -10,1 +10,1 @@', '-c', '+d'].join('\n');

/** 取第 n 次 viewer 调用的 props（断言辅助） */
function viewerProps(callIndex = 0): Record<string, unknown> {
  const call = viewerSpy.mock.calls[callIndex];
  return (call === undefined ? {} : call[0]) as Record<string, unknown>;
}

describe('UnifiedDiffView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    themeState.resolved = 'dark';
  });

  it('正向：单 hunk → 渲染一个 viewer，oldValue/newValue 为 hunk 行拼接', () => {
    render(<UnifiedDiffView diff={oneHunk} />);
    expect(screen.getAllByTestId('diff-viewer')).toHaveLength(1);
    // 上下文行去掉 diff 前缀（' ' 也一并裁掉，见 parseUnifiedDiff 的实现）
    expect(viewerProps()).toMatchObject({
      oldValue: 'old line\ncontext',
      newValue: 'new line\ncontext',
    });
  });

  it('正向：双 hunk → 渲染两个 viewer（按 hunk 分块）', () => {
    render(<UnifiedDiffView diff={twoHunks} />);
    expect(screen.getAllByTestId('diff-viewer')).toHaveLength(2);
  });

  it('主题透传：暗色 → useDarkTheme=true；浅色 → false', () => {
    const { unmount } = render(<UnifiedDiffView diff={oneHunk} />);
    expect(viewerProps(0)['useDarkTheme']).toBe(true);
    unmount();
    themeState.resolved = 'light';
    render(<UnifiedDiffView diff={oneHunk} />);
    expect(viewerProps(1)['useDarkTheme']).toBe(false);
  });

  it('边界：空 diff 串 → 不渲染 viewer，显示无差异兜底文案', () => {
    render(<UnifiedDiffView diff="" />);
    expect(screen.queryByTestId('diff-viewer')).toBeNull();
    expect(screen.getByText(t('common.noDiff'))).toBeDefined();
  });

  it('异常：非 diff 格式文本（无 @@ 头）→ 解析为空 → 走兜底文案，不抛错', () => {
    render(<UnifiedDiffView diff="这只是一段普通文本" />);
    expect(screen.queryByTestId('diff-viewer')).toBeNull();
    expect(screen.getByText(t('common.noDiff'))).toBeDefined();
  });

  it('className 透传：自定义类名并入容器', () => {
    const { container } = render(<UnifiedDiffView diff={oneHunk} className="my-diff" />);
    expect(container.firstElementChild?.className).toContain('my-diff');
  });

  it('渲染选项：splitView + DiffMethod.LINES + 显示行号（对齐设计）', () => {
    render(<UnifiedDiffView diff={oneHunk} />);
    expect(viewerProps()).toMatchObject({
      splitView: true,
      compareMethod: 'LINES',
      hideLineNumbers: false,
    });
  });
});
