// src/renderer/components/chat/rate-limit-banner.tsx
// 限流提示横幅（对齐参考项目 superagent RateLimitBanner）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 订阅 rate-limit-store：回合失败（429 限流）时显示提示
// - 对齐原型 .tsb-rate pill 形态：warn 色 + 图标 + 文案 + 关闭按钮
// - 自动隐藏：触发 5 分钟后自动消失（isRateLimitExpired）
// - 手动关闭：× 按钮
// ──────────────────────────────────────────────────────────────

import { AlertTriangle, X } from 'lucide-react';
import { type ReactElement, useEffect } from 'react';
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
    <div className="flex justify-end border-b bg-gradient-to-b from-muted/60 to-background px-6 py-[7px] font-mono text-[11px] text-muted-foreground">
      <div className="inline-flex shrink-0 items-center gap-1.5 rounded-[10px] border bg-card px-[9px] py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
        <AlertTriangle className="size-3.5 shrink-0" strokeWidth={2} />
        <span>{t('chat.rateLimited')}</span>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('common.close')}
          title={t('common.close')}
          className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent text-amber-600 transition-colors hover:bg-amber-500/15 dark:text-amber-400"
        >
          <X className="size-3" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
