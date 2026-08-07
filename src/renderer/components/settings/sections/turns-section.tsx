// turns-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · TurnsSection 独立面板
// ──────────────────────────────────────────────
// 拆分背景：SettingsDialog 1052 行多域混合，按域提取为独立文件（高内聚）
// ──────────────────────────────────────────────

import type { SessionRecentTurnsRes, TurnStatusText } from '@code-agent/shared/renderer';
import { History } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';

import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';

export function TurnsSection(): ReactElement {
  const { t } = useTranslation();
  const [turns, setTurns] = useState<SessionRecentTurnsRes['turns'] | null>(null);

  useEffect(() => {
    // 浏览器模式（dev 预览）无 window.api：静默空列表
    if (typeof window === 'undefined' || window.api === undefined) {
      setTurns([]);
      return;
    }
    let cancelled = false;
    window.api.session
      .getRecentTurns({ limit: 10 })
      .then((res) => {
        if (!cancelled) {
          setTurns(unwrap<SessionRecentTurnsRes>(res).turns);
        }
      })
      .catch(() => {
        toast.error(t('settings.turnsLoadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const isEmpty = turns === null || turns.length === 0;
  const statusKey: TurnStatusText = {
    completed: t('settings.turnStatusCompleted'),
    aborted: t('settings.turnStatusAborted'),
    'max-steps': t('settings.turnStatusMaxSteps'),
    error: t('settings.turnStatusError'),
  };

  return (
    <div className="space-y-2 pt-2">
      <div className="flex items-center gap-2">
        <History className="size-4 text-muted-foreground" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">{t('settings.turnsSection')}</Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.turnsHint')}</p>

      {isEmpty ? (
        <p className="text-xs text-muted-foreground font-sans">{t('settings.turnsEmpty')}</p>
      ) : (
        <ul className="space-y-1 text-xs font-sans">
          {turns.map((turn) => (
            <li
              key={turn.turnId}
              className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1"
            >
              <span className="truncate text-foreground">
                {turn.modelId}
                <span className="ml-1 text-muted-foreground">#{turn.seq}</span>
              </span>
              <span className="ml-2 shrink-0 text-muted-foreground">
                {statusKey[turn.status] ?? turn.status}
                {turn.totalTokens !== undefined ? ` · ${turn.totalTokens} tokens` : ''}
                {turn.durationMs !== undefined ? ` · ${Math.round(turn.durationMs / 1000)}s` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 自定义模型区块：添加/删除运行时模型（持久化 + 注册 + 缓存失效）
 *
 * 数据来源：settings:listRuntimeModels / addRuntimeModel / removeRuntimeModel。
 */
