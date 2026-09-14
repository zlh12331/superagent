// src/renderer/components/settings/sections/memory-panel.tsx
// 记忆管理面板（从 rules-memory-section 提取：开关 + 引擎状态 + 列表 + 清除）
// ──────────────────────────────────────────────────────────────
// 拆分理由：规则（AGENTS.md 说明，纯静态）与记忆（有状态的管理界面）是两个
// 关注点；合并后单函数体已超函数体棘轮门槛。
// ──────────────────────────────────────────────────────────────

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrainCircuit, Loader2, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';
import { toast } from 'sonner';
import { AsyncSection } from '@/components/common/AsyncSection';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { MEMORY_LIST_QUERY_KEY, MEMORY_STATUS_QUERY_KEY, QUERY_KEY_ROOTS } from '@/lib/query/keys';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { confirm } from '@/stores/transient/confirm-dialog-store';
import { ToggleRow } from '../settings-controls';

interface MemoryEntry {
  readonly id: string;
  readonly content: string;
}

/**
 * 清空会话记忆（模块级：从组件提取以保持函数体精简）
 *
 * 主进程在引擎不可用时返回 `{ ok: false }`（不是 `{ error }`），
 * 因此必须显式检查 ok 并抛错，否则清除失败会被当作成功提示。
 */
async function clearMemoryOrThrow(sessionId: string): Promise<void> {
  const res = unwrap(await window.api.memory.clear({ sessionId }));
  if (!res.ok) {
    throw new Error('memory clear failed');
  }
}

/** 清空全部记忆（同上：ok=false 需显式抛错） */
async function clearAllMemoryOrThrow(): Promise<{ clearedSessions: number }> {
  const res = unwrap(await window.api.memory.clearAll({}));
  if (!res.ok) {
    throw new Error(res.message ?? 'memory clear all failed');
  }
  return { clearedSessions: res.clearedSessions };
}

/** 引擎状态文案（区分"未随包提供/未启动/运行中/运行但不健康"） */
function statusTextOf(
  status: { available: boolean; running: boolean; healthy: boolean } | null,
  t: (key: string) => string,
): string {
  if (status === null) return '';
  if (!status.available) return t('settings.memoryStatusUnavailable');
  if (!status.running) return t('settings.memoryStatusStopped');
  return status.healthy ? t('settings.memoryStatusRunning') : t('settings.memoryStatusDegraded');
}

/** 引擎状态条（未随包提供/未启动/运行中 + 数据量） */
function MemoryStatusBar({
  status,
  text,
}: {
  readonly status: { sessionCount: number; recordCount: number } | null;
  readonly text: string;
}): ReactElement | null {
  const { t } = useTranslation();
  if (status === null) return null;
  return (
    <div className="border-border bg-muted/20 mt-2 flex items-center gap-2 rounded-md border px-3 py-2 text-2xs">
      <span className="text-muted-foreground">{t('settings.memoryStatus')}</span>
      <span className="text-foreground/80">{text}</span>
      {status.sessionCount > 0 && (
        <span className="text-muted-foreground ml-auto">
          {t('settings.memoryStats', {
            records: status.recordCount,
            sessions: status.sessionCount,
          })}
        </span>
      )}
    </div>
  );
}

/** 当前会话的记忆条目列表（空态由 AsyncSection 统一处理） */
function MemoryEntryList({
  memories,
  activeSessionId,
  loading,
  failed,
  errorMessage,
  onRetry,
}: {
  readonly memories: readonly MemoryEntry[];
  readonly activeSessionId: string | null;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly errorMessage: string | null;
  readonly onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <AsyncSection
      isPending={loading}
      isError={failed}
      errorMessage={errorMessage}
      onRetry={onRetry}
      isEmpty={activeSessionId === null || memories.length === 0}
      emptyText={
        activeSessionId === null ? t('settings.memoryNoSession') : t('settings.memoryEmpty')
      }
    >
      <ul className="mt-2 max-h-64 flex flex-col gap-1 overflow-y-auto">
        {memories.map((m) => (
          <li
            key={m.id}
            className="border-border bg-muted/30 rounded border px-2 py-1.5 text-xs leading-relaxed"
          >
            {m.content}
          </li>
        ))}
      </ul>
    </AsyncSection>
  );
}

/** 记忆清除操作（会话级 + 全量；含确认弹窗与 toast 反馈） */
function useMemoryClear(params: {
  readonly activeSessionId: string | null;
  readonly memoryCount: number;
  readonly sessionCount: number;
}): {
  readonly clearOne: () => Promise<void>;
  readonly clearAll: () => Promise<void>;
  readonly clearingOne: boolean;
  readonly clearingAll: boolean;
} {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { activeSessionId, memoryCount, sessionCount } = params;

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY_ROOTS.memory });
  };

  const clearOneMutation = useMutation({
    mutationFn: async () => {
      if (activeSessionId === null) return;
      await clearMemoryOrThrow(activeSessionId);
    },
    onSuccess: () => {
      toast.success(t('settings.memoryCleared'));
      invalidate();
    },
    onError: () => {
      toast.error(t('settings.memoryClearFailed'));
    },
  });

  const clearAllMutation = useMutation({
    mutationFn: clearAllMemoryOrThrow,
    onSuccess: (result) => {
      toast.success(t('settings.memoryClearedAll', { sessions: result.clearedSessions }));
      invalidate();
    },
    onError: () => {
      toast.error(t('settings.memoryClearAllFailed'));
    },
  });

  return {
    clearingOne: clearOneMutation.isPending,
    clearingAll: clearAllMutation.isPending,
    clearOne: async () => {
      const ok = await confirm({
        title: t('settings.memoryClear'),
        message: t('settings.memoryClearConfirmDesc', { count: memoryCount }),
        danger: true,
      });
      if (ok) await clearOneMutation.mutateAsync();
    },
    clearAll: async () => {
      const ok = await confirm({
        title: t('settings.memoryClearAll'),
        message: t('settings.memoryClearAllConfirmDesc', { count: sessionCount }),
        danger: true,
      });
      if (ok) await clearAllMutation.mutateAsync();
    },
  };
}

