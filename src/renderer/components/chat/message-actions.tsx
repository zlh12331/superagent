import { Copy, RefreshCw } from 'lucide-react';
import type { ReactElement } from 'react';
import { useCopy } from '@/hooks/use-copy';

import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

/** 消息操作行：复制全文（useCopy）/ 重新生成（流式中禁用） */
export function MsgActions({
  text,
  messageId,
  onRegenerate,
  disabled,
}: {
  text: string;
  messageId: string;
  onRegenerate: ((messageId: string) => void) | undefined;
  disabled: boolean;
}): ReactElement {
  const { copied, copy } = useCopy();
  const { t } = useTranslation();

  const handleRegenerate = (): void => {
    if (disabled) return;
    onRegenerate?.(messageId);
  };

  return (
    <div className="msg-actions">
      <button
        type="button"
        className={cn('msg-action-btn', copied && 'copied')}
        onClick={() => void copy(text)}
        aria-label={copied ? t('chat.copied') : t('chat.copy')}
        title={copied ? t('chat.copied') : t('chat.copy')}
      >
        <Copy />
        {copied ? t('chat.copied') : t('chat.copy')}
      </button>
      <button
        type="button"
        className="msg-action-btn"
        aria-label={t('chat.regenerate')}
        title={disabled ? t('chat.generating') : t('chat.regenerate')}
        onClick={handleRegenerate}
        disabled={disabled}
      >
        <RefreshCw />
        {t('chat.regenerate')}
      </button>
    </div>
  );
}
