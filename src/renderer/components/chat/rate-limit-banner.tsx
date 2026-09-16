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

  // 自动隐藏：到「触发时刻 + 5 分钟」那一刻把横幅收掉。
  //
  // 修复（2026-09 审计）：此前只挂**一个固定 60s 的一次性定时器**——60s 到点时
  // 才过去 60s（< 5min）故不 dismiss，且依赖 [visible, triggeredAt] 未变、组件
  // 也不重渲染 → 之后再无任何定时器，横幅**永久残留**（除非用户手点 ×）。
  // 既有测试用 vi.setSystemTime 把系统时间直接推到 6 分钟后，恰好掩盖了该缺陷。
  //
  // 现按**剩余时间**直接调度到过期时刻（无需轮询）：到点 dismiss → store 更新
  // → 重渲染 → 返回 null。重复限流会刷新 triggeredAt，effect 依赖变化即重排。
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
      {/* 单行形态（用户要求）：标题与关闭按钮同行，× 在行尾 */}
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
