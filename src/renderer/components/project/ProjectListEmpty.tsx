// src/renderer/components/project/ProjectListEmpty.tsx
// 项目列表空状态组件 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 设计：图标 strokeWidth=1.5，文案由 EmptyState 衬线字体处理
// ──────────────────────────────────────────────────────────────
//
// 职责：
// - 在项目列表为空时引导用户新建第一个项目
// - 复用通用 EmptyState 组件，传入文件夹图标与新建回调
//
// 注意：此组件为展示型组件，不包含业务逻辑，新建动作通过 onAction 回调上抛给父组件。

import { FolderPlus } from 'lucide-react';
import type { ReactElement } from 'react';

import { EmptyState } from '@/components/common/EmptyState';

interface ProjectListEmptyProps {
  /** 新建项目回调（由父组件打开新建对话框） */
  onAction: () => void;
}

/**
 * 项目列表空状态
 *
 * @example
 * {projects.length === 0 && <ProjectListEmpty onAction={() => setCreateOpen(true)} />}
 */
export function ProjectListEmpty({ onAction }: ProjectListEmptyProps): ReactElement {
  return (
    <EmptyState
      icon={<FolderPlus className="size-6" strokeWidth={1.5} />}
      title="暂无项目"
      description="点击新建项目开始你的写作之旅"
      actionLabel="新建项目"
      onAction={onAction}
    />
  );
}
