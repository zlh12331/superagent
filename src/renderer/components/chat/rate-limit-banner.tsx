// src/renderer/components/chat/rate-limit-banner.tsx
// 限流提示横幅（对齐参考项目 superagent RateLimitBanner）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 订阅 rate-limit-store：回合失败（429 限流）时显示提示
// - shadcn Alert 形态（用户要求：pill → Alert 横幅）：warn 色 + 图标 + 标题 + 关闭按钮
// - 自动隐藏：触发 5 分钟后自动消失（isRateLimitExpired）
// - 手动关闭：× 按钮
// ──────────────────────────────────────────────────────────────

import { AlertTriangle, X } from 'lucide-react';
import { type ReactElement, useEffect } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useTranslation } from '@/i18n/use-translation';
import { isRateLimitExpired, useRateLimitStore } from '@/stores/transient/rate-limit-store';

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

  // 自动隐藏：触发超过 5 分钟后消失（定时器兜底，避免 store 残留）
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      if (isRateLimitExpired(useRateLimitStore.getState().triggeredAt)) {
        useRateLimitStore.getState().dismiss();
      }
    }, 60_000);
    return () => clearTimeout(timer);
  }, [visible]);

  if (!visible || isRateLimitExpired(triggeredAt)) return null;

  return (
    <Alert className="border-[var(--amber)]/40 bg-[var(--amber)]/10 text-[var(--warn)] font-mono text-xs">
      <AlertTriangle className="text-[var(--warn)]" strokeWidth={2} />
      <AlertTitle className="font-mono text-xs">{t('chat.rateLimited')}</AlertTitle>
      <AlertDescription className="font-mono text-xs">
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('common.close')}
          title={t('common.close')}
          className="text-[var(--warn)] flex size-4 cursor-pointer items-center justify-center rounded border-none bg-transparent transition-colors hover:bg-[var(--amber)]/15"
        >
          <X className="size-3" strokeWidth={2.5} />
        </button>
      </AlertDescription>
    </Alert>
  );
}
