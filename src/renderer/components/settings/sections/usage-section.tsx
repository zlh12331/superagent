// usage-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · UsageSection 独立面板
// ──────────────────────────────────────────────
// 拆分背景：SettingsDialog 1052 行多域混合，按域提取为独立文件（高内聚）
// ──────────────────────────────────────────────

import type { UsageSummaryRes } from '@code-agent/shared/renderer';
import { BarChart3 } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';

import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';

export function UsageSection(): ReactElement {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<UsageSummaryRes | null>(null);

  useEffect(() => {
    // 浏览器模式（dev 预览）无 window.api：静默空数据
    if (typeof window === 'undefined' || window.api === undefined) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    window.api.session
      .getUsageSummary()
      .then((res) => {
        if (!cancelled) {
          setSummary(unwrap<UsageSummaryRes>(res));
        }
      })
      .catch(() => {
        toast.error(t('settings.usageLoadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const isEmpty = summary === null || summary.total.calls === 0;

  return (
    <div className="space-y-2 pt-2">
      <div className="flex items-center gap-2">
        <BarChart3 className="size-4 text-stone-600" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">{t('settings.usageSection')}</Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.usageHint')}</p>

      {isEmpty ? (
        <p className="text-xs text-muted-foreground font-sans">{t('settings.usageEmpty')}</p>
      ) : (
        <div className="space-y-2 font-sans">
          {/* 总量 */}
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded border border-stone-200 p-2">
              <p className="text-muted-foreground">{t('settings.usageTotalCalls')}</p>
              <p className="mt-0.5 font-medium text-stone-800">{summary.total.calls}</p>
            </div>
            <div className="rounded border border-stone-200 p-2">
              <p className="text-muted-foreground">{t('settings.usageTotalTokens')}</p>
              <p className="mt-0.5 font-medium text-stone-800">{summary.total.totalTokens}</p>
            </div>
            <div className="rounded border border-stone-200 p-2">
              <p className="text-muted-foreground">{t('settings.usageCacheHit')}</p>
              <p className="mt-0.5 font-medium text-stone-800">
                {summary.byModel.reduce((sum, m) => sum + m.cacheReadTokens, 0)}
              </p>
            </div>
          </div>

          {/* 按模型 */}
          <div>
            <p className="text-xs font-medium text-stone-600">{t('settings.usageByModel')}</p>
            <ul className="mt-1 space-y-1 text-xs">
              {summary.byModel.map((m) => (
                <li
                  key={m.modelId}
                  className="flex items-center justify-between rounded border border-stone-100 px-2 py-1"
                >
                  <span className="truncate text-stone-700">{m.modelId}</span>
                  <span className="ml-2 shrink-0 text-muted-foreground">
                    {m.calls} 次 · {m.totalTokens} tokens
                    {m.reasoningTokens > 0
                      ? ` · ${t('settings.usageReasoning')} ${m.reasoningTokens}`
                      : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* 按日 */}
          <div>
            <p className="text-xs font-medium text-stone-600">{t('settings.usageByDay')}</p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {summary.byDay.map((d) => (
                <li key={d.date} className="flex items-center justify-between text-stone-600">
                  <span>{d.date}</span>
                  <span className="text-muted-foreground">
                    {d.calls} 次 · {d.totalTokens} tokens
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 回合记录区块：展示最近 Agent 回合的终止原因与 token 消耗（Transcript）
 *
 * 数据来源：session:getRecentTurns（turns 表跨会话倒序查询）。
 */
