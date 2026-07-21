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
// - diff 渲染用 <pre> 而非 react-diff-viewer-continued
//   原因：git:diff 返回 unified diff 原始文本，解析为 oldValue/newValue 较复杂
//   <pre> 渲染已足够展示，且性能更好（避免解析开销）
// - 路径必须为绝对路径（由调用方传入）
// ──────────────────────────────────────────────────────────────

import type { GitFileStatus, GitStatusRes } from '@novel-writer/shared';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileEdit,
  FilePlus,
  FileQuestion,
  FileX,
  GitBranch,
  RefreshCw,
} from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useGitDiffQuery, useGitStatusQuery } from '@/hooks/use-git';
import { cn } from '@/lib/utils';

interface GitPanelProps {
  /**
   * Git 仓库路径（绝对路径）
   *
   * 必须为 Git 仓库根目录或子目录，GitService 内部会解析根目录。
   */
  readonly path: string;
  /** 自定义容器类名 */
  readonly className?: string;
}

/**
 * 按文件状态获取对应图标
 *
 * 使用 switch-case 而非对象字面量，避免触发 useNamingConvention。
 */
function getIconForFileStatus(status: GitFileStatus['status']): typeof FileEdit {
  switch (status) {
    case 'modified':
      return FileEdit;
    case 'added':
      return FilePlus;
    case 'deleted':
      return FileX;
    case 'renamed':
      return FileEdit;
    case 'untracked':
      return FileQuestion;
    case 'conflicted':
      return AlertCircle;
  }
}

/**
 * 按文件状态获取颜色 class
 */
function getColorForFileStatus(status: GitFileStatus['status']): string {
  switch (status) {
    case 'modified':
      return 'text-amber-600 dark:text-amber-400';
    case 'added':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'deleted':
      return 'text-red-600 dark:text-red-400';
    case 'renamed':
      return 'text-blue-600 dark:text-blue-400';
    case 'untracked':
      return 'text-muted-foreground';
    case 'conflicted':
      return 'text-red-700 dark:text-red-300 font-semibold';
  }
}

/**
 * 按文件状态获取中文标签
 */
function getLabelForFileStatus(status: GitFileStatus['status']): string {
  switch (status) {
    case 'modified':
      return '修改';
    case 'added':
      return '新增';
    case 'deleted':
      return '删除';
    case 'renamed':
      return '重命名';
    case 'untracked':
      return '未跟踪';
    case 'conflicted':
      return '冲突';
  }
}

/**
 * Git 状态展示面板
 *
 * 三段式布局：分支信息 / 变更文件列表 / 选中文件 diff。
 *
 * @example
 * ```tsx
 * <GitPanel path={repoPath} />
 * ```
 */
