// src/renderer/components/chat/GoalBar.tsx
// 会话目标栏（自 ChatPanel 提取的展示组件）
// ──────────────────────────────────────────────
// 左 GOAL 徽标 · 中条件文本 · 右 编辑/删除按钮。
// 纯展示：数据（useChatGoals）与动作回调由 ChatPanel 注入。
// 变体：无
// 状态：completed（显示完成徽标）
// ──────────────────────────────────────────────

import { Check, Pencil, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import { confirm } from '@/stores/transient/confirm-dialog-store';

import type { ChatGoalView } from './use-chat-goals';

interface GoalBarProps {
  /** 当前展示目标（active / completed） */
  readonly goal: ChatGoalView;
  /** 是否已完成（显示 Check 徽标） */
  readonly isCompleted: boolean;
  /** 编辑：把 /goal <条件> 预填进输入框 */
  readonly onEdit: () => void;
  /** 删除目标 */
  readonly onClear: () => void;
}

/**
 * 会话目标栏
 *
 * @example
 * ```tsx
 * {currentGoal !== undefined && (
 *   <GoalBar goal={currentGoal} isCompleted={isGoalCompleted} onEdit={...} onClear={...} />
 * )}
 * ```
 */
export function GoalBar({ goal, isCompleted, onEdit, onClear }: GoalBarProps): ReactElement {
  const { t } = useTranslation();

  /** 删除目标：破坏性操作走命令式确认（confirm-dialog-store，对齐 file-tree 删除做法） */
  const handleClear = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('chat.goalClearConfirmTitle'),
      message: t('chat.goalClearConfirmMessage'),
      danger: true,
    });
    if (confirmed) onClear();
  };

  return (
    <div className="border-accent/35 bg-accent/10 mx-auto mb-1 flex w-full max-w-2xl items-center gap-2 rounded-md border px-3 py-1.5">
      <Badge
        variant="outline"
        className="bg-accent/20 text-accent-text border-transparent px-1.5 py-0.5 font-mono text-[10px] font-bold"
      >
        GOAL
      </Badge>
      {isCompleted && (
        <Badge
          variant="outline"
          className="bg-success/10 text-success-text border-transparent gap-1 px-1.5 py-0.5 text-[10px] font-semibold"
        >
          <Check className="size-3" strokeWidth={2.5} />
          {t('chat.goalCompleted')}
        </Badge>
      )}
      <span className="text-foreground/90 min-w-0 flex-1 truncate text-xs" title={goal.condition}>
        {goal.condition}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:bg-muted hover:text-foreground size-6"
          title={t('chat.goalEdit')}
          aria-label={t('chat.goalEdit')}
          onClick={onEdit}
        >
          <Pencil className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:bg-destructive/15 hover:text-error-text size-6"
          title={t('chat.goalClear')}
          aria-label={t('chat.goalClear')}
          onClick={() => void handleClear()}
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  );
}
