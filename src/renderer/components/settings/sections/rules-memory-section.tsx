// src/renderer/components/settings/sections/rules-memory-section.tsx
// 规则与记忆 pane（对齐 Trae Work：规则（AGENTS.md）+ 记忆管理）
// ──────────────────────────────────────────────────────────────
// - 规则：AGENTS.md 工程规范说明（项目根文件，agent 行为准则）
// - 记忆：memory:list 真实列表 + memory:clear（主进程 SQLite 持久化）
// ──────────────────────────────────────────────────────────────

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpenText, BrainCircuit, Loader2, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';
import { toast } from 'sonner';
import { AsyncSection } from '@/components/common/AsyncSection';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { confirm } from '@/stores/transient/confirm-dialog-store';

interface MemoryEntry {
  readonly id: string;
  readonly content: string;
}

/** 记忆查询 key 工厂（按会话隔离） */
const MEMORY_QUERY_KEY = (sessionId: string) => ['memory', 'list', sessionId] as const;

/** 规则与记忆 pane */
export function RulesMemorySection(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // 记忆按会话隔离：展示当前激活会话的记忆
  const activeSessionId = useActiveSessionStore((s) => s.activeSessionId);

  // P3 修复：memory:list 改走 TanStack Query（此前 useState 手动拉取，
  // 无缓存/去重/竞态取消，与同面板 useQuery 用法不一致）
  const {
    data: memoriesData,
    isLoading: loading,
    isError: memoriesFailed,
    error: memoriesError,
    refetch: refetchMemories,
  } = useQuery({
    queryKey: MEMORY_QUERY_KEY(activeSessionId ?? 'none'),
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

  // 清除 mutation：成功后失效当前会话记忆缓存
  const clearMutation = useMutation({
    mutationFn: async () => {
      if (activeSessionId === null) {
        return;
      }
      await window.api.memory.clear({ sessionId: activeSessionId });
    },
    onSuccess: () => {
      toast.success(t('settings.memoryCleared'));
      if (activeSessionId !== null) {
        void queryClient.invalidateQueries({ queryKey: MEMORY_QUERY_KEY(activeSessionId) });
      }
    },
    onError: () => {
      toast.error(t('settings.memoryClearFailed'));
    },
  });

  const handleClear = async (): Promise<void> => {
    // 一键清空全部记忆属破坏性操作：确认后才执行（此前直接执行无确认）
    const ok = await confirm({
      title: t('settings.memoryClear'),
      message: t('settings.memoryClearConfirmDesc', { count: memories.length }),
      danger: true,
    });
    if (!ok) return;
    await clearMutation.mutateAsync();
  };

  return (
    <div className="flex flex-col gap-4 pt-2">
      {/* 规则：AGENTS.md */}
      <div>
        <div className="flex items-center gap-2">
          <BookOpenText className="text-muted-foreground size-3.5" strokeWidth={1.5} />
          <h3 className="text-foreground text-sm font-semibold">{t('settings.rulesTitle')}</h3>
        </div>
        <p className="text-muted-foreground mt-1 max-w-md text-xs leading-relaxed">
          {t('settings.rulesHint')}
        </p>
        <div className="border-border bg-muted/20 mt-2 rounded-md border px-3 py-2.5">
          <code className="text-foreground/80 font-mono text-2xs">AGENTS.md</code>
          <span className="text-muted-foreground ml-2 text-2xs">{t('settings.rulesFileHint')}</span>
        </div>
      </div>

      {/* 记忆：真实列表 + 清除 */}
      <div>
        <div className="flex items-center gap-2">
          <BrainCircuit className="text-muted-foreground size-3.5" strokeWidth={1.5} />
          <h3 className="text-foreground text-sm font-semibold">{t('settings.memoryTitle')}</h3>
          {memories.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={clearMutation.isPending}
              onClick={() => void handleClear()}
              className="text-muted-foreground hover:text-error-text ml-auto h-6 gap-1 px-2 text-2xs"
            >
              {clearMutation.isPending ? (
                <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
              ) : (
                <Trash2 className="size-3" strokeWidth={1.5} />
              )}
              {t('settings.memoryClear')}
            </Button>
          )}
        </div>
        <AsyncSection
          isPending={loading}
          isError={memoriesFailed}
          errorMessage={memoriesError instanceof Error ? memoriesError.message : null}
          onRetry={() => void refetchMemories()}
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
      </div>
    </div>
  );
}
