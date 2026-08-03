// src/renderer/components/dev/InspectorPanel.tsx
// 开发者工具检查器面板 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 职责：
// - 提供按钮一键唤起 Chromium DevTools（通过 IPC 调用 webContents.openDevTools）
// - 支持三种停靠模式：detach（独立窗口）/ right（右侧）/ bottom（底部）
// - 展示 React DevTools 扩展安装说明（dev 模式自动注入）
// - 调用结果反馈（成功/失败 toast 文本）
//
// 设计：
// - 纯交互面板，无数据查询（不使用 TanStack Query）
// - 按钮组风格与 LogsPanel 级别过滤按钮一致（小号等宽字体）
// - 成功/失败状态通过本地 useState 管理，3s 后自动清除
// ──────────────────────────────────────────────────────────────

import type { OpenDevToolsRes } from '@code-agent/shared/renderer';
import { CheckCircle2, ExternalLink, Info, PanelBottom, PanelRight, XCircle } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

/** DevTools 停靠模式 */
type DevToolsMode = 'detach' | 'right' | 'bottom';

/** 模式按钮配置 */
const MODE_BUTTONS: readonly {
  readonly mode: DevToolsMode;
  readonly labelKey: string;
  readonly icon: typeof ExternalLink;
  readonly hint: string;
}[] = [
  { mode: 'detach', labelKey: 'detachWindow', icon: ExternalLink, hint: 'detach' },
  { mode: 'right', labelKey: 'panelRight', icon: PanelRight, hint: 'right' },
  { mode: 'bottom', labelKey: 'panelBottom', icon: PanelBottom, hint: 'bottom' },
] as const;

/** 成功消息自动清除延迟 */
const STATUS_CLEAR_DELAY = 3_000;

interface InspectorPanelProps {
  /** 自定义容器类名 */
  readonly className?: string;
}

/**
 * 开发者工具检查器面板
 *
 * 提供按钮一键唤起 Chromium DevTools，支持三种停靠模式。
 * React DevTools 扩展在 dev 模式下由主进程自动安装。
 *
 * @example
 * ```tsx
 * <InspectorPanel className="h-full" />
 * ```
 */
export function InspectorPanel({ className }: InspectorPanelProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 调用状态：idle / loading / success / error
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  // 当前正在加载的模式（用于按钮禁用）
  const [loadingMode, setLoadingMode] = useState<DevToolsMode | null>(null);
  // 状态自动清除定时器：组件卸载时清理，避免 setState on unmounted component 内存泄漏
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (statusTimerRef.current !== null) {
        clearTimeout(statusTimerRef.current);
      }
    },
    [],
  );

  /** 调用 IPC 打开 DevTools */
  const handleOpen = useCallback(
    async (mode: DevToolsMode) => {
      setStatus('loading');
      setStatusMessage(t('dev.openingDevtools'));
      setLoadingMode(mode);

      try {
        const response = await window.api.devtools.open({ mode });

        if ('error' in response && response.error !== undefined) {
          setStatus('error');
          setStatusMessage(`[${response.error.code}] ${response.error.message}`);
        } else if ('data' in response && response.data !== undefined) {
          const data = response.data as OpenDevToolsRes;
          if (data.ok) {
            setStatus('success');
            setStatusMessage(t('dev.devtoolsOpened', { mode: data.mode }));
          } else {
            setStatus('error');
            setStatusMessage(t('dev.openFailedSender'));
          }
        } else {
          setStatus('error');
          setStatusMessage(t('dev.unknownResponse'));
        }
      } catch (err) {
        setStatus('error');
        setStatusMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingMode(null);
        // 3s 后自动清除状态
        if (statusTimerRef.current !== null) {
          clearTimeout(statusTimerRef.current);
        }
        statusTimerRef.current = setTimeout(() => {
          statusTimerRef.current = null;
          setStatus('idle');
          setStatusMessage('');
        }, STATUS_CLEAR_DELAY);
      }
    },
    [t],
  );

  return (
    <div className={cn('flex h-full flex-col', className)}>
      {/* 顶部：标题栏 */}
      <div className="border-border bg-muted/30 flex items-center gap-1.5 border-b px-2 py-1">
        <ExternalLink className="text-muted-foreground size-3" strokeWidth={1.5} />
        <span className="text-muted-foreground font-serif text-[10px] tracking-wide">
          {t('dev.developerTools')}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {/* Chromium DevTools 按钮组 */}
        <Section title="Chromium DevTools" description={t('dev.developerToolsDesc')}>
          <div className="flex items-center gap-0.5">
            {MODE_BUTTONS.map((btn) => {
              const Icon = btn.icon;
              const isLoading = loadingMode === btn.mode;
              return (
                <button
                  key={btn.mode}
                  type="button"
                  className={cn(
                    'flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-mono transition-colors',
                    'border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    isLoading && 'opacity-50',
                  )}
                  onClick={() => {
                    void handleOpen(btn.mode);
                  }}
                  disabled={status === 'loading'}
                  aria-label={t('dev.openDevtoolsMode', { mode: t(`dev.${btn.labelKey}`) })}
                >
                  <Icon className="size-2.5" strokeWidth={1.5} />
                  {t(`dev.${btn.labelKey}`)}
                </button>
              );
            })}
          </div>
        </Section>

        {/* React DevTools 说明 */}
        <Section title="React DevTools" description={t('common.reactTreeDesc')}>
          <div className="flex items-start gap-1.5">
            <Info className="text-muted-foreground mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
            <p className="text-muted-foreground text-[10px] leading-relaxed">
              dev 模式启动时由主进程自动安装（electron-devtools-installer）。 打开 Chromium DevTools
              后切换到「Components」/「Profiler」Tab 使用。 首次安装可能需要刷新页面才能生效。
            </p>
          </div>
        </Section>

        {/* 状态反馈 */}
        {status !== 'idle' && (
          <div
            className={cn(
              'flex items-center gap-1.5 border-b px-2 py-1 text-[10px]',
              status === 'success' && 'border-green-500/30 text-green-600 dark:text-green-400',
              status === 'error' && 'border-red-500/30 text-red-600 dark:text-red-400',
              status === 'loading' && 'border-border text-muted-foreground',
            )}
          >
            {status === 'success' && <CheckCircle2 className="size-3" strokeWidth={1.5} />}
            {status === 'error' && <XCircle className="size-3" strokeWidth={1.5} />}
            {status === 'loading' && (
              <span className="size-2 animate-pulse rounded-full bg-current" />
            )}
            <span className="font-mono">{statusMessage}</span>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// ── 子组件：分区容器 ──────────────────────────────────────

interface SectionProps {
  readonly title: string;
  readonly description: string;
  readonly children: ReactElement;
}

/** 分区容器：标题 + 描述 + 内容 */
function Section({ title, description, children }: SectionProps): ReactElement {
  return (
    <div className="border-border flex flex-col gap-1.5 border-b px-2 py-2">
      <div>
        <h3 className="text-foreground/90 font-serif text-[11px] tracking-wide">{title}</h3>
        <p className="text-muted-foreground/70 mt-0.5 text-[9px] leading-relaxed">{description}</p>
      </div>
      {children}
    </div>
  );
}
