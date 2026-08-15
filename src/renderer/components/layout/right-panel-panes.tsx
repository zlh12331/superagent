// src/renderer/components/layout/right-panel-panes.tsx
// 右面板 pane 集：会话详情 / 文件变更（对齐原型 chat-right-panel 的 info/diff）
// ──────────────────────────────────────────────────────────────
// 数据源：
// - InfoPane：task:list（L3 Query）+ 会话元信息（props 传入）
// - DiffPane：tool-store 中 edit_file/write_file 调用记录（本轮文件变更；行项可展开 diff 或直接打开文件）
// - 会话目标已迁移至对话区输入框上方（ChatPanel 目标栏），右面板不再重复展示
// ──────────────────────────────────────────────────────────────

import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, FileText, Loader2 } from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { UnifiedDiffView } from '@/components/common/UnifiedDiffView';
import { Badge } from '@/components/ui/badge';
import { useGitDiffQuery } from '@/hooks/use-git';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';
import { useToolStore } from '@/stores/transient/tool-store';

/** 会话详情 pane props */
export interface InfoPaneProps {
  /** 当前会话 id（task 查询按会话过滤） */
  readonly sessionId: string;
}

/** task:list 查询 key */
const TASK_LIST_QUERY_KEY = ['task', 'list'] as const;

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

  // L3：待办列表（按会话过滤）
  const tasksQuery = useQuery({
    queryKey: [...TASK_LIST_QUERY_KEY, sessionId],
    queryFn: async () => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return { tasks: [] as unknown[] };
      }
      const response = await window.api.task.list({ sessionId: sessionId ?? undefined });
      if ('error' in response && response.error !== undefined) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      if ('data' in response && response.data !== undefined) {
        return response.data;
      }
      throw new Error('Unexpected response');
    },
  });

  const tasks = (tasksQuery.data?.tasks ?? []) as LocalTask[];

  // 引用文件（对齐原型 crpFiles）：从 tool-store 提取 read_file 调用路径（去重，保留最新）
  const calls = useToolStore((state) => state.callsBySession.get(sessionId) ?? EMPTY_CALLS);
  const referencedFiles = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const c of [...calls].reverse()) {
      if (c.toolName !== 'read_file') continue;
      const filePath =
        typeof c.input === 'object' && c.input !== null
          ? String((c.input as Record<string, unknown>)['path'] ?? '')
          : '';
      if (filePath !== '' && !seen.has(filePath)) {
        seen.add(filePath);
        result.push(filePath);
      }
    }
    return result;
  }, [calls]);
  return (
    <div className="flex h-full flex-col gap-3 p-3 text-xs">
      {/* 计划待办（占 40% 空间，用户要求）：状态视觉对齐参考项目 PlanNode（completed 删除线 / running spinner / failed error） */}
      <div className="min-h-0 flex-[2] overflow-y-auto">
        <div className="text-muted-foreground mb-1.5 text-2xs font-semibold tracking-wide uppercase">
          {t('panel.tasks')}
        </div>
        {tasks.length === 0 ? (
          <div className="text-muted-foreground/60">{t('panel.noTasks')}</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {tasks.map((task) => {
              // 状态视觉（对齐参考项目 PlanNode：完成 = 删除线淡色；运行中 = spinner + accent；失败 = error 色）
              const status = task.status;
              const isDone = status === 'completed';
              const isActive = status === 'running';
              return (
                <li
                  key={task.id ?? task.description}
                  className={cn(
                    'flex items-start gap-1.5 leading-relaxed',
                    isDone && 'text-muted-foreground/60 line-through',
                    isActive && 'text-[var(--accent)]',
                    status === 'failed' && 'text-destructive',
                  )}
                >
                  {/* 运行中：旋转 spinner（对齐参考项目 active 态） */}
                  {isActive && (
                    <Loader2 className="text-[var(--accent)] mt-0.5 size-3 shrink-0 animate-spin" />
                  )}
                  <span className="min-w-0 flex-1">{task.description}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 引用文件（占 60% 空间，用户要求）：从 tool-store 提取 read_file 路径去重 */}
      <div className="min-h-0 flex-[3] overflow-y-auto">
        <div className="text-muted-foreground mb-1.5 text-2xs font-semibold tracking-wide uppercase">
          {t('panel.referencedFiles')}
        </div>
        {referencedFiles.length === 0 ? (
          <div className="text-muted-foreground/60">{t('panel.noReferencedFiles')}</div>
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
  // 已展开的变更项（change.id 集合；行级 diff 由 ChangeDiffBody 经 useGitDiffQuery 拉取）
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // 会话切换清空展开态（DevPanel 跨会话保持，避免旧会话展开态残留）
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId 是故意的触发键（effect 仅用 setter）
  useEffect(() => {
    setExpanded(new Set());
  }, [sessionId]);

  // selector 只取稳定引用（Map.get 返回的数组；无记录时用模块级常量）：
  // 在 selector 内 filter/map 会每次返回新数组 → Zustand 认为状态变化 → 无限重渲染
  const calls = useToolStore((state) => state.callsBySession.get(sessionId) ?? EMPTY_CALLS);

  // 派生：文件变更记录（useMemo 依赖稳定引用，仅真实数据变化时重算）
  const changes = useMemo(
    () =>
      calls
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
        .reverse(),
    [calls],
  );

  if (changes.length === 0) {
    return (
      <div className="text-muted-foreground/60 flex h-full items-center justify-center p-3 text-xs">
        {t('panel.noChanges')}
      </div>
    );
  }

  // 展开/收起一个变更项（P3 修复：仅切换展开态——行级 diff 改由
  // ChangeDiffBody 的 useGitDiffQuery 拉取，删除手写 diffCache/loadingDiff 状态机，
  // 获得竞态取消、错误语义与缓存一致性）
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
            <button
              type="button"
              onClick={() => toggleChange(change.id, change.path)}
              className="border-border bg-muted/30 hover:bg-muted/60 flex w-full cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-left transition-colors"
              aria-expanded={expanded.has(change.id)}
            >
              {expanded.has(change.id) ? (
                <ChevronDown className="text-muted-foreground size-3 shrink-0" strokeWidth={1.5} />
              ) : (
                <ChevronRight className="text-muted-foreground size-3 shrink-0" strokeWidth={1.5} />
              )}
              <FileText className="text-muted-foreground size-3 shrink-0" strokeWidth={1.5} />
              <span className="text-foreground/90 min-w-0 flex-1 truncate" title={change.path}>
                {change.path.split(/[\\/]/).pop() ?? change.path}
              </span>
              <Badge
                variant="outline"
                className={
                  change.status === 'error'
                    ? 'text-[var(--error)] border-transparent font-mono text-[9px]'
                    : 'text-[var(--success)] border-transparent font-mono text-[9px]'
                }
              >
                {change.toolName === 'write_file' ? 'NEW' : 'EDIT'}
              </Badge>
            </button>
            {/* 打开文件（合并自原"文件"tab 的快速打开场景） */}
            <button
              type="button"
              className="hover:bg-muted text-muted-foreground flex shrink-0 cursor-pointer items-center rounded p-1.5 transition-colors"
              title={t('panel.openFile')}
              aria-label={t('panel.openFile')}
              onClick={() => openFile(change.path)}
            >
              <ExternalLink className="size-3" strokeWidth={1.5} />
            </button>
          </div>
          {/* 行级 diff（展开态；useGitDiffQuery → UnifiedDiffView 双栏渲染） */}
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
