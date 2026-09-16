// src/renderer/components/dev/LogsPanel.tsx
// 日志查看器面板 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 职责：
// - 调用 useLogsReadQuery 获取 main.log 文件尾部 N 行日志
// - 支持级别过滤（全部 / info / warn / error / debug）
// - 支持行数选择（100 / 200 / 500）
// - 手动刷新按钮 + 自动展示截断提示
//
// 设计：
// - 纯只读面板，无写操作（日志由 electron-log 写入文件）
// - 日志行按级别着色（error 红 / warn 琥珀 / info 默认 / debug 灰）
// - 等宽字体展示日志文本，行级着色而非整行背景（降低视觉噪音）
// - 折叠态由 DevPanel 控制是否启用查询（enabled 参数）
// - 级别/行数用分段控件（ToggleGroup）而非下拉：与面板内其他分段控件同款，
//   窄面板下选项直接可见
// ──────────────────────────────────────────────────────────────

import type { ReadLogsRes } from '@code-agent/shared/renderer';
import { AlertCircle, FileText, RefreshCw } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useLogsReadQuery } from '@/hooks/use-system';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

/** 日志级别过滤选项 */
type LogLevelFilter = 'all' | 'info' | 'warn' | 'error' | 'debug';

/** 行数选项 */
const LINE_OPTIONS = [100, 200, 500] as const;
type LineOption = (typeof LINE_OPTIONS)[number];

/** 级别过滤顺序（'all' 走 i18n；级别术语 Info/Warn/Error/Debug 保持英文） */
const LEVEL_FILTERS: readonly LogLevelFilter[] = ['all', 'info', 'warn', 'error', 'debug'];

/** 级别术语显示名（'all' 走 i18n，故不在此表） */
const LEVEL_LABELS: Record<Exclude<LogLevelFilter, 'all'>, string> = {
  info: 'Info',
  warn: 'Warn',
  error: 'Error',
  debug: 'Debug',
};

interface LogsPanelProps {
  /** 是否启用查询（DevPanel 折叠时传 false 节省 IPC） */
  readonly enabled?: boolean;
  /** 自定义容器类名 */
  readonly className?: string;
}

/**
 * 日志查看器面板
 *
 * 从 main.log 文件尾部读取最近 N 行日志，支持级别过滤和行数选择。
 *
 * @example
 * ```tsx
 * <LogsPanel enabled={isDevPanelExpanded} />
 * ```
 */
