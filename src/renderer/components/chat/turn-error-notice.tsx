import { ERROR_META, type ErrorCode } from '@code-agent/shared/renderer';
import { Check, CircleAlert, Copy, RotateCcw, X } from 'lucide-react';
import type { ReactElement } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useCopy } from '@/hooks/use-copy';
import { useErrorMessage, useTranslation } from '@/i18n';
import { useTurnErrorStore } from '@/stores/transient/turn-error-store';

/** 提示卡 props */
interface TurnErrorNoticeProps {
  /** 所属会话（多会话并发时只显示本会话的错误） */
  readonly sessionId: string;
  /** 重试动作（ChatPanel 传 regenerate 包装；缺省不渲染重试按钮） */
  readonly onRetry?: () => void;
}

/**
 * 回合错误提示卡
 *
 * 渲染在消息列表上方（ChatPanel 挂载，与 RateLimitBanner 同区）；无错误时返回 null。
 */
export function TurnErrorNotice({ sessionId, onRetry }: TurnErrorNoticeProps): ReactElement | null {
  const { t } = useTranslation();
  const { getErrorMessage } = useErrorMessage();
  const { copy, copied } = useCopy();
  const entry = useTurnErrorStore((s) => s.errors[sessionId]);
  const clear = useTurnErrorStore((s) => s.clear);

  if (entry === undefined) return null;

  const registered = Object.hasOwn(ERROR_META, entry.code);
  const title = registered ? getErrorMessage(entry.code as ErrorCode) : t('chat.turnErrorTitle');
  const detail = entry.message.trim().length > 0 ? entry.message : t('chat.turnErrorNoDetail');
  const hint = entry.code.startsWith('AI_API_KEY')
    ? t('chat.turnErrorHintApiKey')
    : t('chat.turnErrorHint');

  const dismiss = (): void => {
    clear(sessionId);
  };

  const retry = (): void => {
    clear(sessionId);
    onRetry?.();
  };

  return (
    <Alert
      variant="destructive"
      className="border-error/30 bg-error-bg gap-y-1.5"
      data-testid="turn-error"
    >
      <CircleAlert strokeWidth={2} />
      <AlertTitle className="flex flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1">{title}</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={dismiss}
            aria-label={t('common.close')}
            title={t('common.close')}
            className="text-error-text size-4 shrink-0"
          >
            <X className="size-3" strokeWidth={2.5} />
          </Button>
        </span>
        <span className="text-xs font-normal break-all">{detail}</span>
        <span className="text-muted-foreground text-xs font-normal">{hint}</span>
        <span className="flex items-center gap-2 pt-0.5">
          {onRetry !== undefined && (
            <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={retry}>
              <RotateCcw className="size-3" strokeWidth={2.5} />
              {t('chat.turnErrorRetry')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() => void copy(`[${entry.code}] ${entry.message}`)}
            aria-label={t('chat.turnErrorCopyDetail')}
          >
            {copied ? (
              <Check className="size-3" strokeWidth={2.5} />
            ) : (
              <Copy className="size-3" strokeWidth={2.5} />
            )}
            {copied ? t('common.copied') : t('chat.turnErrorCopyDetail')}
          </Button>
        </span>
      </AlertTitle>
    </Alert>
  );
}
