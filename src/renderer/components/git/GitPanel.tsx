import { RefreshCw } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { type GitStatusRes, useGitDiffQuery, useGitStatusQuery } from '@/hooks/use-git';
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

/**
 * 变更区状态分派（加载中 / 错误 / 状态缺失 / 干净 / 有变更）
 *
 * 抽离动机（2026-09 审计）：此前是内联在 GitPanel 里的 4 层嵌套三元，
 * 使该组件认知复杂度达 16（阈值 15，长期挂在棘轮基线里）。改为早返回的
 * 分派组件后，每个状态是独立直线分支，主组件只负责组装。
 */
function StatusArea({
  isLoading,
  error,
  status,
  selectedFilePath,
  onSelect,
}: {
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly status: GitStatusRes | undefined;
  readonly selectedFilePath: string | null;
  readonly onSelect: (path: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  if (isLoading) return <FileListSkeleton />;
  if (error !== null) {
    return <ErrorHint message={error instanceof Error ? error.message : String(error)} />;
  }
  if (status === undefined) return <ErrorHint message={t('git.statusEmpty')} />;
  if (status.clean) return <CleanHint />;
  return <FileList files={status.files} selectedFilePath={selectedFilePath} onSelect={onSelect} />;
}

/** Git 面板（右面板）：工作区状态查询 + 文件列表/单文件 diff 双视图，四态守卫见上方 Content */
export function GitPanel({ path, className }: GitPanelProps): ReactElement {
  const { t } = useTranslation();
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  const {
    data: status,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useGitStatusQuery(path, path.length > 0);

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

      <ScrollArea className="min-h-0 flex-1">
        <StatusArea
          isLoading={isLoading}
          error={error}
          status={status}
          selectedFilePath={selectedFilePath}
          onSelect={setSelectedFilePath}
        />
      </ScrollArea>

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
