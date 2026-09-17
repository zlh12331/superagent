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
    // 类名收敛为 .msg-actions（2026-09 审计）：此前写作 `msg-actions show`，
    // globals.css 中并无 `.show` 复合规则（.show 只存在于 folder-dropdown-menu
    // / palette-overlay），属原型残留的死类名。
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
        // aria-label 恒为「重新生成」以匹配可见文案（WCAG 2.5.3 Label in Name：
        // 可访问名须包含可见标签文本，语音控制喊「重新生成」才命中）；禁用原因
        // 由 title 承载（提示气泡，不参与可访问名计算）
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
