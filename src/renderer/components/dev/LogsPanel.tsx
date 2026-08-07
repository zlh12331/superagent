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
// - 使用小按钮组而非 Select 组件（项目未引入 shadcn Select，避免新增依赖）
// ──────────────────────────────────────────────────────────────

import { AlertCircle, FileText, RefreshCw } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useLogsReadQuery } from '@/hooks/use-system';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

/** 日志级别过滤选项 */
type LogLevelFilter = 'all' | 'info' | 'warn' | 'error' | 'debug';

/** 行数选项 */
const LINE_OPTIONS = [100, 200, 500] as const;
type LineOption = (typeof LINE_OPTIONS)[number];

/** 级别过滤按钮配置（'all' 走 i18n，级别术语 Info/Warn/Error/Debug 保持英文） */
const LEVEL_FILTERS: readonly {
  readonly value: LogLevelFilter;
  readonly labelKey: string | null;
  readonly label: string;
}[] = [
  { value: 'all', labelKey: 'dev.all', label: '' },
  { value: 'info', labelKey: null, label: 'Info' },
  { value: 'warn', labelKey: null, label: 'Warn' },
  { value: 'error', labelKey: null, label: 'Error' },
  { value: 'debug', labelKey: null, label: 'Debug' },
] as const;

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
      {/* 顶部：工具栏（级别过滤 + 行数 + 刷新） */}
      <div className="border-border bg-muted/30 flex items-center gap-2 border-b px-2 py-1">
        {/* 级别过滤按钮组 */}
        <div className="flex items-center gap-0.5">
          {LEVEL_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={cn(
                'rounded px-1.5 py-0.5 text-[9px] font-mono transition-colors',
                level === filter.value
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
              onClick={() => {
                setLevel(filter.value);
              }}
              disabled={!enabled}
            >
              {filter.labelKey !== null ? t(filter.labelKey) : filter.label}
            </button>
          ))}
        </div>

        <div className="bg-border mx-0.5 h-3 w-px" />

        {/* 行数选择按钮组 */}
        <div className="flex items-center gap-0.5">
          {LINE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className={cn(
                'rounded px-1.5 py-0.5 text-[9px] font-mono transition-colors',
                lines === option
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
              onClick={() => {
                setLines(option);
              }}
              disabled={!enabled}
            >
              {option}
            </button>
          ))}
        </div>

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
            className="text-muted-foreground hover:text-foreground h-5 w-5"
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

      {/* 日志列表 */}
      <ScrollArea className="min-h-0 flex-1">
        {isLoading ? (
          <LogsSkeleton />
        ) : error !== null ? (
          <ErrorHint message={error instanceof Error ? error.message : String(error)} />
        ) : data === undefined ? (
          <ErrorHint message={t('common.logsEmpty')} />
        ) : data.lines.length === 0 ? (
          <EmptyLogs filePath={data.filePath} />
        ) : (
          <LogLines lines={data.lines} filePath={data.filePath} />
        )}
      </ScrollArea>
    </div>
  );
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
  if (line.includes('[error]')) return 'text-red-600 dark:text-red-400';
  if (line.includes('[warn]')) return 'text-amber-600 dark:text-amber-400';
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
    <div className="text-destructive flex flex-col items-center gap-1 p-3 text-center">
      <AlertCircle className="size-4" strokeWidth={1.5} />
      <p className="font-serif text-xs">{t('common.logsLoadFailed')}</p>
      <p className="text-muted-foreground truncate text-2xs">{message}</p>
    </div>
  );
}
