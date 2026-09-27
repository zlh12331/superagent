// src/renderer/components/chat/chat-status-bar.tsx
// 聊天状态条（搜索入口 + 运行状态指示）——自 ChatPanel 提取
// ──────────────────────────────────────────────────────────────

import { Search } from 'lucide-react';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

/** ChatStatusBar props */
export interface ChatStatusBarProps {
  /** useChat 状态（驱动状态色与脉冲） */
  readonly status: 'submitted' | 'streaming' | 'ready' | 'error';
  /** 状态指示文本（statusLabel 产出） */
  readonly statusText: string;
  /** 打开会话内搜索 */
  readonly onOpenSearch: () => void;
}

/**
 * 顶部状态条：搜索入口 + 右侧状态指示（等宽遥测带）
 */
export function ChatStatusBar({
  status,
  statusText,
  onOpenSearch,
}: ChatStatusBarProps): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="thread-status-bar">
      <div className="ml-auto inline-flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground -mr-1 size-5"
          onClick={onOpenSearch}
          aria-label={t('chat.searchInConversation')}
          title={t('chat.searchInConversation')}
        >
          <Search className="size-3.5" strokeWidth={1.5} />
        </Button>
        <span
          className={cn(
            'inline-flex items-center gap-1.5',
            status === 'streaming' && 'text-accent-text',
            status === 'error' && 'text-error-text',
          )}
          role="status"
          aria-label={t('chat.sessionStatus', { status: statusText })}
        >
          <span
            className={cn(
              'inline-block size-1.5 rounded-full bg-current',
              status === 'streaming' && 'animate-pulse-soft',
            )}
          />
          {statusText}
        </span>
      </div>
    </div>
  );
}
