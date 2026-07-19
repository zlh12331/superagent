// src/renderer/components/common/ConfirmDialog.tsx
// 通用确认对话框
// 设计文档 §7.10 用户友好提示
//
// 职责：
// - 在执行危险操作前要求用户二次确认
// - 用于删除项目/章节/人物等不可恢复操作
//
// 注意：基于 shadcn Dialog 组件封装，受控模式（open + onOpenChange）。

import type { ReactElement } from 'react';
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
  /** 确认回调 */
  onConfirm: () => void;
}

/**
 * 通用确认对话框
 *
 * @example
 * <ConfirmDialog
 *   open={confirmOpen}
 *   onOpenChange={setConfirmOpen}
 *   description={`确定删除项目「${project.name}」？此操作不可恢复。`}
 *   onConfirm={() => mutate(project.id)}
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
  const handleConfirm = (): void => {
    onConfirm();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant} onClick={handleConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
