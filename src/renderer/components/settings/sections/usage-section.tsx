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
import CalendarHeatmap from 'react-calendar-heatmap';

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

/** 热力图色档（react-calendar-heatmap classForValue：color-empty / color-scale-1..4） */
const HEAT_SCALE_CLASS = [
  'color-empty',
  'color-scale-1',
  'color-scale-2',
  'color-scale-3',
  'color-scale-4',
];

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
        byDay: recentDays(90).map((date) => ({ date, calls: 0, totalTokens: 0 })),
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

  // 热力图：react-calendar-heatmap 数据（date 格式 YYYY-MM-DD + count = 当日 tokens）
  const heatValue = useMemo(
    () => (summary?.byDay ?? []).map((d) => ({ date: d.date, count: d.totalTokens })),
    [summary],
  );
  const heatEnd = useMemo(() => new Date(), []);
  const heatStart = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 89);
    return d;
  }, []);

  // 热力图色档分位基准（当日最大值；全 0 时所有格子取最低档）
  const heatMax = useMemo(
    () => (summary?.byDay ?? []).reduce((m, d) => Math.max(m, d.totalTokens), 0),
    [summary],
  );

  /** 热力图色档：0 → 空档；>0 按最大值分位 4 档（与图例 HEAT_PANEL_COLORS 对应） */
  const heatLevel = (count: number | undefined): number => {
    if (count === undefined || count <= 0 || heatMax <= 0) return 0;
    const ratio = count / heatMax;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  };

  // 近 30 天合计（"本月"近似：byDay 为近 90 天倒序，取前 30 项）
  const monthTokens = useMemo(
    () => (summary?.byDay ?? []).slice(0, 30).reduce((sum, d) => sum + d.totalTokens, 0),
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
          {/* ① 时间维度四卡：今日 / 近 30 天（本月近似）/ 累计 / 总调用次数 */}
          <div className="grid grid-cols-4 gap-2 text-xs">
            <div className="rounded-md border border-border p-2.5">
              <p className="text-muted-foreground">{t('settings.usageToday')}</p>
              <p className="mt-0.5 font-medium text-foreground">
                {formatTokens(todayTokens)}{' '}
                <span className="text-muted-foreground font-normal">tokens</span>
              </p>
            </div>
            <div className="rounded-md border border-border p-2.5">
              <p className="text-muted-foreground">{t('settings.usageMonth')}</p>
              <p className="mt-0.5 font-medium text-foreground">
                {formatTokens(monthTokens)}{' '}
                <span className="text-muted-foreground font-normal">tokens</span>
              </p>
            </div>
            <div className="rounded-md border border-border p-2.5">
              <p className="text-muted-foreground">{t('settings.usageTotal')}</p>
              <p className="mt-0.5 font-medium text-foreground">
                {formatTokens(summary?.total.totalTokens ?? 0)}{' '}
                <span className="text-muted-foreground font-normal">tokens</span>
              </p>
            </div>
            <div className="rounded-md border border-border p-2.5">
              <p className="text-muted-foreground">{t('settings.usageCalls')}</p>
              <p className="mt-0.5 font-medium text-foreground">{summary?.total.calls ?? 0}</p>
            </div>
          </div>

          {/* ②③ 双列：消耗热力图（近 90 天，左） + 按模型占比（右） */}
          <div className="grid grid-cols-[1.4fr_1fr] gap-3">
            <div className="rounded-md border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">
                {t('settings.usageHeatmap')}
              </p>
              <div className="mt-2 heatmap-wrap">
                <CalendarHeatmap
                  values={heatValue}
                  startDate={heatStart}
                  endDate={heatEnd}
                  gutterSize={3}
                  classForValue={(value) =>
                    HEAT_SCALE_CLASS[heatLevel(value?.['count'] as number | undefined)] ??
                    'color-empty'
                  }
                  titleForValue={(value) =>
                    value === undefined
                      ? '无数据'
                      : `${String(value['date'])} · ${formatTokens(Number(value['count']))} tokens`
                  }
                />
              </div>
              <p className="text-muted-foreground mt-1.5 text-2xs">
                {t('settings.usageHeatmapHint')}
              </p>
            </div>

            <div className="rounded-md border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">
                {t('settings.usageByModel')}
              </p>
              <ul className="mt-2 space-y-2 text-xs">
                {modelRows.length === 0 ? (
                  <li className="text-muted-foreground/60">{t('settings.usageEmpty')}</li>
                ) : (
                  modelRows.map((m) => (
                    <li key={m.modelId}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-foreground">{m.modelId}</span>
                        <span className="text-muted-foreground shrink-0">
                          {formatTokens(m.tokens)} · {m.share.toFixed(0)}%
                        </span>
                      </div>
                      {/* 占比条（accent 宽度 = 占比） */}
                      <div className="bg-muted/30 mt-1 h-[5px] w-full overflow-hidden rounded-full">
                        <div
                          className="bg-accent h-full rounded-full"
                          style={{ width: `${Math.max(2, m.share)}%` }}
                        />
                      </div>
                    </li>
                  ))
                )}
              </ul>
            </div>
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
