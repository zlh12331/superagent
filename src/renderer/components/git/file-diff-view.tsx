// src/renderer/components/git/file-diff-view.tsx
// Git 选中文件的差异视图（可折叠 + 增删统计 + unified diff 渲染）
// ──────────────────────────────
// 拆分背景（2026-08 重构）：自 GitPanel 486 行按职责提取。
// 职责：接收父级已取到的 diff 文本与统计，负责折叠交互与三态展示
// （加载中 / 无 diff / 渲染）；自身不调用任何 query hook。
// diff 渲染走统一方案 UnifiedDiffView（内部 react-diff-viewer-continued +
// parseUnifiedDiff 拆 hunk），本文件不感知其实现。
// ──────────────────────────────

import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { UnifiedDiffView } from '@/components/common/UnifiedDiffView';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslation } from '@/i18n/use-translation';
import { basename } from '@/lib/utils';

interface FileDiffViewProps {
  readonly filePath: string;
  readonly diff: string | undefined;
  readonly additions: number | undefined;
  readonly deletions: number | undefined;
  readonly isLoading: boolean;
}
export function FileDiffView({
  filePath,
  diff,
  additions,
  deletions,
  isLoading,
}: FileDiffViewProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);

  // 统计口径单一化（R5 修复）：直接用主进程 GitDiffRes 的 git numstat 统计。
  // 此前渲染层另用 diff-match-patch 从 diff 文本重算一套"语义行数"，与 git 口径
  // 并存且数字互相矛盾；现统一为 git 口径，与状态徽标 / DiffPane 一致。
  const stats =
    additions !== undefined && deletions !== undefined ? { additions, deletions } : null;

  // 文件名：basename 单一真源在 lib/utils（兼容两种分隔符 + 尾部斜杠）
  const fileName = basename(filePath);

  return (
    <div className="border-border bg-muted/20 flex h-40 flex-col border-t">
      {/* 标题栏：折叠按钮 + 文件名 + 增删统计 */}
      <div className="border-border flex items-center justify-between border-b px-2 py-1">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground h-auto min-w-0 flex-1 justify-start gap-1 px-0 text-2xs"
          onClick={() => {
            setExpanded((prev) => !prev);
          }}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="size-3 shrink-0" strokeWidth={1.5} />
          ) : (
            <ChevronRight className="size-3 shrink-0" strokeWidth={1.5} />
          )}
          <span className="font-mono truncate">{fileName}</span>
        </Button>

        {/* 增删统计（git numstat 口径，与状态徽标一致） */}
        {stats !== null && (
          <div className="flex shrink-0 items-center gap-1.5 text-[9px]">
            <span className="text-success-text">+{stats.additions}</span>
            <span className="text-error-text">-{stats.deletions}</span>
          </div>
        )}
      </div>

      {/* diff 文本（可滚动） */}
      {expanded && (
        <ScrollArea className="min-h-0 flex-1">
          {isLoading ? (
            <div className="p-2">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="mt-1 h-3 w-1/2" />
            </div>
          ) : diff === undefined || diff.length === 0 ? (
            <div className="text-muted-foreground p-2 text-2xs">{t('common.noDiff')}</div>
          ) : (
            <UnifiedDiffView diff={diff} className="min-h-0" />
          )}
        </ScrollArea>
      )}
    </div>
  );
}
