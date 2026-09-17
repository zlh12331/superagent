// src/renderer/components/dev/MetricsPanel.tsx
// 运行时指标面板 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 职责：
// - 调用 useSystemStatusQuery 获取主进程运行时状态（内存/CPU/uptime/版本）
// - 以指标卡片网格展示，10s 自动刷新
// - enabled 由 DevPanel 按**当前可见 tab** 传入（仅 dev/metrics 子页启用查询，
//   切走即停，省下无谓 IPC）——不是「折叠态」控制
//
// 设计：
// - 纯只读面板，无交互逻辑
// - 内存/CPU/uptime 数值格式化为人类可读单位（字节 B/KB/MB/GB、微秒 ms/s、秒 h/m/s）
// - 指标卡片用 2 列网格（窄面板下紧凑排布；宽度受 --right-panel-w clamp 约束）
// - 等宽字体展示数值，衬线字体展示标签
// ──────────────────────────────────────────────────────────────

import type { SystemStatusRes } from '@code-agent/shared/renderer';
import { Activity, AlertCircle, Cpu, MemoryStick, RefreshCw, Timer } from 'lucide-react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useSystemStatusQuery } from '@/hooks/use-system';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import { formatClockTime } from '@/lib/format-intl';
import { unwrapErrorMessage } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { formatBytes, formatMs, formatUptime } from './metrics-format';

interface MetricsPanelProps {
  /** 是否启用查询（DevPanel 在当前 tab 非 metrics 时传 false 节省 IPC） */
  readonly enabled?: boolean;
  /** 自定义容器类名 */
  readonly className?: string;
}

/**
 * 运行时指标面板
 *
 * 展示主进程内存/CPU/uptime/版本信息，10s 自动刷新。
 *
 * @example
 * ```tsx
 * <MetricsPanel enabled={activeTab === 'dev' && devSubTab === 'metrics'} />
 * ```
 */