export function LogsPanel({ enabled = true, className }: LogsPanelProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 本地状态：级别过滤 + 行数（用户可切换，切换后触发 refetch）
  const [level, setLevel] = useState<LogLevelFilter>('all');
  const [lines, setLines] = useState<LineOption>(200);

  // 仅在级别非 'all' 时传 level 参数（避免 IPC 传 undefined 导致歧义）
  const queryLevel = level !== 'all' ? level : undefined;
  const { data, isLoading, error, refetch, isFetching } = useLogsReadQuery(
    lines,
    queryLevel,
    enabled,
  );

  return (
    <div className={cn('flex h-full flex-col', className)}>
      {/* 顶部：工具栏（级别过滤 + 行数 + 刷新）；窄面板（240-480px）下换行而非横向溢出（实测 284px 时统计/刷新被挤出面板） */}
      <div className="border-border bg-muted/30 flex flex-wrap items-center gap-2 border-b px-2 py-1">
        {/* 级别过滤按钮组（单选） */}
        <ToggleGroup
          type="single"
          value={level}
          onValueChange={(v) => {
            if (v) setLevel(v as LogLevelFilter);
          }}
          className="gap-0.5"
        >
          {LEVEL_FILTERS.map((level) => (
            <ToggleGroupItem
              key={level}
              value={level}
              disabled={!enabled}
              className="rounded px-1.5 py-0.5 text-[9px] font-mono"
            >
              {level === 'all' ? t('dev.all') : LEVEL_LABELS[level]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <div className="bg-border mx-0.5 h-3 w-px" />

        {/* 行数选择按钮组（单选） */}
        <ToggleGroup
          type="single"
          value={String(lines)}
          onValueChange={(v) => {
            // 只接受真实档位：Radix 单选点击已选项会回传空串取消，
            // 而 `Number('')` 为 0（非 NaN）——此前仅判 NaN 会把行数置 0，
            // 查询随之变成「读 0 行」，面板空白。
            const next = LINE_OPTIONS.find((option) => String(option) === v);
            if (next !== undefined) {
              setLines(next);
            }
          }}
          className="gap-0.5"
        >
          {LINE_OPTIONS.map((option) => (
            <ToggleGroupItem
              key={option}
              value={String(option)}
              disabled={!enabled}
              className="rounded px-1.5 py-0.5 text-[9px] font-mono"
            >
              {option}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {/* 右侧：行数统计 + 刷新按钮 */}
        <div className="ml-auto flex items-center gap-1.5">
          {data !== undefined && (
            <span className="text-muted-foreground font-mono text-[9px]">
              {data.total}
              {data.truncated ? t('dev.truncated') : ''}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-5"
            onClick={() => {
              void refetch();
            }}
            disabled={isFetching || !enabled}
            aria-label={t('dev.refreshLogs')}
          >
            <RefreshCw className={cn('size-3', isFetching && 'animate-spin')} strokeWidth={1.5} />
          </Button>
        </div>
      </div>

      {/* 日志列表：普通滚动容器（Radix ScrollArea 内层 display:table 会随最长日志行撑宽
          到 391px，超出 283px 面板被裁剪且横向滚动条不可达——长行尾部永远看不到） */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <LogsBody isLoading={isLoading} error={error} data={data} />
      </div>
    </div>
  );
}

// ── 子组件：内容区四态 ──────────────────────────────────────

interface LogsBodyProps {
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly data: ReadLogsRes | undefined;
}

/**
 * 内容区四态分派（加载中 / 错误 / 无数据 / 空 / 有数据）
 *
 * 拆出动机：此前是四层嵌套三元表达式直接内联在主组件 JSX 里，
 * 使 LogsPanel 认知复杂度达 18（门禁阈值 15）。改用早返回后主组件回到阈值内，
 * 且四种态的分派一眼可读。
 */
function LogsBody({ isLoading, error, data }: LogsBodyProps): ReactElement {
  const { t } = useTranslation();
  if (isLoading) return <LogsSkeleton />;
  if (error !== null) {
    return <ErrorHint message={error instanceof Error ? error.message : String(error)} />;
  }
  if (data === undefined) {
    return <ErrorHint message={t('common.logsEmpty')} />;
  }
  if (data.lines.length === 0) {
    return <EmptyLogs filePath={data.filePath} />;
  }
  return <LogLines lines={data.lines} filePath={data.filePath} />;
}

// ── 子组件：日志行列表 ──────────────────────────────────────

interface LogLinesProps {
  readonly lines: readonly string[];
  readonly filePath: string;
}

/** 日志行列表：行级着色，等宽字体 */
function LogLines({ lines, filePath }: LogLinesProps): ReactElement {
  return (
    <div className="flex flex-col">
      {/* 文件路径提示（顶部细线） */}
      <div className="text-muted-foreground/60 border-border truncate border-b px-2 py-0.5 font-mono text-[9px]">
        <FileText className="mr-1 inline size-2.5" strokeWidth={1.5} />
        {filePath}
      </div>

      {/* 日志行：日志内容可能重复，使用 index 作为 key 一部分是合理的 */}
      <pre className="text-foreground/80 overflow-x-auto p-1 text-2xs leading-relaxed font-mono">
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 日志行内容可能重复，index 作为 key 一部分是必要的
          <LogLine key={`${index}-${line.slice(0, 20)}`} line={line} />
        ))}
      </pre>
    </div>
  );
}

/** 单行日志：按级别着色 */
function LogLine({ line }: { readonly line: string }): ReactElement {
  const colorClass = getColorForLogLevel(line);
  return <div className={cn('px-1', colorClass)}>{line || ' '}</div>;
}

/** 按日志级别获取颜色 class（通过行内 [level] 标记识别） */
function getColorForLogLevel(line: string): string {
  if (line.includes('[error]')) return 'text-error-text';
  if (line.includes('[warn]')) return 'text-warn-text';
  if (line.includes('[debug]')) return 'text-muted-foreground';
  if (line.includes('[info]')) return 'text-foreground/80';
  return 'text-muted-foreground';
}

// ── 子组件：加载中 / 空状态 / 错误状态 ─────────────────────────

/** 加载中骨架屏 */
function LogsSkeleton(): ReactElement {
  return (
    <div className="flex flex-col gap-0.5 p-2">
      {Array.from({ length: 8 }).map((_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架屏占位，index 稳定且无重排
        <Skeleton key={index} className="h-3 w-full" />
      ))}
    </div>
  );
}

/** 空日志提示 */
function EmptyLogs({ filePath }: { readonly filePath: string }): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-1 p-4 text-center">
      <FileText className="size-5 opacity-50" strokeWidth={1.5} />
      <p className="font-serif text-xs tracking-wide">{t('common.noLogs')}</p>
      <p className="text-2xs">{t('common.logsTruncatedDesc')}</p>
      <p className="text-muted-foreground/60 mt-1 truncate font-mono text-[9px]">{filePath}</p>
    </div>
  );
}

/** 错误状态提示 */
function ErrorHint({ message }: { readonly message: string }): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  return (
    <div className="text-error-text flex flex-col items-center gap-1 p-3 text-center">
      <AlertCircle className="size-4" strokeWidth={1.5} />
      <p className="font-serif text-xs">{t('common.logsLoadFailed')}</p>
      <p className="text-muted-foreground truncate text-2xs">{message}</p>
    </div>
  );
}
