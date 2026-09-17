// src/renderer/components/chat/panel-notice.tsx
// 面板告警条（自 ChatPanel 合并：中断提示 + 历史回显缺口提示）
// ──────────────────────────────────────────────
// 合并依据（2026-09-15 结构审计）：两条提示此前各自内联 ~20 行 JSX，
// 结构逐字段同构（amber 边框/底色 + AlertTriangle + 关闭按钮 + 按会话记录关闭态），
// 差异仅在单行（truncate）与多行（flex-col 列表）两种排布——属同一概念的两个实例。
// ─────────────────────────────────────────────

import { AlertTriangle, X } from 'lucide-react';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

/** 面板告警条 props */
export interface PanelNoticeProps {
  /** 提示文案行（1 行 → 单行 truncate；多行 → 纵向列表） */
  readonly lines: readonly string[];
  /** 关闭回调（关闭态由调用方按会话记录） */
  readonly onDismiss: () => void;
}

/**
 * 面板告警条
 *
 * 空行数组时不渲染（调用方无需自行判空）。
 */
export function PanelNotice({ lines, onDismiss }: PanelNoticeProps): ReactElement | null {
  const { t } = useTranslation();
  if (lines.length === 0) return null;
  const single = lines.length === 1;
  return (
    // role="status"（隐含 aria-live="polite"）：本提示的两条消费路径都是「会话
    // 加载后异步判定才出现」，此前无 live 语义，读屏不会主动播报。用 alert 过重
    // （打断当前朗读），status 与「非紧急提示」语义相称。
    <div
      role="status"
      className={cn(
        'border-amber/40 bg-amber/10 flex gap-2 border-b px-3 py-1 text-xs text-warn-text',
        single ? 'items-center' : 'items-start',
      )}
    >
      <AlertTriangle
        className={cn('size-3 shrink-0', !single && 'mt-0.5')}
        strokeWidth={2}
        aria-hidden="true"
      />
      {single ? (
        <span className="min-w-0 flex-1 truncate">{lines[0] ?? ''}</span>
      ) : (
        <span className="min-w-0 flex flex-1 flex-col gap-0.5">
          {/* key 用行下标：文案行本身可能重复（collectHistoryNotices 不保证唯一），
              以文本作 key 会在重复行时产生重复 key 警告 */}
          {lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 行序固定、无语重排，仅作稳定 key
            <span key={index} className="block">
              {line}
            </span>
          ))}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="text-warn-text hover:text-foreground hover:bg-transparent size-auto shrink-0"
        aria-label={t('common.close')}
        onClick={onDismiss}
      >
        <X className="size-3.5" strokeWidth={2} />
      </Button>
    </div>
  );
}
