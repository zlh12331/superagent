// src/renderer/routes/projects.tsx
// 项目列表路由
// 设计文档 §3 路由结构 + §5.1 数据流
//
// 职责：
// - 通过 useProjectList 拉取项目列表
// - 渲染 Loading / Error / Empty / Grid 四种状态
// - 提供新建项目入口（ProjectCreateDialog）与删除二次确认（ConfirmDialog）
//
// RR7 lazy 约定：模块需 export function Component（命名导出，非默认导出）

import { Plus } from 'lucide-react';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ErrorState } from '@/components/common/ErrorState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ProjectCard } from '@/components/project/ProjectCard';
import { ProjectCreateDialog } from '@/components/project/ProjectCreateDialog';
import { ProjectListEmpty } from '@/components/project/ProjectListEmpty';
import { Button } from '@/components/ui/button';
import { useArchiveProject, useDeleteProject, useProjectList } from '@/hooks/use-projects';

/**
 * 项目列表页面
 *
 * 状态机：
 * - isLoading：展示 LoadingSpinner
 * - error：展示 ErrorState（带重试按钮）
 * - 空列表：展示 ProjectListEmpty
 * - 正常：展示项目卡片网格
 */
export function Component(): ReactElement {
  const { data: projects, isLoading, error, refetch } = useProjectList();
  const { mutateAsync: archiveAsync } = useArchiveProject();
  const { mutateAsync: deleteAsync } = useDeleteProject();

  // 新建项目对话框开关
  const [createOpen, setCreateOpen] = useState(false);
  // 待删除项目 ID（null 表示未进入删除确认流程）
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // 加载中：展示旋转加载占位
  if (isLoading) {
    return <LoadingSpinner label="正在加载项目列表..." />;
  }

  // 加载失败：展示错误信息 + 重试按钮
  if (error) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  // 空状态：引导用户新建第一个项目
  if (projects === undefined || projects.length === 0) {
    return (
      <>
        <div className="mx-auto max-w-4xl p-6">
          <ProjectListEmpty onAction={() => setCreateOpen(true)} />
        </div>
        <ProjectCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      </>
    );
  }

  // 确认删除：调用 mutation，结束后清理 deleteTarget
  // ConfirmDialog.onConfirm 期望 () => void，async 函数需 void 包装
  const handleDelete = async (): Promise<void> => {
    if (deleteTarget === null) return;
    try {
      await deleteAsync(deleteTarget);
    } catch {
      // 失败已由 mutation onError 统一处理（toast），此处无需再处理
    }
    setDeleteTarget(null);
  };

  return (
    <div className="mx-auto max-w-5xl p-6">
      {/* 顶部标题栏 + 新建按钮 */}
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-foreground text-lg font-semibold">项目列表</h1>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          新建项目
        </Button>
      </div>
      {/* 项目卡片网格：响应式 1/2/3 列 */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            onArchive={(id) => void archiveAsync(id)}
            onDelete={(id) => setDeleteTarget(id)}
          />
        ))}
      </div>
      {/* 新建项目对话框（受控） */}
      <ProjectCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      {/* 删除二次确认对话框 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="删除项目"
        description="确定删除此项目？所有章节、人物、世界观数据将一并删除，此操作不可恢复。"
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}

// RR7 lazy 约定的 display name
Component.displayName = 'ProjectsPage';
