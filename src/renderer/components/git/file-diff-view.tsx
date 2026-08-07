// file-diff-view.tsx（自 GitPanel 拆分）
// Git 变更查看（文件差异 / 文本差异）
// ──────────────────────────────
// 拆分背景：GitPanel 486 行，按职责提取
// ──────────────────────────────

// src/renderer/components/git/GitPanel.tsx
// Git 状态展示面板 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 职责：
// - 调用 useGitStatusQuery 获取当前分支、ahead/behind、变更文件列表
// - 文件列表点击选中 → 调用 useGitDiffQuery 获取该文件的 unified diff
// - 用 <pre> 渲染 diff 文本（绿色 + 绿色 -，等宽字体）
// - 工作区干净时显示「无变更」提示
//
// 设计：
// - 纯只读面板（不提供 commit/push 等写操作，避免误操作主仓库）
// - 文件状态用颜色区分（modified/added/deleted/untracked/conflicted）
// - diff 渲染用 react-diff-viewer-continued（UnifiedDiffView，统一方案）
//   实现：git:diff 返回 unified diff → parseUnifiedDiff 拆 hunk → 双栏渲染
// - 路径必须为绝对路径（由调用方传入）
// ──────────────────────────────────────────────────────────────

import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { UnifiedDiffView } from '@/components/common/UnifiedDiffView';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslation } from '@/i18n/use-translation';
import { countSemanticDiffLines } from '@/lib/diff/diff-stats';

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

  // 语义统计（diff-match-patch 行级 diff）：比 git 文本统计更准（移动的行不计增删）
  const semanticStats = useMemo(
    () => (diff !== undefined && diff.length > 0 ? countSemanticDiffLines(diff) : null),
    [diff],
  );

  // 展示统计：优先语义统计，回退主进程文本统计
  const stats =
    semanticStats ??
    (additions !== undefined && deletions !== undefined ? { additions, deletions } : null);

  // 派生：diff 文件名（截取 basename）
  const basename = useMemo(() => {
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1] ?? filePath;
  }, [filePath]);

  return (
    <div className="border-border bg-muted/20 flex h-40 flex-col border-t">
      {/* 标题栏：折叠按钮 + 文件名 + 增删统计 */}
      <div className="border-border flex items-center justify-between border-b px-2 py-1">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground flex min-w-0 flex-1 items-center gap-1 text-2xs transition-colors"
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
          <span className="font-mono truncate">{basename}</span>
        </button>

        {/* 增删统计（diff-match-patch 语义统计优先，回退主进程文本统计） */}
        {stats !== null && (
          <div className="flex shrink-0 items-center gap-1.5 text-[9px]">
            <span className="text-emerald-600 dark:text-emerald-400">+{stats.additions}</span>
            <span className="text-red-600 dark:text-red-400">-{stats.deletions}</span>
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

// ── 子组件：加载中 / 空状态 / 错误状态 ─────────────────────────

/** 加载中骨架屏 */
