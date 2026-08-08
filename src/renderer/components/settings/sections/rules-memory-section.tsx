// src/renderer/components/settings/sections/rules-memory-section.tsx
// 规则与记忆 pane（对齐 Trae Work：规则（AGENTS.md）+ 记忆管理）
// ──────────────────────────────────────────────────────────────
// - 规则：AGENTS.md 工程规范说明（项目根文件，agent 行为准则）
// - 记忆：memory:list 真实列表 + memory:clear（主进程 SQLite 持久化）
// ──────────────────────────────────────────────────────────────

import { BookOpenText, BrainCircuit, Loader2, Trash2 } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';

interface MemoryEntry {
  readonly id: string;
  readonly content: string;
}

/** 规则与记忆 pane */
export function RulesMemorySection(): ReactElement {
  const { t } = useTranslation();
  // 记忆按会话隔离：展示当前激活会话的记忆
  const activeSessionId = useActiveSessionStore((s) => s.activeSessionId);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);

  const loadMemories = async (): Promise<void> => {
    if (typeof window === 'undefined' || window.api === undefined || activeSessionId === null) {
      setMemories([]);
      setLoading(false);
      return;
    }
    try {
      const res = await window.api.memory.list({ sessionId: activeSessionId });
      if ('data' in res && res.data !== undefined) {
        setMemories(
          (res.data.memories ?? []).map((m) => ({
            id: String(m.id),
            content: String(m.content ?? ''),
          })),
        );
      }
    } catch {
      setMemories([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    void loadMemories();
    // biome-ignore lint/correctness/useExhaustiveDependencies: 会话变化时重载记忆
  }, [activeSessionId]);

  const handleClear = async (): Promise<void> => {
    if (activeSessionId === null) {
      return;
    }
    setClearing(true);
    try {
      await window.api.memory.clear({ sessionId: activeSessionId });
      toast.success(t('settings.memoryCleared'));
      await loadMemories();
    } catch {
      toast.error(t('settings.memoryClearFailed'));
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="space-y-4 pt-2">
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
              disabled={clearing}
              onClick={() => void handleClear()}
              className="text-muted-foreground hover:text-red-500 ml-auto h-6 gap-1 px-2 text-2xs"
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
        {loading ? (
          <div className="text-muted-foreground mt-2 text-xs">{t('common.loading')}</div>
        ) : activeSessionId === null ? (
          <div className="text-muted-foreground/60 mt-2 text-xs">
            {t('settings.memoryNoSession')}
          </div>
        ) : memories.length === 0 ? (
          <div className="text-muted-foreground/60 mt-2 text-xs">{t('settings.memoryEmpty')}</div>
        ) : (
          <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
            {memories.map((m) => (
              <li
                key={m.id}
                className="border-border bg-muted/30 rounded border px-2 py-1.5 text-xs leading-relaxed"
              >
                {m.content}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
