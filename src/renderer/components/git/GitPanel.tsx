// src/renderer/components/git/GitPanel.tsx
// Git 面板 · 组装层（状态工具/差异视图/文件列表/辅助组件提取至独立文件）
// ──────────────────────────────
// 拆分背景（2026-08 重构）：原文件 486 行，按职责拆分：
// - git-status-utils.ts：文件状态 → 图标/颜色/文案（纯函数）
// - file-diff-view.tsx：变更查看（FileDiffView/DiffText）
// - file-list.tsx：文件列表（FileList/FileListSkeleton）
// - git-panel-parts.tsx：辅助组件（BranchInfo/CleanHint/ErrorHint）
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

import { RefreshCw } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useGitDiffQuery, useGitStatusQuery } from '@/hooks/use-git';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

import { FileDiffView } from './file-diff-view';
import { FileList, FileListSkeleton } from './file-list';
import { BranchInfo, CleanHint, ErrorHint } from './git-panel-parts';

/** GitPanel props */
interface GitPanelProps {
  /** Git 仓库路径（绝对路径，GitService 内部解析根目录） */
  readonly path: string;
  /** 自定义容器类名 */
  readonly className?: string;
}

export function GitPanel({ path, className }: GitPanelProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 当前选中的文件路径（用于查询该文件的 diff）
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  // L3 TanStack Query：工作区状态
  // P3 修复：无激活会话（path 为空）时禁用查询——此前硬编码默认仓库路径
  // 会在无会话时也发起 git:status 请求
  const {
    data: status,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useGitStatusQuery(path, path.length > 0);

  // L3 TanStack Query：选中文件的 diff（仅当 selectedFilePath 不为 null 时启用）
  const { data: diff, isLoading: isDiffLoading } = useGitDiffQuery(
    {
      path,
      ref: 'HEAD',
      staged: false,
      filePath: selectedFilePath ?? undefined,
    },
    selectedFilePath !== null,
  );

  return (
    <div className={cn('flex h-full flex-col', className)}>
      {/* 顶部：分支信息 + 刷新按钮 */}
      <div className="border-border bg-muted/30 flex items-center justify-between border-b px-2 py-1">
        <BranchInfo status={status} isLoading={isLoading} error={error} />
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-5"
          onClick={() => {
            void refetch();
          }}
          disabled={isFetching}
          aria-label={t('git.refreshStatus')}
        >
          <RefreshCw className={cn('size-3', isFetching && 'animate-spin')} strokeWidth={1.5} />
        </Button>
      </div>

      {/* 中间：变更文件列表 */}
      <ScrollArea className="min-h-0 flex-1">
        {isLoading ? (
          <FileListSkeleton />
        ) : error !== null ? (
          <ErrorHint message={error instanceof Error ? error.message : String(error)} />
        ) : status === undefined ? (
          <ErrorHint message={t('git.statusEmpty')} />
        ) : status.clean ? (
          <CleanHint />
        ) : (
          <FileList
            files={status.files}
            selectedFilePath={selectedFilePath}
            onSelect={setSelectedFilePath}
          />
        )}
      </ScrollArea>

      {/* 底部：选中文件的 diff（可折叠） */}
      {selectedFilePath !== null && (
        <FileDiffView
          filePath={selectedFilePath}
          diff={diff?.diff}
          additions={diff?.additions}
          deletions={diff?.deletions}
          isLoading={isDiffLoading}
        />
      )}
    </div>
  );
}

// ── 子组件：分支信息 ──────────────────────────────────────────

/** 分支信息展示：分支名 + ahead/behind 标记 */
