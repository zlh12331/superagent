// src/renderer/components/project/ProjectCreateDialog.tsx
// 新建项目对话框
// 设计文档 §5.1 数据流 + §7.4 错误处理流程
//
// 职责：
// - 受控对话框（open + onOpenChange），收集 name/description/genre 三个字段
// - 提交时调用 useCreateProject mutateAsync 创建项目
// - 成功后清空表单并关闭对话框；失败时不关闭，让用户可以重试
//
// 注意：
// - name 为必填，前端在 Button disabled 上即时反馈
// - mutation 失败的 toast 由 useIpcMutation 内部 onError 统一处理，组件无需关心
// - exactOptionalPropertyTypes 开启：可选字段需用条件展开或显式 undefined 兜底

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
import { Textarea } from '@/components/ui/textarea';
import { useCreateProject } from '@/hooks/use-projects';

interface ProjectCreateDialogProps {
  /** 是否打开 */
  open: boolean;
  /** 打开状态变更回调（受控） */
  onOpenChange: (open: boolean) => void;
}

/**
 * 新建项目对话框
 *
 * @example
 * <ProjectCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
 */
export function ProjectCreateDialog({
  open,
  onOpenChange,
}: ProjectCreateDialogProps): ReactElement {
  // 表单本地状态：三个字段独立 useState，简单直观
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [genre, setGenre] = useState('');
  const { mutateAsync, isPending } = useCreateProject();

  // 提交表单：创建项目
  const handleSubmit = async (): Promise<void> => {
    // 必填校验：名称不能为空（仅空白也算空）
    if (name.trim().length === 0) return;

    try {
      await mutateAsync({
        name: name.trim(),
        // exactOptionalPropertyTypes 开启时不能显式传 undefined，
        // 用条件展开：空字符串字段直接省略属性，由后端默认值兜底
        ...(description.trim().length > 0 ? { description: description.trim() } : {}),
        ...(genre.trim().length > 0 ? { genre: genre.trim() } : {}),
      });
      // 成功：清空表单并关闭对话框
      setName('');
      setDescription('');
      setGenre('');
      onOpenChange(false);
    } catch {
      // 失败：useCreateProject 内部已通过 handleIpcError 显示 toast
      // 此处不关闭对话框，让用户可以重试
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
          <DialogDescription>填写项目基本信息，后续可在设置中修改</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-name">项目名称 *</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：剑破苍穹"
              maxLength={200}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-genre">流派</Label>
            <Input
              id="project-genre"
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
              placeholder="如：玄幻 / 都市 / 科幻"
              maxLength={50}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-description">简介</Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="一句话描述你的故事"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            取消
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={isPending || name.trim().length === 0}
          >
            {isPending ? '创建中...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
