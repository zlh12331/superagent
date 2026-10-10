import { CheckCircle2, ExternalLink, Info, PanelBottom, PanelRight, XCircle } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import type { DevToolsDockMode } from '@/lib/devtools-actions';
import { openDevTools } from '@/lib/devtools-actions';
import { unwrapErrorMessage } from '@/lib/ipc';
import { cn } from '@/lib/utils';

/** DevTools 停靠模式 */
type DevToolsMode = DevToolsDockMode;

/** 模式按钮配置（labelKey 为 dev.* 下的 i18n 键名） */
const MODE_BUTTONS: readonly {
  readonly mode: DevToolsMode;
  readonly labelKey: string;
  readonly icon: typeof ExternalLink;
}[] = [
  { mode: 'detach', labelKey: 'detachWindow', icon: ExternalLink },
  { mode: 'right', labelKey: 'panelRight', icon: PanelRight },
  { mode: 'bottom', labelKey: 'panelBottom', icon: PanelBottom },
];

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
  const { t } = useTranslation();
  const { getErrorMessage } = useErrorMessage();
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [loadingMode, setLoadingMode] = useState<DevToolsMode | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (statusTimerRef.current !== null) {
        clearTimeout(statusTimerRef.current);
      }
    },
    [],
  );

  /** 调用 IPC 打开 DevTools（仅 onClick 使用，引用稳定交给 Compiler） */
  const handleOpen = async (mode: DevToolsMode) => {
    setStatus('loading');
    setStatusMessage(t('dev.openingDevtools'));
    setLoadingMode(mode);

    try {
      const data = await openDevTools(mode);
      if (data.ok) {
        setStatus('success');
        setStatusMessage(t('dev.devtoolsOpened', { mode: data.mode }));
      } else {
        setStatus('error');
        setStatusMessage(t('dev.openFailedSender'));
      }
    } catch (err) {
      setStatus('error');
      const error = err instanceof Error ? err : new Error(String(err));
      setStatusMessage(unwrapErrorMessage(error, getErrorMessage));
    }
    setLoadingMode(null);
    if (statusTimerRef.current !== null) {
      clearTimeout(statusTimerRef.current);
    }
    statusTimerRef.current = setTimeout(() => {
      statusTimerRef.current = null;
      setStatus('idle');
      setStatusMessage('');
    }, STATUS_CLEAR_DELAY);
  };

  return (
    <div className={cn('flex h-full flex-col', className)}>
      <div className="border-border bg-muted/30 flex items-center gap-1.5 border-b px-2 py-1">
        <ExternalLink className="text-muted-foreground size-3" strokeWidth={1.5} />
        <span className="text-muted-foreground font-serif text-2xs tracking-wide">
          {t('dev.developerTools')}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <Section title={t('dev.chromiumDevtools')} description={t('dev.developerToolsDesc')}>
          <div className="flex items-center gap-0.5">
            {MODE_BUTTONS.map((btn) => {
              const Icon = btn.icon;
              const isLoading = loadingMode === btn.mode;
              return (
                <Button
                  key={btn.mode}
                  variant="outline"
                  size="sm"
                  className={cn(
                    'gap-1 rounded border px-2 py-1 text-2xs font-mono',
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
                </Button>
              );
            })}
          </div>
        </Section>

        <Section title={t('dev.reactDevtools')} description={t('common.reactTreeDesc')}>
          <div className="flex items-start gap-1.5">
            <Info className="text-muted-foreground mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
            <p className="text-muted-foreground text-2xs leading-relaxed">
              {t('dev.reactDevtoolsDesc')}
            </p>
          </div>
        </Section>

        {status !== 'idle' && (
          <div
            className={cn(
              'flex items-center gap-1.5 border-b px-2 py-1 text-2xs',
              status === 'success' && 'border-success/30 text-success-text',
              status === 'error' && 'border-error/30 text-error-text',
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
        <h3 className="text-foreground/90 font-serif text-xs tracking-wide">{title}</h3>
        <p className="text-muted-foreground mt-0.5 text-2xs leading-relaxed">{description}</p>
      </div>
      {children}
    </div>
  );
}
