// message-actions.tsx（自 ChatMessageList 拆分）
// 消息操作按钮组（复制/重试/折叠等）
// ──────────────────────────────
// 拆分背景：ChatMessageList 685 行，操作按钮提取为独立文件
// ──────────────────────────────

import { Copy, RefreshCw } from 'lucide-react';
import type { ReactElement } from 'react';
import { useCopy } from '@/hooks/use-copy';

import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

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
  // 剪贴板复制统一走 useCopy（含失败 toast 反馈，此前静默失败）
  const { copied, copy } = useCopy();
  // 本地化文案
  const { t } = useTranslation();

  const handleRegenerate = (): void => {
    if (disabled) return;
    onRegenerate?.(messageId);
  };

  return (
    <div className="msg-actions show">
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

// ──────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────

/**
 * 从 parts 中提取所有文本并拼接
 *
 * 用于 user / system 消息（只展示文本内容）。
 */
