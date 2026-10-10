import type { ReactElement } from 'react';

import { useTranslation } from '@/i18n/use-translation';

/** 流式响应尾部：assistant 尚未产出首条消息时的打字占位（三 accent 点弹跳） */
export function StreamingFooter(): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="msg assistant enter-anim">
      <div className="msg-avatar assistant" aria-hidden="true">
        C
      </div>
      <div className="msg-body">
        <div className="msg-role assistant">{t('chat.assistant')}</div>
        <div className="typing-indicator" role="status" aria-label={t('chat.assistantTyping')}>
          <span className="ti-dot" />
          <span className="ti-dot" />
          <span className="ti-dot" />
        </div>
      </div>
    </div>
  );
}
