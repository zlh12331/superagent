// src/renderer/components/common/ConfirmDialog.tsx
// 通用确认对话框
// 设计文档 §7.10 用户友好提示
//
// 职责：
// - 在执行危险操作前要求用户二次确认
// - 用于删除项目/章节/人物等不可恢复操作
//
// 注意：
// - 基于 shadcn Dialog 组件封装，受控模式（open + onOpenChange）
// - onConfirm 支持返回 Promise：异步执行期间禁用按钮，成功后自动关闭对话框
//   失败时（reject）不关闭，让用户可重试（由调用方控制是否抛错）

import type { ReactElement } from 'react';
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

interface ConfirmDialogProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onOpenChange: (open: boolean) => void;
  /** 标题（默认"确认操作"） */
  title?: string;
  /** 描述（说明将要做什么及后果） */
  description: string;
  /** 确认按钮文字（默认"确认"） */
  confirmLabel?: string;
  /** 取消按钮文字（默认"取消"） */
  cancelLabel?: string;
  /** 确认按钮 variant（默认 destructive 表示危险操作） */
  confirmVariant?: 'default' | 'destructive';
  /** 确认回调（可返回 Promise，成功后自动关闭对话框，失败时不关闭） */
  onConfirm: () => void | Promise<void>;
}

/**
 * 通用确认对话框
 *
 * @example
 * // 同步确认（向后兼容）
 * <ConfirmDialog
 *   open={confirmOpen}
 *   onOpenChange={setConfirmOpen}
 *   description={`确定删除项目「${project.name}」？此操作不可恢复。`}
 *   onConfirm={() => mutate(project.id)}
 * />
 *
 * @example
 * // 异步确认（带 loading + 失败不关闭）
 * <ConfirmDialog
 *   open={deleteTarget !== null}
 *   onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
 *   description="确定删除此会话？"
 *   onConfirm={async () => { await deleteAsync(id); }}
 * />
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title = '确认操作',
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  confirmVariant = 'destructive',
  onConfirm,
}: ConfirmDialogProps): ReactElement {
  // 异步执行中的 loading 状态（成功后清空并关闭，失败时仅清空让用户重试）
  const [isPending, setIsPending] = useState(false);

  const handleConfirm = async (): Promise<void> => {
    setIsPending(true);
    try {
      await onConfirm();
      // 成功后才关闭对话框
      onOpenChange(false);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 异步执行中禁止关闭（避免半途打断 mutation）
        if (isPending && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={() => void handleConfirm()}
            disabled={isPending}
          >
            {isPending ? '处理中...' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
