// src/renderer/components/layout/right-panel-panes.tsx
// 右面板 pane 集：会话详情 / 文件变更 / 文件（对齐原型 chat-right-panel 的 info/diff/files）
// ──────────────────────────────────────────────────────────────
// 数据源：
// - InfoPane：goal:list / task:list（L3 Query）+ 会话元信息（props 传入）
// - DiffPane：tool-store 中 edit_file/write_file 调用记录（本轮文件变更）
// - FilesPane：最近修改文件列表（点击打开 FileViewerDialog）
// ──────────────────────────────────────────────────────────────

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FileText, FolderOpen, Plus, Target } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n/use-translation';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';
import { useToolStore } from '@/stores/transient/tool-store';

/** 会话详情 pane props */
export interface InfoPaneProps {
  /** 当前会话 id（goal/task 查询按会话过滤） */
  readonly sessionId: string;
  /** 工作目录（展示会话元信息；未知时省略） */
  readonly workingDir?: string;
  /** 默认模型（展示会话元信息） */
  readonly defaultModel?: string;
}

/** goal:list 查询 key */
const GOAL_LIST_QUERY_KEY = ['goal', 'list'] as const;
/** task:list 查询 key */
const TASK_LIST_QUERY_KEY = ['task', 'list'] as const;

/** 目标项形状（与 shared GoalInfo 对齐，浏览器模式兜底空数据用） */
interface LocalGoal {
  readonly condition: string;
}

/** 待办项形状（与 shared TaskInfo 对齐） */
interface LocalTask {
  readonly id: string;
  readonly description: string;
}

/**
 * 会话详情 pane（对齐原型 crpPaneInfo：会话目标 / 计划待办 / 会话信息）
 */