/** 面板标题栏（含"清除当前会话"按钮，仅在当前会话有记忆时显示） */
function MemoryHeader({
  showClear,
  clearing,
  onClear,
}: {
  readonly showClear: boolean;
  readonly clearing: boolean;
  readonly onClear: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <BrainCircuit className="text-muted-foreground size-3.5" strokeWidth={1.5} />
      <h3 className="text-foreground text-sm font-semibold">{t('settings.memoryTitle')}</h3>
      {showClear && (
        <Button
          variant="ghost"
          size="sm"
          disabled={clearing}
          onClick={onClear}
          className="text-muted-foreground hover:text-error-text ml-auto h-6 gap-1 px-2 text-2xs"
        >
          {clearing ? (
            <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
          ) : (
            <Trash2 className="size-3" strokeWidth={1.5} />
          )}
          {t('settings.memoryClear')}
        </Button>
      )}
    </div>
  );
}

/** 记忆：开关 + 状态 + 列表 + 清除（会话级 / 全量） */
export function MemoryPanel(): ReactElement {
  const { t } = useTranslation();
  // 记忆按会话隔离：展示当前激活会话的记忆
  const activeSessionId = useActiveSessionStore((s) => s.activeSessionId);
  // 隐私开关（写穿透 SQLite；主进程侧 1s 缓存后生效）
  const memoryEnabled = useSettingsStore((s) => s.memory.enabled);
  const updateMemory = useSettingsStore((s) => s.updateMemory);

  const {
    data: memoriesData,
    isLoading: loading,
    isError: memoriesFailed,
    error: memoriesError,
    refetch: refetchMemories,
  } = useQuery({
    queryKey: MEMORY_LIST_QUERY_KEY(activeSessionId ?? 'none'),
    enabled: activeSessionId !== null,
    queryFn: async () => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return { memories: [] as MemoryEntry[] };
      }
      const sid = activeSessionId as string;
      const data = unwrap(await window.api.memory.list({ sessionId: sid }));
      return {
        memories: (data.memories ?? []).map((m) => ({
          id: String(m.id),
          content: String(m.content ?? ''),
        })),
      };
    },
  });
  const memories = memoriesData?.memories ?? [];

  // 引擎状态：面板打开时拉一次（不轮询——状态变化低频，且拉取本身不启动引擎）
  const { data: status } = useQuery({
    queryKey: MEMORY_STATUS_QUERY_KEY,
    queryFn: async () => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return null;
      }
      return unwrap(await window.api.memory.status({}));
    },
  });
  const statusText = statusTextOf(status ?? null, t);
  const { clearOne, clearAll, clearingOne, clearingAll } = useMemoryClear({
    activeSessionId,
    memoryCount: memories.length,
    sessionCount: status?.sessionCount ?? 0,
  });

  return (
    <div>
      <MemoryHeader
        showClear={memories.length > 0}
        clearing={clearingOne}
        onClear={() => void clearOne()}
      />

      {/* 隐私开关（默认开启；关闭后不捕获也不召回，已记录数据保留） */}
      <div className="mt-2">
        <ToggleRow
          name={t('settings.memoryEnabled')}
          description={t('settings.memoryEnabledHint')}
          checked={memoryEnabled}
          onChange={(checked) => updateMemory({ enabled: checked })}
        />
      </div>

      {/* 引擎状态 + 数据量（不轮询；状态变化低频） */}
      <MemoryStatusBar status={status ?? null} text={statusText} />

      <MemoryEntryList
        memories={memories}
        activeSessionId={activeSessionId}
        loading={loading}
        failed={memoriesFailed}
        errorMessage={memoriesError instanceof Error ? memoriesError.message : null}
        onRetry={() => void refetchMemories()}
      />

      {/* 清除全部记忆（跨全部会话；仅在有数据时显示） */}
      {(status?.sessionCount ?? 0) > 0 && (
        <div className="mt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={clearingAll}
            onClick={() => void clearAll()}
            className="text-error-text hover:bg-error/10 h-7 gap-1.5 px-2.5 text-xs"
          >
            {clearingAll ? (
              <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
            ) : (
              <Trash2 className="size-3" strokeWidth={1.5} />
            )}
            {t('settings.memoryClearAll')}
          </Button>
        </div>
      )}
    </div>
  );
}
