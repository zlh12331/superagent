// src/renderer/components/layout/right-panel-panes.tsx
// 右面板 pane 集：会话详情 / 文件变更 / 文件（对齐原型 chat-right-panel 的 info/diff/files）
// ──────────────────────────────────────────────────────────────
// 数据源：
// - InfoPane：goal:list / task:list（L3 Query）+ 会话元信息（props 传入）
// - DiffPane：tool-store 中 edit_file/write_file 调用记录（本轮文件变更）
// - FilesPane：最近修改文件列表（点击打开 FileViewerDialog）
// ──────────────────────────────────────────────────────────────

import { useQuery } from '@tanstack/react-query';
import { FileText, FolderOpen, Target } from 'lucide-react';
import type { ReactElement } from 'react';
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
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-xs">
      {/* 会话目标 */}
      <div>
        <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-wide uppercase">
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
      </div>

      {/* 计划待办 */}
      <div>
        <div className="text-muted-foreground mb-1.5 text-[10px] font-semibold tracking-wide uppercase">
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
        <div className="text-muted-foreground mb-1.5 text-[10px] font-semibold tracking-wide uppercase">
          {t('panel.sessionInfo')}
        </div>
        <dl className="space-y-1 font-mono text-[10px]">
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

/** 文件变更 pane：从 tool-store 提取 edit_file/write_file 记录（本轮文件变更） */
export function DiffPane({ sessionId }: { readonly sessionId: string }): ReactElement {
  const { t } = useTranslation();

  // 从 tool-store 提取当前会话的文件变更工具调用（已完成的）
  const changes = useToolStore((state) => {
    const calls = state.callsBySession.get(sessionId) ?? [];
    return calls
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
  });

  if (changes.length === 0) {
    return (
      <div className="text-muted-foreground/60 flex h-full items-center justify-center p-3 text-xs">
        {t('panel.noChanges')}
      </div>
    );
  }

  return (
    <ul className="h-full space-y-1 overflow-y-auto p-3 text-xs">
      {changes.map((change) => (
        <li
          key={change.id}
          className="border-border bg-muted/30 flex items-center gap-2 rounded border px-2 py-1.5"
        >
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
        </li>
      ))}
    </ul>
  );
}

/** 文件 pane：最近修改文件列表（点击打开 FileViewerDialog） */
export function FilesPane({ sessionId }: { readonly sessionId: string }): ReactElement {
  const { t } = useTranslation();
  const openFile = useFileViewerStore((state) => state.openFile);

  // 从 tool-store 提取去重后的文件路径（edit_file/write_file 按路径去重，保留最新）
  const files = useToolStore((state) => {
    const calls = state.callsBySession.get(sessionId) ?? [];
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
  });

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
