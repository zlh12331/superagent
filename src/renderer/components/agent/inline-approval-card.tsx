// src/renderer/components/agent/inline-approval-card.tsx
// 内联审批卡片（对齐参考项目 superagent InlineApprovalCard + 原型 .card.paused）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 在消息流中内联展示审批请求（对齐参考项目：审批不弹窗打断，就地呈现）
// - 三态：pending（左 warn 边条 + 批准/拒绝按钮）/ approved / rejected（状态徽章）
// - 数据源：approvals-store（单一真源，与 ApprovalDialog 弹窗共存）
// ──────────────────────────────────────────────────────────────

import { Check, X } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useTheme } from '@/providers/ThemeProvider';
import { useApprovalsStore } from '@/stores/transient/approvals-store';
import { renderStructuredPreview } from './approval-preview';
import { getIconForType, getLabelKeyForType, isDangerousType } from './approval-utils';

/** 内联审批卡 props */
export interface InlineApprovalCardProps {
  /** 会话 id（只展示当前会话的审批） */
  readonly sessionId: string;
}

/**
 * 内联审批卡片
 *
 * 由 ChatPanel 在消息列表上方渲染；pending 时显示操作按钮，
 * 响应后（approve/reject）由 store 移动至 resolved，卡片显示状态。
 */
export function InlineApprovalCard({ sessionId }: InlineApprovalCardProps): ReactElement | null {
  const { t } = useTranslation();
  // 深色主题（结构化预览的 ReactDiffViewer 双栏适配）
  const { resolvedTheme } = useTheme();
  const isDarkTheme = resolvedTheme === 'dark';

  // 当前会话的审批项（pending 优先展示最新；已决的回显最近一条）
  const item = useApprovalsStore((state) => {
    const pending = [...state.pending].reverse().find((p) => p.sessionId === sessionId);
    if (pending !== undefined) return pending;
    const resolved = [...state.resolved].reverse().find((r) => r.sessionId === sessionId);
    return resolved;
  });

  const approve = useApprovalsStore((state) => state.approve);
  const reject = useApprovalsStore((state) => state.reject);

  if (item === undefined) return null;

  const Icon = getIconForType(item.type);
  const isPending = item.status === 'pending';
  const isApproved = item.status === 'approved';
  const dangerous = isDangerousType(item.type);

  return (
    <div
      className={cn(
        'mx-3 mt-2 rounded-lg border bg-card px-3 py-2 text-xs',
        isPending && 'border-l-4 border-l-amber-500',
        isApproved && 'border-l-4 border-l-emerald-500',
        item.status === 'rejected' && 'border-l-4 border-l-red-500',
      )}
      role="alert"
      aria-live="polite"
    >
      {/* 头部：图标 + 类型 + 状态 */}
      <div className="flex items-center gap-2">
        <Icon className={cn('size-3.5 shrink-0', dangerous && 'text-red-500')} strokeWidth={1.5} />
        <span className="text-foreground min-w-0 flex-1 truncate font-medium">
          {t(getLabelKeyForType(item.type))}
        </span>
        {!isPending && (
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9px]',
              isApproved
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-red-500/10 text-red-600 dark:text-red-400',
            )}
          >
            {isApproved ? t('approval.approved') : t('approval.rejected')}
          </span>
        )}
      </div>

      {/* 描述 + 结构化预览 */}
      {item.description !== '' && (
        <p className="text-muted-foreground mt-1 leading-relaxed whitespace-pre-wrap">
          {item.description}
        </p>
      )}
      {item.input !== undefined && (
        <div className="mt-1.5">
          {renderStructuredPreview(item.type, item.input, t, isDarkTheme)}
        </div>
      )}

      {/* pending 操作按钮 */}
      {isPending && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => reject(item.id)}
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex cursor-pointer items-center gap-1 rounded border px-2 py-1 text-xs transition-colors"
          >
            <X className="size-3" />
            {t('approval.reject')}
          </button>
          <button
            type="button"
            onClick={() => approve(item.id)}
            className={cn(
              'flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-white transition-colors',
              dangerous ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-600 hover:bg-emerald-700',
            )}
          >
            <Check className="size-3" />
            {t('approval.approve')}
          </button>
        </div>
      )}
    </div>
  );
}