export function InfoPane({ sessionId, workingDir, defaultModel }: InfoPaneProps): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // 添加目标输入（对齐参考项目 GoalEditDialog）
  const [goalDraft, setGoalDraft] = useState('');

  // L3：目标列表（按会话过滤）
  const goalsQuery = useQuery({
    queryKey: [...GOAL_LIST_QUERY_KEY, sessionId],
    queryFn: async () => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return { goals: [] as unknown[] };
      }
      const response = await window.api.goal.list({ sessionId: sessionId ?? undefined });
      if ('error' in response && response.error !== undefined) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      if ('data' in response && response.data !== undefined) {
        return response.data;
      }
      throw new Error('Unexpected response');
    },
  });

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

  const goals = (goalsQuery.data?.goals ?? []) as LocalGoal[];
  const tasks = (tasksQuery.data?.tasks ?? []) as LocalTask[];

  // 创建目标 mutation（goal:create）
  const createGoalMutation = useMutation({
    mutationFn: async (condition: string) => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return { ok: true };
      }
      const response = await window.api.goal.create({ sessionId, condition });
      if ('error' in response) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      return response.data;
    },
    onSuccess: () => {
      setGoalDraft('');
      void queryClient.invalidateQueries({ queryKey: GOAL_LIST_QUERY_KEY });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-xs">
      {/* 会话目标 */}
      <div>
        <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-2xs font-semibold tracking-wide uppercase">
          <Target className="size-3" strokeWidth={1.5} />
          {t('panel.goals')}
        </div>
        {goals.length === 0 ? (
          <div className="text-muted-foreground/60">{t('panel.noGoals')}</div>
        ) : (
          <ul className="space-y-1">
            {goals.map((goal) => (
              <li key={goal.condition} className="text-foreground/90 leading-relaxed">
                {goal.condition}
              </li>
            ))}
          </ul>
        )}
        {/* 添加目标（对齐参考项目 GoalEditDialog） */}
        <form
          className="mt-1.5 flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const value = goalDraft.trim();
            if (value !== '') {
              createGoalMutation.mutate(value);
            }
          }}
        >
          <input
            type="text"
            value={goalDraft}
            onChange={(e) => setGoalDraft(e.target.value)}
            placeholder={t('panel.goalPlaceholder')}
            className="border-border bg-background focus:border-primary min-w-0 flex-1 rounded border px-2 py-1 text-xs focus:outline-none"
          />
          <button
            type="submit"
            disabled={goalDraft.trim() === '' || createGoalMutation.isPending}
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex shrink-0 cursor-pointer items-center gap-0.5 rounded border px-1.5 py-1 text-2xs transition-colors disabled:opacity-50"
            aria-label={t('panel.addGoal')}
          >
            <Plus className="size-2.5" />
          </button>
        </form>
      </div>

      {/* 计划待办 */}
      <div>
        <div className="text-muted-foreground mb-1.5 text-2xs font-semibold tracking-wide uppercase">
          {t('panel.tasks')}
        </div>
        {tasks.length === 0 ? (
          <div className="text-muted-foreground/60">{t('panel.noTasks')}</div>
        ) : (
          <ul className="space-y-1">
            {tasks.map((task) => (
              <li key={task.id ?? task.description} className="text-foreground/90 leading-relaxed">
                {task.description}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 会话信息 */}
      <div>
        <div className="text-muted-foreground mb-1.5 text-2xs font-semibold tracking-wide uppercase">
          {t('panel.sessionInfo')}
        </div>
        <dl className="space-y-1 font-mono text-2xs">
          <div className="flex gap-2">
            <dt className="text-muted-foreground shrink-0">session</dt>
            <dd className="text-foreground/80 min-w-0 truncate" title={sessionId}>
              {sessionId.slice(0, 12)}
            </dd>
          </div>
          {workingDir !== undefined && workingDir !== '' && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground shrink-0">cwd</dt>
              <dd className="text-foreground/80 min-w-0 truncate" title={workingDir}>
                {workingDir}
              </dd>
            </div>
          )}
          {defaultModel !== undefined && defaultModel !== '' && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground shrink-0">model</dt>
              <dd className="text-foreground/80 min-w-0 truncate">{defaultModel}</dd>
            </div>
          )}
        </dl>
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
  // 已展开的行级 diff（change.id → unified diff 文本）
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [diffCache, setDiffCache] = useState<Map<string, string>>(() => new Map());
  // 加载中标记（change.id → true）
  const [loadingDiff, setLoadingDiff] = useState<Set<string>>(() => new Set());

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

  // 展开/收起一个变更项（首次展开时拉取行级 diff）
  const toggleChange = (changeId: string, changePath: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(changeId)) {
        next.delete(changeId);
        return next;
      }
      next.add(changeId);
      return next;
    });
    // 已缓存或不在加载中：无需重复拉取
    if (diffCache.has(changeId) || loadingDiff.has(changeId)) {
      return;
    }
    if (typeof window === 'undefined' || window.api === undefined || gitRepoPath === undefined) {
      return;
    }
    setLoadingDiff((prev) => new Set(prev).add(changeId));
    window.api.git
      .diff({ path: gitRepoPath, filePath: changePath, ref: 'HEAD', staged: false })
      .then((res) => {
        if ('data' in res && res.data !== undefined) {
          setDiffCache((prev) => {
            const next = new Map(prev);
            next.set(changeId, res.data.diff);
            return next;
          });
        }
      })
      .catch(() => {
        toast.error(t('panel.diffLoadFailed'));
      })
      .finally(() => {
        setLoadingDiff((prev) => {
          const next = new Set(prev);
          next.delete(changeId);
          return next;
        });
      });
  };

  return (
    <ul className="h-full space-y-1 overflow-y-auto p-3 text-xs">
      {changes.map((change) => (
        <li key={change.id} className="space-y-0.5">
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
            <span
              className={
                change.status === 'error'
                  ? 'text-red-500 font-mono text-[9px]'
                  : 'text-emerald-600 dark:text-emerald-400 font-mono text-[9px]'
              }
            >
              {change.toolName === 'write_file' ? 'NEW' : 'EDIT'}
            </span>
          </button>
          {/* 行级 diff（展开态；git:diff 数据源） */}
          {expanded.has(change.id) && (
            <div className="border-border bg-background overflow-x-auto rounded border px-2 py-1.5 font-mono text-2xs leading-[1.6]">
              {loadingDiff.has(change.id) ? (
                <span className="text-muted-foreground">{t('panel.diffLoading')}</span>
              ) : diffCache.has(change.id) ? (
                <DiffLines diff={diffCache.get(change.id) ?? ''} />
              ) : (
                <span className="text-muted-foreground">{t('panel.diffUnavailable')}</span>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 行级 diff 渲染：unified diff 文本 → +/- 着色行（对齐原型 crpPaneDiff 行级展开） */
function DiffLines({ diff }: { readonly diff: string }): ReactElement {
  return (
    <pre className="m-0 whitespace-pre-wrap break-all">
      {diff.split('\n').map((line, index) => {
        // key 用 `index + 行首 24 字符` 组合：diff 行可能重复，纯 index 被 lint 禁止
        const lineKey = `${index}-${line.slice(0, 24)}`;
        const trimmed = line.trim();
        if (line.startsWith('+') && !line.startsWith('+++')) {
          return (
            <span
              key={lineKey}
              className="block bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            >
              {line || ' '}
            </span>
          );
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
          return (
            <span key={lineKey} className="block bg-red-500/10 text-red-600 dark:text-red-400">
              {line || ' '}
            </span>
          );
        }
        if (trimmed.startsWith('@@')) {
          return (
            <span key={lineKey} className="text-sky-600 dark:text-sky-400 block">
              {line}
            </span>
          );
        }
        return (
          <span key={lineKey} className="text-muted-foreground block">
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}

/** 文件 pane：最近修改文件列表（点击打开 FileViewerDialog） */
export function FilesPane({ sessionId }: { readonly sessionId: string }): ReactElement {
  const { t } = useTranslation();
  const openFile = useFileViewerStore((state) => state.openFile);

  // selector 只取稳定引用（Map.get 返回的数组；无记录时用模块级常量）
  // 在 selector 内遍历构建新数组 → 每次引用变化 → 无限重渲染
  const calls = useToolStore((state) => state.callsBySession.get(sessionId) ?? EMPTY_CALLS);

  // 派生：按路径去重（保留最新），仅真实数据变化时重算
  const files = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const c of [...calls].reverse()) {
      if (c.toolName !== 'edit_file' && c.toolName !== 'write_file') continue;
      const path =
        typeof c.input === 'object' && c.input !== null
          ? String((c.input as Record<string, unknown>)['path'] ?? '')
          : '';
      if (path !== '' && !seen.has(path)) {
        seen.add(path);
        result.push(path);
      }
    }
    return result;
  }, [calls]);

  if (files.length === 0) {
    return (
      <div className="text-muted-foreground/60 flex h-full flex-col items-center justify-center gap-1.5 p-3 text-xs">
        <FolderOpen className="size-4" strokeWidth={1.5} />
        {t('panel.noFiles')}
      </div>
    );
  }

  return (
    <ul className="h-full space-y-1 overflow-y-auto p-3 text-xs">
      {files.map((file) => (
        <li key={file}>
          <button
            type="button"
            className="hover:bg-muted text-foreground/90 flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left transition-colors"
            onClick={() => openFile(file)}
          >
            <FileText className="text-muted-foreground size-3 shrink-0" strokeWidth={1.5} />
            <span className="min-w-0 flex-1 truncate" title={file}>
              {file.split(/[\\/]/).pop() ?? file}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
