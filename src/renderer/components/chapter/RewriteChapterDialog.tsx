// src/renderer/components/chapter/RewriteChapterDialog.tsx
// AI 改写指令输入对话框
// 设计文档 §5.1 场景 5（Agent 章节生成）+ §7.7 Agent 编排
//
// 职责：
// - 受控对话框（open + onOpenChange），收集用户改写指令
// - 提交时调用 useRewriteChapter mutateAsync 触发 AI 改写
// - 成功后清空 instruction 并关闭对话框，把 ackId 回传父组件用于流式订阅
//
// 注意：
// - instruction 必填，前端在 Button disabled 上即时反馈
// - mutation 失败的 toast 由 handleIpcError 统一处理
// - 此 Dialog 不订阅流式事件，仅触发 mutation；流式展示由父组件统一管理

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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useRewriteChapter } from '@/hooks/use-agent';
import { handleIpcError } from '@/lib/handle-ipc-error';

interface RewriteChapterDialogProps {
  /** 是否打开 */
  open: boolean;
  /** 打开状态变更回调（受控） */
  onOpenChange: (open: boolean) => void;
  /** 待改写的章节 ID */
  chapterId: string | null;
  /**
   * AI 改写已成功触发回调
   *
   * @param ackId - 流 ID（父组件用于订阅流式事件展示）
   */
  onStarted: (ackId: string) => void;
}

/**
 * AI 改写指令输入对话框
 *
 * @example
 * <RewriteChapterDialog
 *   open={rewriteOpen}
 *   onOpenChange={setRewriteOpen}
 *   chapterId={activeChapter?.id ?? null}
 *   onStarted={(ackId) => setActiveAckId(ackId)}
 * />
 */
export function RewriteChapterDialog({
  open,
  onOpenChange,
  chapterId,
  onStarted,
}: RewriteChapterDialogProps): ReactElement {
  // 表单本地状态：改写指令
  const [instruction, setInstruction] = useState('');
  const { mutateAsync, isPending } = useRewriteChapter();

  // 提交表单：触发 AI 改写
  const handleSubmit = async (): Promise<void> => {
    // 必填校验：指令不能为空
    if (instruction.trim().length === 0) return;
    if (chapterId === null) return;

    try {
      const { ackId } = await mutateAsync({
        chapterId,
        instruction: instruction.trim(),
      });
      // 成功：清空表单、关闭对话框、回传 ackId 给父组件
      setInstruction('');
      onOpenChange(false);
      onStarted(ackId);
    } catch (err) {
      // 失败：useRewriteChapter 不内置 onError，这里统一处理 toast
      // 不关闭对话框，让用户可以重试
      handleIpcError(err);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>AI 改写章节</DialogTitle>
          <DialogDescription>输入改写指令，AI 将基于现有正文进行改写并自动保存</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="rewrite-instruction">改写指令 *</Label>
            <Textarea
              id="rewrite-instruction"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="如：把对话改得更生动，增加环境描写；或：用更紧凑的节奏重写本章"
              rows={5}
              maxLength={1000}
              disabled={isPending}
              // 按 Ctrl+Enter 提交（避免与单行 Input 的 Enter 提交冲突）
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  (e.ctrlKey || e.metaKey) &&
                  !isPending &&
                  instruction.trim().length > 0
                ) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            取消
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={isPending || instruction.trim().length === 0 || chapterId === null}
          >
            {isPending ? '提交中...' : '开始改写'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
