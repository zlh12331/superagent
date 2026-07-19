// src/renderer/components/chapter/ChapterCreateDialog.tsx
// 新建章节对话框
// 设计文档 §5.1 数据流 + §7.4 错误处理流程
//
// 职责：
// - 受控对话框（open + onOpenChange），收集 title 字段
// - 提交时调用 useCreateChapter mutateAsync 创建章节
// - 成功后清空 title 并关闭对话框；失败时不关闭，让用户可以重试
//
// 注意：
// - title 为必填，前端在 Button disabled 上即时反馈
// - mutation 失败的 toast 由 useIpcMutation 内部 onError 统一处理，组件无需关心
// - exactOptionalPropertyTypes 开启：可选字段需用条件展开或显式 undefined 兜底

import { ChapterStatus } from '@novel-writer/shared';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCreateChapter } from '@/hooks/use-chapters';

interface ChapterCreateDialogProps {
  /** 是否打开 */
  open: boolean;
  /** 打开状态变更回调（受控） */
  onOpenChange: (open: boolean) => void;
  /** 所属项目 ID */
  projectId: string;
  /** 新章节的 sortOrder（父组件计算：当前最大 + 1） */
  nextSortOrder: number;
}

/**
 * 新建章节对话框
 *
 * @example
 * <ChapterCreateDialog
 *   open={createOpen}
 *   onOpenChange={setCreateOpen}
 *   projectId={projectId}
 *   nextSortOrder={chapters.length}
 * />
 */
export function ChapterCreateDialog({
  open,
  onOpenChange,
  projectId,
  nextSortOrder,
}: ChapterCreateDialogProps): ReactElement {
  // 表单本地状态：title 单字段，简单直观
  const [title, setTitle] = useState('');
  const { mutateAsync, isPending } = useCreateChapter();

  // 提交表单：创建章节
  const handleSubmit = async (): Promise<void> => {
    // 必填校验：标题不能为空（仅空白也算空）
    if (title.trim().length === 0) return;

    try {
      await mutateAsync({
        projectId,
        title: title.trim(),
        // content / status / sortOrder 在 schema 中有 default，
        // 但 z.infer 将带 default 的字段视为必填，需显式传入
        content: '',
        status: ChapterStatus.DRAFT,
        sortOrder: nextSortOrder,
      });
      // 成功：清空表单并关闭对话框
      setTitle('');
      onOpenChange(false);
    } catch {
      // 失败：useCreateChapter 内部已通过 handleIpcError 显示 toast
      // 此处不关闭对话框，让用户可以重试
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建章节</DialogTitle>
          <DialogDescription>输入章节标题，正文可在右侧编辑器中书写</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="chapter-title">章节标题 *</Label>
            <Input
              id="chapter-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：第一章 初入江湖"
              maxLength={200}
              // 按 Enter 键直接提交（提升录入效率）
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isPending && title.trim().length > 0) {
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
            disabled={isPending || title.trim().length === 0}
          >
            {isPending ? '创建中...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
