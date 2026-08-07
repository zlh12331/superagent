// src/renderer/components/agent/ApprovalDialog.tsx
// 审批对话框 · 组装层（载荷解析/预览提取至独立文件）
// ──────────────────────────────
// 拆分背景（2026-08 重构）：原文件 539 行，按职责拆分：
// - approval-utils.ts：载荷解析与类型元数据（纯函数）
// - approval-preview.tsx：结构化预览（JSON / Git 变更）
// ──────────────────────────────

// src/renderer/components/agent/ApprovalDialog.tsx
// 审批对话框 · 结构化展示 + 记住决策
// ──────────────────────────────────────────────────────────────
// 职责：
// - 从 useApprovalsStore 读取 pending 队列首项
// - 按 ApprovalType 结构化展示工具入参（命令预览 / 文件路径 / diff 预览）
// - 提供「批准」/「拒绝」两个操作按钮
// - 「记住决策」复选框（透传 rememberDecision 到主进程）
// - pending 为空时自动关闭
//
// 设计：
// - 文学风：衬线字体标题 + 米色背景 + 圆角
// - 不同 ApprovalType 使用不同 lucide 图标（增强视觉辨识）
// - 描述区使用 pre-wrap 保留换行（命令 / diff 内容）
// - 危险操作（delete_file / run_command / install_package）的拒绝按钮使用 destructive variant
// - 结构化展示区使用 monospace 字体 + 暗色背景，便于查看代码 / 命令
// ──────────────────────────────────────────────────────────────

import { AlertTriangle } from 'lucide-react';
import { type ReactElement, useState } from 'react';

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
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useTheme } from '@/providers/ThemeProvider';
import { useApprovalsStore } from '@/stores/transient/approvals-store';

import { renderStructuredPreview } from './approval-preview';
import {
  canRememberDecision,
  getIconForType,
  getLabelKeyForType,
  getVariantForType,
  isDangerousType,
} from './approval-utils';

/** ApprovalDialog props */
/** ApprovalDialog props */
interface ApprovalDialogProps {
  /** 审批响应回调（approvalId, approved, rememberDecision） */
  readonly onRespond: (approvalId: string, approved: boolean, rememberDecision?: boolean) => void;
  /** 附加 className */
  readonly className?: string;
}

export function ApprovalDialog({ onRespond, className }: ApprovalDialogProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 订阅 pending 队列：只取队首项（一次只处理一个审批）
  const currentPending = useApprovalsStore((state) => state.pending[0]);

  // 记住决策复选框状态：每次切换审批项时重置为 false
  const [rememberDecision, setRememberDecision] = useState(false);

  // 当前审批项的图标与标签（通过 currentPending.type 查表；React Compiler 自动缓存）
  // 使用 lowercase 属性名（icon），在解构时重命名为大写 Icon 以满足 JSX 组件命名要求
  const { icon: Icon, typeLabel } = (() => {
    if (currentPending === undefined) {
      return { icon: AlertTriangle, typeLabel: t('approval.approval') };
    }
    return {
      icon: getIconForType(currentPending.type),
      typeLabel: t(`approval.${getLabelKeyForType(currentPending.type)}`),
    };
  })();

  // 拒绝按钮 variant：危险类型用 destructive，其他用 outline
  const rejectVariant: 'destructive' | 'outline' =
    currentPending !== undefined && isDangerousType(currentPending.type)
      ? 'destructive'
      : 'outline';

  // 是否支持"记住决策"复选框
  const showRememberCheckbox =
    currentPending !== undefined && canRememberDecision(currentPending.type);

  // 结构化预览内容（useDarkTheme 跟随全局主题：diff 双栏深色适配）
  const { resolvedTheme } = useTheme();
  const structuredPreview =
    currentPending === undefined
      ? null
      : renderStructuredPreview(
          currentPending.type,
          currentPending.input,
          t,
          resolvedTheme === 'dark',
        );

  // 审批类型变体徽章（对齐原型 modal-variant 7 色徽章）
  const variantBadge = currentPending === undefined ? null : getVariantForType(currentPending.type);

  // 处理用户点击批准/拒绝
  // 点击后 store 会自动从 pending 移除该项（由 useApprovalBridge.respondApproval 触发）
  // 同时重置 rememberDecision 为 false（为下一个审批项准备）
  const handleApprove = (): void => {
    if (currentPending === undefined) return;
    onRespond(currentPending.id, true, rememberDecision);
    setRememberDecision(false);
  };
  const handleReject = (): void => {
    if (currentPending === undefined) return;
    onRespond(currentPending.id, false, rememberDecision);
    setRememberDecision(false);
  };

  return (
    <Dialog open={currentPending !== undefined} onOpenChange={() => {}}>
      {/* onOpenChange 空实现：禁止点击遮罩/Esc 关闭，强制用户做出选择 */}
      <DialogContent
        className={className}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        {currentPending !== undefined && (
          <>
            <DialogHeader>
              {/* 标题：图标 + 类型徽章 + 类型标签 + 工具名 */}
              <DialogTitle className="flex items-center gap-2 font-serif tracking-wide">
                <Icon className="size-5" strokeWidth={1.5} />
                {variantBadge !== null && (
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 font-sans text-2xs font-semibold',
                      variantBadge.className,
                    )}
                  >
                    {typeLabel}
                  </span>
                )}
                <span>{currentPending.title}</span>
              </DialogTitle>
              {/* 描述：人类可读的操作摘要（pre-wrap 保留换行） */}
              <DialogDescription className="font-serif leading-relaxed whitespace-pre-wrap">
                {currentPending.description}
              </DialogDescription>
            </DialogHeader>

            {/* 结构化工具入参预览（按 ApprovalType 渲染） */}
            {structuredPreview}

            <DialogFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
              {/* 记住决策复选框：仅对支持的工具类型显示 */}
              {showRememberCheckbox ? (
                <Label className="flex cursor-pointer items-center gap-2 text-xs font-sans text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={rememberDecision}
                    onChange={(e) => setRememberDecision(e.target.checked)}
                    className="size-3.5 cursor-pointer accent-foreground"
                  />
                  <span>{t('approval.rememberDecision')}</span>
                </Label>
              ) : (
                <span />
              )}

              {/* 操作按钮 */}
              <div className="flex justify-end gap-2">
                <Button variant={rejectVariant} onClick={handleReject}>
                  {t('approval.reject')}
                </Button>
                <Button variant="default" onClick={handleApprove}>
                  {t('approval.approve')}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
