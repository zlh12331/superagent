// src/renderer/components/common/UnifiedDiffView.tsx
// unified diff 文本渲染（自研 DiffRowsTable + shiki 按需高亮）
// ──────────────────────────────────────────────────────────────
// 背景（2026-09）：替换 react-diff-viewer-continued——其静态依赖的语法分析库
// 会在产物中拖入 37 个语言 chunk（out/ 约 2.7MB 死重）。现改用项目已有资产
// 自研渲染：unified-diff 解析 → DiffRowsTable 双栏表格（shiki 行高亮）。
//
// 输入：git:diff 返回的 unified diff 原始文本
// 输出：单张 diff 表（每 hunk 一个 tbody 分组，GitHub 风格变更块）
//
// 设计：
// - parseUnifiedDiff 解析（行号由解析器按 @@ 头推算）
// - extractDiffTargetPath 提取目标文件 → detectLangFromPath 推导 shiki 语言
// - 大 diff 由 DiffRowsTable 的行数预算折叠（展开更多按钮键盘可达）
// ──────────────────────────────────────────────────────────────

import type { ReactElement } from 'react';
import { detectLangFromPath } from '@/components/file-tree/file-viewer-utils';
import { useTranslation } from '@/i18n/use-translation';
import { extractDiffTargetPath, parseUnifiedDiff } from '@/lib/diff/unified-diff';
import { DiffRowsTable } from './diff/DiffRowsTable';

/** UnifiedDiffView props */
export interface UnifiedDiffViewProps {
  /** git:diff 返回的 unified diff 原始文本 */
  readonly diff: string;
  /** 自定义容器类名 */
  readonly className?: string;
}

/**
 * unified diff 文本渲染（按 hunk 分组，主题感知，shiki 按需高亮）
 */
export function UnifiedDiffView({ diff, className }: UnifiedDiffViewProps): ReactElement {
  const { t } = useTranslation();
  // 纯派生，交给 React Compiler 记忆化（diff 稳定时复用解析结果）
  const hunks = parseUnifiedDiff(diff);

  if (hunks.length === 0) {
    return <div className="text-muted-foreground p-2 text-2xs">{t('common.noDiff')}</div>;
  }

  // 语言检测：+++ 头的目标路径 → 扩展名查表；未收录语言 detectLangFromPath
  // 返回 'text'，此时不传 lang（DiffRowsTable 跳过高亮管线）
  const targetPath = extractDiffTargetPath(diff);
  const detectedLang = targetPath === null ? undefined : detectLangFromPath(targetPath);
  const lang = detectedLang === undefined || detectedLang === 'text' ? undefined : detectedLang;

  return (
    <div className={className}>
      <DiffRowsTable rowGroups={hunks.map((hunk) => hunk.lines)} lang={lang} />
    </div>
  );
}
