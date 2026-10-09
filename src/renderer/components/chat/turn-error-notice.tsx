// src/renderer/components/chat/turn-error-notice.tsx
// 回合错误提示卡（对话区内联常驻——替代瞬时 toast）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 订阅 turn-error-store：本会话回合失败时在消息列表上方显示具体错误
// - 内容三层：错误标题（错误码本地化，来自 errors.json）＋ 原文详情（可能含
//   远端服务返回的具体原因）＋ 处置提示（按错误族给不同指引）
// - 动作：重试（regenerate——截断失败回合并重发）、复制详情、关闭
// - 常驻不自动消失（用户要求：错误留在对话区可回看）；下一回合开始自动清除
//
// 设计取舍（2026-10-09 用户报障驱动）：
// - 此前回合错误只经 useChat 的 error → toast 呈现，且文案在 SDK 脱敏后变成
//   泛化的 'An error occurred.'，用户既看不到具体原因、也来不及看清就消失
// - 本卡以主进程 stream-error 载荷（AppError 分类后的 code + 消息原文）为源，
//   不做转述美化（消息原文逐字展示，含远端网关返回的拒绝原因）
// 先例：rate-limit-banner.tsx（transient store + shadcn Alert 横幅形态）
// ──────────────────────────────────────────────────────────────

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

  // 标题：错误码本地化（已注册码 → errors.json 文案）；未注册码 → 通用标题
  // （成员判定用 ERROR_META 而非字符串比较：getErrorMessage 对未注册码返回
  //  'errors.<CODE>' 完整 key 形态，比较码本身会漏判）
  const registered = Object.hasOwn(ERROR_META, entry.code);
  const title = registered ? getErrorMessage(entry.code as ErrorCode) : t('chat.turnErrorTitle');
  // 详情：主进程权威消息逐字展示（空消息给占位文案）
  const detail = entry.message.trim().length > 0 ? entry.message : t('chat.turnErrorNoDetail');
  // 提示：API Key 族给定向指引（本地网关模型需网关自身签发的 Key——2026-10-09 实测案例）
  const hint = entry.code.startsWith('AI_API_KEY')
    ? t('chat.turnErrorHintApiKey')
    : t('chat.turnErrorHint');

  const dismiss = (): void => {
    clear(sessionId);
  };

  const retry = (): void => {
    // 先清卡再重发：重发失败会再次写入（set），成功则下一回合 start 事件兜底清除
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
      {/* 内容列（Alert 为 [图标 | 内容] grid 布局；继承 AlertTitle 的字号/字重但
          放开 line-clamp-1 截断——错误详情需要多行完整展示） */}
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
