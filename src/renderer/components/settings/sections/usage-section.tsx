// usage-section.tsx（自 SettingsDialog 拆分）
// 设置全屏页 · UsageSection 用量统计面板
// ──────────────────────────────────────────────
// 设计（对齐同类桌面 LLM 客户端用量页 + GitHub 贡献热力图）：
// - ① 时间维度三卡：今日 / 近 30 天 / 累计（按日聚合前端计算）
// - ② 消耗热力图：近 30 天按日网格（6×5），色档 5 级，hover 显示日期+token
// - ③ 按模型占比：横向条形 + 百分比（一眼看出消耗分布）
// - ④ 按日明细列表（热力图数值兜底）
// - ⑤ 回合记录（并入用量：最近 Agent 回合的终止原因与 token 消耗）
//
// 数据源：session:getUsageSummary（byDay 近 30 天倒序）
// ──────────────────────────────────────────────

import type { UsageSummaryRes } from '@code-agent/shared/renderer';
import { BarChart3 } from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useState } from 'react';

import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { TurnsSection } from './turns-section';

/** token 数量友好格式化：≥1M → x.xM；≥1k → x.xk；否则原值 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 热力图色档（0 → 空；>0 按最大值分位 4 档） */
function heatLevel(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || max <= 0) return 0;
  const ratio = tokens / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** 生成近 N 天日期列表（倒序，today 在前；与 byDay 数据格式一致） */
function recentDays(count: number): string[] {
  const days: string[] = [];
  const now = new Date();
  for (let i = 0; i < count; i += 1) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    days.push(`${y}-${m}-${day}`);
  }
  return days;
}

/** 色档 → accent 透明度类 */
const HEAT_CLASS = [
  'bg-muted/20',
  'bg-accent/25',
  'bg-accent/50',
  'bg-accent/75',
  'bg-accent',
] as const;

export function UsageSection(): ReactElement {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<UsageSummaryRes | null>(null);

  useEffect(() => {
    // 浏览器模式（dev 预览）无 window.api：渲染空数据 UI 骨架
    // （0 值三卡 + 近 30 天 0 值热力图格子，形态完整可见）
    if (typeof window === 'undefined' || window.api === undefined) {
      setSummary({
        total: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        byModel: [],
        byDay: recentDays(30).map((date) => ({ date, calls: 0, totalTokens: 0 })),
      });
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

  // 热力图：byDay 为近 30 天倒序 → 转正序网格（最新在右下）
  const heatCells = useMemo(() => {
    const days = [...(summary?.byDay ?? [])].reverse();
    const max = days.reduce((m, d) => Math.max(m, d.totalTokens), 0);
    return { days, max };
  }, [summary]);

  // 近 30 天合计（"本月"近似，界面如实标注）
  const monthTokens = useMemo(
    () => (summary?.byDay ?? []).reduce((sum, d) => sum + d.totalTokens, 0),
    [summary],
  );
  const todayTokens = summary?.byDay[0]?.totalTokens ?? 0;

  // 模型占比：占总量百分比
  const modelRows = useMemo(() => {
    const total = summary?.total.totalTokens ?? 0;
    if (total <= 0) return [];
    return (summary?.byModel ?? []).map((m) => ({
      modelId: m.modelId,
      calls: m.calls,
      tokens: m.totalTokens,
      share: (m.totalTokens / total) * 100,
      reasoningTokens: m.reasoningTokens,
    }));
  }, [summary]);

  const isEmpty = summary === null;

  return (
    <div className="space-y-2 pt-2">
      <div className="flex items-center gap-2">
        <BarChart3 className="size-4 text-muted-foreground" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">{t('settings.usageSection')}</Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.usageHint')}</p>

      {isEmpty ? (
        <p className="text-xs text-muted-foreground font-sans">{t('settings.usageEmpty')}</p>
      ) : (
        <div className="space-y-4 font-sans">
          {/* ① 时间维度三卡：今日 / 近 30 天（本月近似）/ 累计 */}
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded border border-border p-2">
              <p className="text-muted-foreground">{t('settings.usageToday')}</p>
              <p className="mt-0.5 font-medium text-foreground">
                {formatTokens(todayTokens)}{' '}
                <span className="text-muted-foreground font-normal">tokens</span>
              </p>
            </div>
            <div className="rounded border border-border p-2">
              <p className="text-muted-foreground">{t('settings.usageMonth')}</p>
              <p className="mt-0.5 font-medium text-foreground">
                {formatTokens(monthTokens)}{' '}
                <span className="text-muted-foreground font-normal">tokens</span>
              </p>
            </div>
            <div className="rounded border border-border p-2">
              <p className="text-muted-foreground">{t('settings.usageTotal')}</p>
              <p className="mt-0.5 font-medium text-foreground">
                {formatTokens(summary?.total.totalTokens ?? 0)}{' '}
                <span className="text-muted-foreground font-normal">tokens</span>
              </p>
            </div>
          </div>

          {/* ② 消耗热力图（近 30 天，GitHub 风格 6×5 网格） */}
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              {t('settings.usageHeatmap')}
            </p>
            <div
              className="mt-1.5 grid gap-[3px]"
              style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}
              role="img"
              aria-label={t('settings.usageHeatmapAria')}
            >
              {heatCells.days.map((d) => {
                const level = heatLevel(d.totalTokens, heatCells.max);
                return (
                  <div
                    key={d.date}
                    title={`${d.date} · ${formatTokens(d.totalTokens)} tokens · ${d.calls} 次`}
                    className={`aspect-square w-full rounded-[3px] ${HEAT_CLASS[level]}`}
                  />
                );
              })}
            </div>
            <p className="text-muted-foreground mt-1 text-2xs">{t('settings.usageHeatmapHint')}</p>
          </div>

          {/* ③ 按模型占比（横向条形 + 百分比） */}
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              {t('settings.usageByModel')}
            </p>
            <ul className="mt-1.5 space-y-1.5 text-xs">
              {modelRows.map((m) => (
                <li key={m.modelId}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-foreground">{m.modelId}</span>
                    <span className="text-muted-foreground shrink-0">
                      {formatTokens(m.tokens)} tokens · {m.share.toFixed(0)}%
                      {m.reasoningTokens > 0
                        ? ` · ${t('settings.usageReasoning')} ${formatTokens(m.reasoningTokens)}`
                        : ''}
                    </span>
                  </div>
                  {/* 占比条（accent 宽度 = 占比） */}
                  <div className="bg-muted/30 mt-0.5 h-[5px] w-full overflow-hidden rounded-full">
                    <div
                      className="bg-accent h-full rounded-full"
                      style={{ width: `${Math.max(2, m.share)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* ④ 按日明细（近 30 天列表，热力图数值兜底） */}
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('settings.usageByDay')}</p>
            <ul className="mt-1 max-h-36 space-y-0.5 overflow-y-auto text-xs">
              {summary.byDay.map((d) => (
                <li
                  key={d.date}
                  className="flex items-center justify-between text-muted-foreground"
                >
                  <span>{d.date}</span>
                  <span className="text-muted-foreground">
                    {d.calls} 次 · {formatTokens(d.totalTokens)} tokens
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ⑤ 回合记录（并入用量：最近 Agent 回合的终止原因与 token 消耗） */}
      <TurnsSection />
    </div>
  );
}

/**
 * 回合记录区块：展示最近 Agent 回合的终止原因与 token 消耗（Transcript）
 *
 * 数据来源：session:getRecentTurns（turns 表跨会话倒序查询）。
 */