export function GitPanel({ path, className }: GitPanelProps): ReactElement {
  // 当前选中的文件路径（用于查询该文件的 diff）
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  // L3 TanStack Query：工作区状态
  const { data: status, isLoading, error, refetch, isFetching } = useGitStatusQuery(path);

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
          className="text-muted-foreground hover:text-foreground h-5 w-5"
          onClick={() => {
            void refetch();
          }}
          disabled={isFetching}
          aria-label="刷新 Git 状态"
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
          <ErrorHint message="Git 状态为空" />
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

interface BranchInfoProps {
  readonly status: GitStatusRes | undefined;
  readonly isLoading: boolean;
  readonly error: Error | null;
}

/** 分支信息展示：分支名 + ahead/behind 标记 */
function BranchInfo({ status, isLoading, error }: BranchInfoProps): ReactElement {
  if (isLoading) {
    return (
      <div className="text-muted-foreground flex items-center gap-1.5 text-[10px]">
        <GitBranch className="size-3 animate-pulse" strokeWidth={1.5} />
        <span className="font-serif tracking-wide">加载中...</span>
      </div>
    );
  }

  if (error !== null || status === undefined) {
    return (
      <div className="text-muted-foreground flex items-center gap-1.5 text-[10px]">
        <AlertCircle className="size-3" strokeWidth={1.5} />
        <span className="font-serif tracking-wide">无法获取</span>
      </div>
    );
  }

  return (
    <div className="text-muted-foreground flex items-center gap-1.5 text-[10px]">
      <GitBranch className="size-3" strokeWidth={1.5} />
      <span className="text-foreground font-serif tracking-wide">{status.branch}</span>
      {status.ahead > 0 && (
        <span className="text-emerald-600 dark:text-emerald-400">↑{status.ahead}</span>
      )}
      {status.behind > 0 && (
        <span className="text-amber-600 dark:text-amber-400">↓{status.behind}</span>
      )}
    </div>
  );
}

// ── 子组件：变更文件列表 ──────────────────────────────────────

interface FileListProps {
  readonly files: readonly GitFileStatus[];
  readonly selectedFilePath: string | null;
  readonly onSelect: (path: string) => void;
}

/** 变更文件列表：每项展示图标 + 路径 + 状态标签 */
function FileList({ files, selectedFilePath, onSelect }: FileListProps): ReactElement {
  return (
    <ul className="flex flex-col gap-0.5 p-1">
      {files.map((file) => {
        const Icon = getIconForFileStatus(file.status);
        const colorClass = getColorForFileStatus(file.status);
        const label = getLabelForFileStatus(file.status);
        const isSelected = file.path === selectedFilePath;

        return (
          <li key={file.path}>
            <button
              type="button"
              className={cn(
                'hover:bg-accent/50 flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors',
                isSelected && 'bg-accent/70',
              )}
              onClick={() => {
                onSelect(file.path);
              }}
            >
              <Icon className={cn('size-3 shrink-0', colorClass)} strokeWidth={1.5} />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[10px] font-mono',
                  isSelected ? 'text-foreground' : 'text-muted-foreground',
                )}
                title={file.path}
              >
                {file.path}
              </span>
              <span className={cn('text-[9px] shrink-0', colorClass)}>{label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ── 子组件：文件 diff 视图 ─────────────────────────────────────

interface FileDiffViewProps {
  readonly filePath: string;
  readonly diff: string | undefined;
  readonly additions: number | undefined;
  readonly deletions: number | undefined;
  readonly isLoading: boolean;
}

/** 文件 diff 视图：可折叠，展示 unified diff 文本 */
function FileDiffView({
  filePath,
  diff,
  additions,
  deletions,
  isLoading,
}: FileDiffViewProps): ReactElement {
  const [expanded, setExpanded] = useState(true);

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
          className="text-muted-foreground hover:text-foreground flex min-w-0 flex-1 items-center gap-1 text-[10px] transition-colors"
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

        {/* 增删统计 */}
        {additions !== undefined && deletions !== undefined && (
          <div className="flex shrink-0 items-center gap-1.5 text-[9px]">
            <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
            <span className="text-red-600 dark:text-red-400">-{deletions}</span>
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
            <div className="text-muted-foreground p-2 text-[10px]">无 diff 内容</div>
          ) : (
            <DiffText diff={diff} />
          )}
        </ScrollArea>
      )}
    </div>
  );
}

// ── 子组件：diff 文本渲染 ─────────────────────────────────────

interface DiffTextProps {
  readonly diff: string;
}

/**
 * 渲染 unified diff 文本
 *
 * 按行解析：
 * - `+` 开头：新增行，绿色背景
 * - `-` 开头：删除行，红色背景
 * - `@@` 开头：hunk 头，灰色
 * - 其他：普通行，默认色
 *
 * 使用 <pre> + 行级着色，避免引入复杂 diff 解析库。
 */
function DiffText({ diff }: DiffTextProps): ReactElement {
  const lines = diff.split('\n');

  return (
    <pre className="text-foreground/80 overflow-x-auto p-1 text-[10px] leading-relaxed font-mono">
      {lines.map((line, index) => {
        const key = `${index}-${line.slice(0, 20)}`;
        if (line.startsWith('+++') || line.startsWith('---')) {
          return (
            <div key={key} className="text-muted-foreground">
              {line}
            </div>
          );
        }
        if (line.startsWith('+')) {
          return (
            <div
              key={key}
              className="bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300"
            >
              {line}
            </div>
          );
        }
        if (line.startsWith('-')) {
          return (
            <div key={key} className="bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300">
              {line}
            </div>
          );
        }
        if (line.startsWith('@@')) {
          return (
            <div key={key} className="text-muted-foreground bg-muted/40">
              {line}
            </div>
          );
        }
        return <div key={key}>{line || ' '}</div>;
      })}
    </pre>
  );
}

// ── 子组件：加载中 / 空状态 / 错误状态 ─────────────────────────

/** 加载中骨架屏 */
function FileListSkeleton(): ReactElement {
  return (
    <ul className="flex flex-col gap-0.5 p-1">
      {Array.from({ length: 4 }).map((_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架屏占位，index 稳定且无重排
        <li key={index} className="px-1.5 py-1">
          <Skeleton className="h-3 w-full" />
        </li>
      ))}
    </ul>
  );
}

/** 工作区干净提示 */
function CleanHint(): ReactElement {
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-1 p-4 text-center">
      <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" strokeWidth={1.5} />
      <p className="font-serif text-xs tracking-wide">工作区干净</p>
      <p className="text-[10px]">无变更文件</p>
    </div>
  );
}

/** 错误状态提示 */
function ErrorHint({ message }: { readonly message: string }): ReactElement {
  return (
    <div className="text-destructive flex flex-col items-center gap-1 p-3 text-center">
      <AlertCircle className="size-4" strokeWidth={1.5} />
      <p className="font-serif text-xs">Git 状态获取失败</p>
      <p className="text-muted-foreground truncate text-[10px]" title={message}>
        {message}
      </p>
    </div>
  );
}

// ── 兼容导出 ────────────────────────────────────────────────

/** Git 面板默认导出（便于 lazy 加载） */
export default GitPanel;
