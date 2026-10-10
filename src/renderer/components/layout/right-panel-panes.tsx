import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, FileText, Loader2 } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { QueryErrorRow } from '@/components/common/AsyncSection';
import { UnifiedDiffView } from '@/components/common/UnifiedDiffView';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useGitDiffQuery } from '@/hooks/use-git';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import { unwrapErrorMessage } from '@/lib/ipc';
import { TASK_LIST_QUERY_KEY } from '@/lib/query/keys';
import { fetchTaskList } from '@/lib/task-actions';
import { basename, cn } from '@/lib/utils';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';
import { useToolStore } from '@/stores/transient/tool-store';

/** 会话详情 pane props */
export interface InfoPaneProps {
  /** 当前会话 id（task 查询按会话过滤） */
  readonly sessionId: string;
}

/** 待办项形状（与 shared TaskInfo 对齐；status 驱动状态视觉，对齐参考项目 PlanNode 完成/活跃态） */
interface LocalTask {
  readonly id: string;
  readonly description: string;
  /** pending / running / completed / failed / cancelled */
  readonly status?: string;
}

/**
 * 会话详情 pane（对齐原型 crpPaneInfo：计划待办 / 会话信息）
 */
export function InfoPane({ sessionId }: InfoPaneProps): ReactElement {
  const { t } = useTranslation();
  const { getErrorMessage } = useErrorMessage();

  const {
    data: tasksData,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: TASK_LIST_QUERY_KEY(sessionId),
    queryFn: async () => fetchTaskList(sessionId),
  });

  const tasks = (tasksData?.tasks ?? []) as readonly LocalTask[];

  const calls = useToolStore((state) => state.callsBySession.get(sessionId) ?? EMPTY_CALLS);
  const seen = new Set<string>();
  const referencedFiles: string[] = [];
  for (const c of [...calls].reverse()) {
    if (c.toolName !== 'read_file') continue;
    const filePath =
      typeof c.input === 'object' && c.input !== null
        ? String((c.input as Record<string, unknown>)['path'] ?? '')
        : '';
    if (filePath !== '' && !seen.has(filePath)) {
      seen.add(filePath);
      referencedFiles.push(filePath);
    }
  }
  return (
    <div className="flex h-full flex-col gap-3 p-3 text-xs">
      <div className="min-h-0 flex-[2] overflow-y-auto">
        <div className="text-muted-foreground mb-1.5 text-2xs font-semibold tracking-wide uppercase">
          {t('panel.tasks')}
        </div>
        <QueryErrorRow
          isError={isError}
          errorMessage={error instanceof Error ? unwrapErrorMessage(error, getErrorMessage) : null}
          onRetry={() => void refetch()}
        />
        {!isError &&
          (tasks.length === 0 ? (
            <div className="text-muted-foreground">{t('panel.noTasks')}</div>
          ) : (
            <ul className="flex flex-col gap-1">
              {tasks.map((task) => {
                const status = task.status;
                const isDone = status === 'completed';
                const isActive = status === 'running';
                return (
                  <li
                    key={task.id ?? task.description}
                    className={cn(
                      'flex items-start gap-1.5 leading-relaxed',
                      isDone && 'text-muted-foreground line-through',
                      isActive && 'text-accent-text',
                      status === 'failed' && 'text-error-text',
                    )}
                  >
                    {isActive && (
                      <Loader2 className="text-accent-text mt-0.5 size-3 shrink-0 animate-spin" />
                    )}
                    <span className="min-w-0 flex-1">{task.description}</span>
                  </li>
                );
              })}
            </ul>
          ))}
      </div>

      <div className="border-muted-foreground/40 shrink-0 border-t" aria-hidden="true" />
      <div className="min-h-0 flex-[3] overflow-y-auto">
        <div className="text-muted-foreground mb-1.5 text-2xs font-semibold tracking-wide uppercase">
          {t('panel.referencedFiles')}
        </div>
        {referencedFiles.length === 0 ? (
          <div className="text-muted-foreground">{t('panel.noReferencedFiles')}</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {referencedFiles.map((filePath) => (
              <li
                key={filePath}
                className="text-foreground/80 truncate font-mono text-2xs"
                title={filePath}
              >
                {filePath}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** 工具调用形状（tool-store 条目投影） */
interface ToolCallEntry {
  readonly id: string;
  readonly toolName: string;
  readonly status: string;
  readonly input: unknown;
  readonly title: string;
}

/** 空调用列表（模块级常量：selector 返回稳定引用，避免无限重渲染） */
const EMPTY_CALLS: readonly ToolCallEntry[] = [];

/**
 * 单个变更项的行级 diff 主体（P3 修复）
 *
 * 此前 DiffPane 手写 diffCache + loadingDiff 状态机直调 git:diff——
 * 无竞态取消、无错误状态语义、跨会话残留风险。现改用 useGitDiffQuery：
 * 仅展开时启用（enabled），缓存/竞态/错误处理统一走 TanStack Query。
 */
function ChangeDiffBody({
  changePath,
  gitRepoPath,
  expanded,
}: {
  readonly changePath: string;
  readonly gitRepoPath: string | undefined;
  readonly expanded: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const {
    data: diffData,
    isLoading,
    isError,
  } = useGitDiffQuery(
    {
      path: gitRepoPath ?? '',
      ref: 'HEAD',
      staged: false,
      filePath: changePath,
    },
    expanded && gitRepoPath !== undefined && gitRepoPath.length > 0,
  );

  if (isLoading) {
    return (
      <div className="border-border bg-background overflow-x-auto rounded border px-2 py-1.5">
        <span className="text-muted-foreground">{t('panel.diffLoading')}</span>
      </div>
    );
  }
  if (isError || diffData === undefined) {
    return (
      <div className="border-border bg-background overflow-x-auto rounded border px-2 py-1.5">
        <span className="text-muted-foreground">{t('panel.diffUnavailable')}</span>
      </div>
    );
  }
  return (
    <div className="border-border bg-background overflow-x-auto rounded border px-2 py-1.5">
      <UnifiedDiffView diff={diffData.diff} />
    </div>
  );
}

/** 文件变更 pane：从 tool-store 提取 edit_file/write_file 记录（本轮文件变更） */
export function DiffPane({
  sessionId,
  gitRepoPath,
}: {
  readonly sessionId: string;
  /** Git 仓库路径（行级 diff 数据源；缺省则仅展示变更列表） */
  readonly gitRepoPath?: string;
}): ReactElement {
  const { t } = useTranslation();
  const openFile = useFileViewerStore((state) => state.openFile);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId 是故意的触发键（effect 仅用 setter）
  useEffect(() => {
    setExpanded(new Set());
  }, [sessionId]);

  const calls = useToolStore((state) => state.callsBySession.get(sessionId) ?? EMPTY_CALLS);

  const changes = calls
    .filter((c) => c.toolName === 'edit_file' || c.toolName === 'write_file')
    .filter((c) => c.status === 'success' || c.status === 'error')
    .map((c) => {
      const path =
        typeof c.input === 'object' && c.input !== null
          ? String((c.input as Record<string, unknown>)['path'] ?? '')
          : '';
      return {
        id: c.id,
        path,
        toolName: c.toolName,
        status: c.status,
        title: c.title,
      };
    })
    .reverse();

  if (changes.length === 0) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-3 text-xs">
        {t('panel.noChanges')}
      </div>
    );
  }

  const toggleChange = (changeId: string, _changePath: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(changeId)) {
        next.delete(changeId);
        return next;
      }
      next.add(changeId);
      return next;
    });
  };

  return (
    <ul className="h-full flex flex-col gap-1 overflow-y-auto p-3 text-xs">
      {changes.map((change) => (
        <li key={change.id} className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="border-border bg-muted/30 hover:bg-muted/60 h-auto w-full justify-start gap-2 rounded border px-2 py-1.5 text-left font-normal"
              onClick={() => toggleChange(change.id, change.path)}
              aria-expanded={expanded.has(change.id)}
            >
              {expanded.has(change.id) ? (
                <ChevronDown className="text-muted-foreground size-3 shrink-0" strokeWidth={1.5} />
              ) : (
                <ChevronRight className="text-muted-foreground size-3 shrink-0" strokeWidth={1.5} />
              )}
              <FileText className="text-muted-foreground size-3 shrink-0" strokeWidth={1.5} />
              <span className="text-foreground/90 min-w-0 flex-1 truncate" title={change.path}>
                {basename(change.path)}
              </span>
              <Badge
                variant="outline"
                className={
                  change.status === 'error'
                    ? 'text-error-text border-transparent font-mono text-2xs'
                    : 'text-success-text border-transparent font-mono text-2xs'
                }
              >
                {change.toolName === 'write_file' ? 'NEW' : 'EDIT'}
              </Badge>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="hover:bg-muted text-muted-foreground size-6 p-1.5"
              title={t('panel.openFile')}
              aria-label={t('panel.openFile')}
              onClick={() => openFile(change.path)}
            >
              <ExternalLink className="size-3" strokeWidth={1.5} />
            </Button>
          </div>
          {expanded.has(change.id) && (
            <ChangeDiffBody
              changePath={change.path}
              gitRepoPath={gitRepoPath}
              expanded={expanded.has(change.id)}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
