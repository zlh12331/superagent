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

import type { UsageDaySummary, UsageSummaryRes } from '@code-agent/shared/renderer';
import { useQuery } from '@tanstack/react-query';
import { BarChart3 } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';
import { ActivityCalendar } from 'react-activity-calendar';
import 'react-activity-calendar/tooltips.css';

import { QueryErrorRow, QueryPendingRow } from '@/components/common/AsyncSection';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { formatCompactNumber } from '@/lib/format-intl';
import { unwrap } from '@/lib/ipc';
import { USAGE_SUMMARY_QUERY_KEY } from '@/lib/query/keys';
import { TurnsSection } from './turns-section';

/** 生成近 N 天日期列表（倒序，today 在前；与 byDay 数据格式一致） */
export function recentDays(count: number): string[] {
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

/** Date → yyyy-MM-dd（与 byDay 数据格式一致） */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 热力图条目（react-activity-calendar data 项） */
export interface HeatValueItem {
  readonly date: string;
  readonly count: number;
  readonly level: number;
}

/** 热力图色档：0 → 空档；>0 按最大值分位 4 档（与图例 HEAT_THEME 对应） */
function heatLevel(count: number | undefined, heatMax: number): number {
  if (count === undefined || count <= 0 || heatMax <= 0) return 0;
  const ratio = count / heatMax;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/**
 * 构建热力图数据（纯派生，无 React 依赖——便于单测）
 *
 * @param byDay 按日用量（近 90 天倒序）
 * @param heatStartIso 热力图起始日期（ISO，用于首尾空条目锚点）
 * @param heatEndIso 热力图结束日期（ISO）
 */
export function buildHeatValue(
  byDay: readonly UsageDaySummary[] | undefined,
  heatStartIso: string,
  heatEndIso: string,
): HeatValueItem[] {
  const days = byDay ?? [];
  // 空数据兑底：近 90 天 0 值（ActivityCalendar 不允许 data 为空，否则抛错）
  if (days.length === 0) {
    return recentDays(90).map((date) => ({ date, count: 0, level: 0 }));
  }
  // 当日最大值（全 0 时所有格子取最低档）
  const heatMax = days.reduce((m, d) => Math.max(m, d.totalTokens), 0);
  const first = days[days.length - 1];
  const last = days[0];
  const items: HeatValueItem[] = [...days]
    .reverse()
    .map((d) => ({ date: d.date, count: d.totalTokens, level: heatLevel(d.totalTokens, heatMax) }));
  // 首尾空条目（范围锚点）：仅当数据未覆盖边界时补
  if (first !== undefined && items[0]?.date !== heatStartIso) {
    items.unshift({ date: heatStartIso, count: 0, level: 0 });
  }
  if (last !== undefined && items[items.length - 1]?.date !== heatEndIso) {
    items.push({ date: heatEndIso, count: 0, level: 0 });
  }
  return items;
}

/** 热力图色档（react-activity-calendar theme：0 = 空，1-4 = accent 透明度递进，CSS 变量主题自适应） */
const HEAT_THEME = [
  'var(--muted)',
  'color-mix(in srgb, var(--accent) 25%, transparent)',
  'color-mix(in srgb, var(--accent) 50%, transparent)',
  'color-mix(in srgb, var(--accent) 75%, transparent)',
  'var(--accent)',
];

export function UsageSection(): ReactElement {
  const { t, i18n } = useTranslation();

  // 用量汇总：TanStack Query（L3 服务端数据；浏览器模式守卫返回空骨架）
  // 失败态以 QueryErrorRow 呈现（此前静默渲染成全零骨架，误导用户）
  const {
    data: summary,
    isPending,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: USAGE_SUMMARY_QUERY_KEY,
    queryFn: async (): Promise<UsageSummaryRes> => {
      // 浏览器模式（dev 预览）无 window.api：渲染空数据 UI 骨架
      // （0 值三卡 + 近 90 天 0 值热力图格子，形态完整可见）
      if (typeof window === 'undefined' || window.api === undefined) {
        return {
          total: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          byModel: [],
          byDay: recentDays(90).map((date) => ({ date, calls: 0, totalTokens: 0 })),
        };
      }
      return unwrap<UsageSummaryRes>(await window.api.session.getUsageSummary());
    },
  });

  const heatEnd = useMemo(() => new Date(), []);
  const heatStart = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 89);
    return d;
  }, []);
  /** 日期锚点（ISO，用于首尾空条目） */
  const heatStartIso = useMemo(() => toIsoDate(heatStart), [heatStart]);
  const heatEndIso = useMemo(() => toIsoDate(heatEnd), [heatEnd]);

  /** 热力图数据（色档按当日最大值分位；纯派生，抽 buildHeatValue 便于测试）
   * 不手写 heatMax/heatLevel——buildHeatValue 内部计算，编译器和 biome 依赖推导完整 */
  const heatValue = useMemo(
    () => buildHeatValue(summary?.byDay, heatStartIso, heatEndIso),
    [summary, heatStartIso, heatEndIso],
  );

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
    <div className="flex flex-col gap-2 pt-2">
      <div className="flex items-center gap-2">
        <BarChart3 className="size-4 text-muted-foreground" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">{t('settings.usageSection')}</Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.usageHint')}</p>

      <QueryErrorRow
        isError={isError}
        errorMessage={error instanceof Error ? error.message : null}
        onRetry={() => void refetch()}
      />
      <QueryPendingRow isPending={isPending} />

      {isEmpty ? (
        <p className="text-xs text-muted-foreground font-sans">{t('settings.usageEmpty')}</p>
      ) : (
        <div className="flex flex-col gap-4 font-sans">
          {/* ① 时间维度四卡：今日 / 近 30 天（本月近似）/ 累计 / 总调用次数 */}
          <div className="grid grid-cols-4 gap-2 text-xs">
            <div className="rounded-md border border-border p-2.5">
              <p className="text-muted-foreground">{t('settings.usageToday')}</p>
              <p className="mt-0.5 font-medium text-foreground">
                {formatCompactNumber(todayTokens, i18n.language)}{' '}
                <span className="text-muted-foreground font-normal">tokens</span>
              </p>
            </div>
            <div className="rounded-md border border-border p-2.5">
              <p className="text-muted-foreground">{t('settings.usageMonth')}</p>
              <p className="mt-0.5 font-medium text-foreground">
                {formatCompactNumber(monthTokens, i18n.language)}{' '}
                <span className="text-muted-foreground font-normal">tokens</span>
              </p>
            </div>
            <div className="rounded-md border border-border p-2.5">
              <p className="text-muted-foreground">{t('settings.usageTotal')}</p>
              <p className="mt-0.5 font-medium text-foreground">
                {formatCompactNumber(summary?.total.totalTokens ?? 0, i18n.language)}{' '}
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
                <ActivityCalendar
                  data={heatValue}
                  theme={{ light: HEAT_THEME }}
                  blockSize={14}
                  blockMargin={3}
                  blockRadius={3}
                  fontSize={9}
                  labels={{ totalCount: '{{count}} tokens' }}
                  tooltips={{
                    activity: {
                      text: (activity) =>
                        `${activity.date} · ${formatCompactNumber(activity.count, i18n.language)} tokens`,
                    },
                  }}
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
              <ul className="mt-2 flex flex-col gap-2 text-xs">
                {modelRows.length === 0 ? (
                  <li className="text-muted-foreground/60">{t('settings.usageEmpty')}</li>
                ) : (
                  modelRows.map((m) => (
                    <li key={m.modelId}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-foreground">{m.modelId}</span>
                        <span className="text-muted-foreground shrink-0">
                          {formatCompactNumber(m.tokens, i18n.language)} · {m.share.toFixed(0)}%
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
