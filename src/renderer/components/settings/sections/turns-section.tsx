// turns-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · TurnsSection 独立面板
// ──────────────────────────────────────────────
// 拆分背景：SettingsDialog 1052 行多域混合，按域提取为独立文件（高内聚）
// ──────────────────────────────────────────────

import type { SessionRecentTurnsRes, TurnStatusText } from '@code-agent/shared/renderer';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import type { ReactElement } from 'react';
import { AsyncSection } from '@/components/common/AsyncSection';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';

export function TurnsSection(): ReactElement {
  const { t } = useTranslation();

  // 最近回合：TanStack Query（L3 服务端数据；浏览器模式守卫返回空列表）
  // 四态契约：pending→行内加载、error→提示+重试（此前 error 被静默渲染成空态）
  const {
    data: turns,
    isPending,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['turns', 'recent'],
    queryFn: async (): Promise<SessionRecentTurnsRes['turns']> => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return [];
      }
      return unwrap<SessionRecentTurnsRes>(await window.api.session.getRecentTurns({ limit: 10 }))
        .turns;
    },
  });

  const turnsList = turns ?? [];
  const statusKey: TurnStatusText = {
    completed: t('settings.turnStatusCompleted'),
    aborted: t('settings.turnStatusAborted'),
    'max-steps': t('settings.turnStatusMaxSteps'),
    error: t('settings.turnStatusError'),
  };

  return (
    <div className="flex flex-col gap-2 pt-2">
      <div className="flex items-center gap-2">
        <History className="size-4 text-muted-foreground" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">{t('settings.turnsSection')}</Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.turnsHint')}</p>

      <AsyncSection
        isPending={isPending}
        isError={isError}
        errorMessage={error instanceof Error ? error.message : null}
        onRetry={() => void refetch()}
        isEmpty={turnsList.length === 0}
        emptyText={t('settings.turnsEmpty')}
      >
        <ul className="flex flex-col gap-1 text-xs font-sans">
          {turnsList.map((turn) => (
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
      </AsyncSection>
    </div>
  );
}

/**
 * 自定义模型区块：添加/删除运行时模型（持久化 + 注册 + 缓存失效）
 *
 * 数据来源：settings:listRuntimeModels / addRuntimeModel / removeRuntimeModel。
 */