export function MetricsPanel({ enabled = true, className }: MetricsPanelProps): ReactElement {
  // 本地化文案
  const { t, i18n } = useTranslation();
  const { data, isLoading, error, refetch, isFetching } = useSystemStatusQuery(enabled);

  return (
    <div className={cn('flex h-full flex-col', className)}>
      {/* 顶部：标题 + 刷新按钮 */}
      <div className="border-border bg-muted/30 flex items-center justify-between border-b px-2 py-1">
        <div className="text-muted-foreground flex items-center gap-1.5 text-2xs">
          <Activity className="size-3" strokeWidth={1.5} />
          <span className="font-serif tracking-wide">{t('dev.runtimeMetrics')}</span>
          {data !== undefined && (
            <span className="text-muted-foreground/70 font-mono">
              · {formatClockTime(data.timestamp, i18n.language)}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-5"
          onClick={() => {
            void refetch();
          }}
          disabled={isFetching || !enabled}
          aria-label={t('dev.refreshMetrics')}
        >
          <RefreshCw className={cn('size-3', isFetching && 'animate-spin')} strokeWidth={1.5} />
        </Button>
      </div>

      {/* 指标卡片网格 */}
      <ScrollArea className="min-h-0 flex-1">
        <MetricsBody isLoading={isLoading} error={error} status={data} />
      </ScrollArea>
    </div>
  );
}

// ── 子组件：四态分派 ──────────────────────────────────────────

interface MetricsBodyProps {
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly status: SystemStatusRes | undefined;
}

/**
 * 指标体四态分派（早返回替代嵌套三元）
 *
 * 此前是 `isLoading ? … : error ? … : data === undefined ? … : …` 的三层嵌套三元
 * ——LogsPanel 已为此抽出早返回的 LogsBody（其注释明示嵌套三元使复杂度达 18），
 * 本面板保留同型结构未同步，此处对齐。
 */
function MetricsBody({ isLoading, error, status }: MetricsBodyProps): ReactElement {
  const { t } = useTranslation();
  // 错误文案统一经 unwrapErrorMessage 解析错误码（与其余面板一致）：
  // 此前直接显示 error.message，IPC 错误会露出英文码
  const { getErrorMessage } = useErrorMessage();
  if (isLoading) return <MetricsSkeleton />;
  if (error !== null && error !== undefined) {
    return <ErrorHint message={unwrapErrorMessage(error as Error, getErrorMessage)} />;
  }
  if (status === undefined) return <ErrorHint message={t('dev.metricsEmpty')} />;
  return <MetricsGrid status={status} />;
}

// ── 子组件：指标卡片网格 ──────────────────────────────────────

interface MetricsGridProps {
  readonly status: SystemStatusRes;
}

/** 指标卡片网格：2 列布局，紧凑展示 */
function MetricsGrid({ status }: MetricsGridProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-1.5 p-2">
      {/* 内存指标 */}
      <MetricCard
        icon={MemoryStick}
        label={t('dev.rssMemory')}
        value={formatBytes(status.memory.rss)}
        hint={t('dev.residentMemory')}
      />
      <MetricCard
        icon={MemoryStick}
        label={t('dev.heapUsed')}
        value={formatBytes(status.memory.heapUsed)}
        hint={t('dev.heapTotalHint', { value: formatBytes(status.memory.heapTotal) })}
      />
      <MetricCard
        icon={MemoryStick}
        label={t('dev.externalMemory')}
        value={formatBytes(status.memory.external)}
        hint={`ArrayBuffer ${formatBytes(status.memory.arrayBuffers)}`}
      />

      {/* CPU 指标 */}
      <MetricCard
        icon={Cpu}
        label={t('dev.cpuUser')}
        value={formatMs(status.cpu.user)}
        hint={t('dev.cpuSystemHint', { value: formatMs(status.cpu.system) })}
      />

      {/* 运行时长 */}
      <MetricCard
        icon={Timer}
        label={t('dev.uptime')}
        value={formatUptime(status.uptimeSeconds)}
        hint={`PID ${status.pid}`}
      />

      {/* 版本信息 */}
      <VersionCard status={status} />
    </div>
  );
}

// ── 子组件：单个指标卡片 ──────────────────────────────────────

interface MetricCardProps {
  readonly icon: typeof Cpu;
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}

/** 单个指标卡片：图标 + 标签 + 数值 + 提示 */
function MetricCard({ icon: Icon, label, value, hint }: MetricCardProps): ReactElement {
  return (
    <div className="border-border bg-muted/20 flex flex-col gap-0.5 rounded border px-2 py-1.5">
      <div className="text-muted-foreground flex items-center gap-1 text-[9px]">
        <Icon className="size-2.5 shrink-0" strokeWidth={1.5} />
        <span className="font-serif tracking-wide">{label}</span>
      </div>
      <div className="text-foreground font-mono text-xs leading-tight">{value}</div>
      {hint !== undefined && (
        <div className="text-muted-foreground/70 font-mono text-[9px]">{hint}</div>
      )}
    </div>
  );
}

// ── 子组件：版本信息卡片（跨 2 列） ──────────────────────────

interface VersionCardProps {
  readonly status: SystemStatusRes;
}

/** 版本信息卡片：app/electron/node + platform/arch + isPackaged */
function VersionCard({ status }: VersionCardProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  return (
    <div className="border-border bg-muted/20 col-span-2 flex flex-col gap-0.5 rounded border px-2 py-1.5">
      <div className="text-muted-foreground flex items-center gap-1 text-[9px]">
        <Activity className="size-2.5 shrink-0" strokeWidth={1.5} />
        <span className="font-serif tracking-wide">{t('dev.envInfo')}</span>
      </div>
      <div className="text-foreground/80 font-mono text-[9px] leading-relaxed">
        <div>
          app <span className="text-foreground">{status.appVersion}</span>
          {' · '}
          electron <span className="text-foreground">{status.electronVersion}</span>
          {' · '}
          node <span className="text-foreground">{status.nodeVersion}</span>
        </div>
        <div className="text-muted-foreground">
          {status.platform} / {status.arch}
          {status.isPackaged ? ` · ${t('dev.packaged')}` : ` · ${t('dev.devBuild')}`}
        </div>
      </div>
    </div>
  );
}

// ── 子组件：加载中 / 错误状态 ─────────────────────────────────

/** 加载中骨架屏 */
function MetricsSkeleton(): ReactElement {
  return (
    <div className="grid grid-cols-2 gap-1.5 p-2">
      {Array.from({ length: 6 }).map((_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架屏占位，index 稳定且无重排
        <div key={index} className="flex flex-col gap-1 px-2 py-1.5">
          <Skeleton className="h-2 w-1/2" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}

/** 错误状态提示 */
function ErrorHint({ message }: { readonly message: string }): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  return (
    <div className="text-error-text flex flex-col items-center gap-1 p-3 text-center">
      <AlertCircle className="size-4" strokeWidth={1.5} aria-hidden="true" />
      <p className="font-serif text-xs">{t('dev.metricsFailed')}</p>
      <p className="text-muted-foreground truncate text-2xs">{message}</p>
    </div>
  );
}
