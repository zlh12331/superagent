// src/renderer/components/common/UnifiedDiffView.tsx
// unified diff 文本渲染（统一 react-diff-viewer-continued 方案）
// ──────────────────────────────────────────────────────────────
// 背景：统一 diff 渲染方案为 react-diff-viewer-continued（此前 git 面板与
// 右面板行级展开用 <pre> 自绘，两套实现并存）。
//
// 输入：git:diff 返回的 unified diff 原始文本
// 输出：按 hunk 拆分的 ReactDiffViewer（GitHub 风格变更块，主题感知）
//
// 设计：
// - parseUnifiedDiff 解析 → 每 hunk 一个 ReactDiffViewer（splitView 双栏）
// - useDarkTheme 跟随全局主题
// - 紧凑样式（content 区 10px 等宽，对齐应用小字视觉）
// ──────────────────────────────────────────────────────────────

import { type ReactElement, useMemo } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { useTranslation } from '@/i18n/use-translation';
import { parseUnifiedDiff } from '@/lib/diff/unified-diff';
import { useTheme } from '@/providers/ThemeProvider';

/** 紧凑样式：覆盖 ReactDiffViewer 默认密度，对齐应用 10px 小字视觉 */
const COMPACT_STYLES = {
  content: {
    fontSize: '10px',
    lineHeight: '1.6',
    fontFamily: 'var(--font-mono)',
    width: '100%',
  } as const,
  lineNumber: {
    fontSize: '10px',
    minWidth: '2em',
  } as const,
  gutter: {
    minWidth: '2em',
  } as const,
  diffContainer: {
    width: '100%',
  } as const,
  table: {
    width: '100%',
  } as const,
};

/** UnifiedDiffView props */
export interface UnifiedDiffViewProps {
  /** git:diff 返回的 unified diff 原始文本 */
  readonly diff: string;
  /** 自定义容器类名 */
  readonly className?: string;
}

/**
 * unified diff 文本渲染（按 hunk 分块，主题感知）
 */
export function UnifiedDiffView({ diff, className }: UnifiedDiffViewProps): ReactElement {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const hunks = useMemo(() => parseUnifiedDiff(diff), [diff]);

  if (hunks.length === 0) {
    return <div className="text-muted-foreground p-2 text-2xs">{t('common.noDiff')}</div>;
  }

  return (
    <div className={className}>
      {hunks.map((hunk) => (
        <div
          // key 用 hunk 起始行号（同文件同位置唯一，避开数组索引 lint）
          key={`${hunk.oldStart}-${hunk.newStart}`}
          className="mt-1 first:mt-0"
        >
          <ReactDiffViewer
            oldValue={hunk.oldLines.join('\n')}
            newValue={hunk.newLines.join('\n')}
            splitView={true}
            compareMethod={DiffMethod.LINES}
            hideLineNumbers={false}
            showDiffOnly={false}
            useDarkTheme={resolvedTheme === 'dark'}
            styles={COMPACT_STYLES}
          />
        </div>
      ))}
    </div>
  );
}
