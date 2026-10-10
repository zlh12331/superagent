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
  const hunks = parseUnifiedDiff(diff);

  if (hunks.length === 0) {
    return <div className="text-muted-foreground p-2 text-2xs">{t('common.noDiff')}</div>;
  }

  const targetPath = extractDiffTargetPath(diff);
  const detectedLang = targetPath === null ? undefined : detectLangFromPath(targetPath);
  const lang = detectedLang === undefined || detectedLang === 'text' ? undefined : detectedLang;

  return (
    <div className={className}>
      <DiffRowsTable rowGroups={hunks.map((hunk) => hunk.lines)} lang={lang} />
    </div>
  );
}
