import { AlertTriangle, X } from 'lucide-react';
import { type ReactElement, useEffect } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import {
  AUTO_HIDE_MS,
  isRateLimitExpired,
  useRateLimitStore,
} from '@/stores/transient/rate-limit-store';

/**
 * 限流提示横幅
 *
 * 渲染在消息列表顶部（ChatPanel 挂载）。默认隐藏。
 */
export function RateLimitBanner(): ReactElement | null {
  const { t } = useTranslation();
  const visible = useRateLimitStore((s) => s.visible);
  const triggeredAt = useRateLimitStore((s) => s.triggeredAt);
  const dismiss = useRateLimitStore((s) => s.dismiss);

  useEffect(() => {
    if (!visible) return;
    const remaining = triggeredAt + AUTO_HIDE_MS - Date.now();
    if (remaining <= 0) {
      dismiss();
      return;
    }
    const timer = setTimeout(dismiss, remaining);
    return () => clearTimeout(timer);
  }, [visible, triggeredAt, dismiss]);

  if (!visible || isRateLimitExpired(triggeredAt)) return null;

  return (
    <Alert className="border-amber/40 bg-amber/10 text-warn-text font-mono text-xs">
      <AlertTriangle className="text-warn-text" strokeWidth={2} />
      <AlertTitle className="font-mono text-xs flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{t('chat.rateLimited')}</span>
        <Button
          variant="ghost"
          size="icon"
          onClick={dismiss}
          aria-label={t('common.close')}
          title={t('common.close')}
          className="text-warn-text size-4 shrink-0 hover:bg-amber/15"
        >
          <X className="size-3" strokeWidth={2.5} />
        </Button>
      </AlertTitle>
    </Alert>
  );
}
