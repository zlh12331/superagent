// src/renderer/components/layout/goal-edit-dialog.tsx
// 会话目标编辑对话框（照搬参考项目 GoalEditDialog）
// ──────────────────────────────────────────────────────────────
// 参考项目字段：objective / status / tokenBudget 三字段。
// 当前后端 goal:create 仅支持 condition（目标完成条件，状态由 LLM 回合判定
// 自动维护，无 token 预算字段）——status / tokenBudget 诚实裁剪，仅保留
// objective → condition 映射，避免渲染无数据源的假表单字段。
//
// 状态重置策略（照搬参考项目）：通过 React `key` 让内部表单在 goal 变化或
// 对话框重新打开时重新挂载，useState 从 props 的 initial 值读取，避免在
// effect 中 setState。
// ──────────────────────────────────────────────────────────────

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/i18n/use-translation';

/** GoalEditDialog 组件 props */
export interface GoalEditDialogProps {
  /** 是否打开对话框 */
  readonly open: boolean;
  /** 关闭对话框回调 */
  readonly onOpenChange: (open: boolean) => void;
  /** 当前目标条件（用于初始化表单）；空字符串表示无目标 */
  readonly initialCondition: string;
  /** 提交回调（条件非空时触发） */
  readonly onSubmit: (condition: string) => void;
  /** 是否正在提交 */
  readonly isSubmitting?: boolean;
}

/**
 * 会话目标编辑对话框。
 *
 * 表单字段（诚实裁剪后）：condition（目标完成条件，textarea 必填）。
 */
export function GoalEditDialog({
  open,
  onOpenChange,
  initialCondition,
  onSubmit,
  isSubmitting = false,
}: GoalEditDialogProps): React.ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 表单状态（key 机制保证对话框打开/目标变化时重新挂载，初始值同步）
  const [condition, setCondition] = useState(initialCondition);

  const handleSubmit = (): void => {
    const trimmed = condition.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
  };

  const isValid = condition.trim().length > 0;
  const hasGoal = initialCondition.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {hasGoal ? t('panel.editGoalTitle') : t('panel.setGoalTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-[12px]">
            {t('panel.goalDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {/* 目标描述（objective → condition 映射；status/tokenBudget 无后端字段，诚实裁剪） */}
          <div className="space-y-2">
            <Label htmlFor="goal-condition" className="text-[12px]">
              {t('panel.goalLabel')}
            </Label>
            <Textarea
              id="goal-condition"
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
              placeholder={t('panel.goalPlaceholder')}
              rows={3}
              className="text-[13px]"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || isSubmitting}>
            {isSubmitting ? t('panel.savingGoal') : t('panel.saveGoal')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
