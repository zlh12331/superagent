// src/renderer/components/settings/ProjectSettingsLink.tsx
// 项目选择器区块
// 设计文档 §7.7 应用设置
//
// 职责：
// - 通过 useProjectList 加载项目列表
// - 用原生 <select> 下拉框选择当前要配置的项目
// - 选中后通过 onProjectChange 通知父组件，父组件再把 projectId 传给 AiParamsSection
//
// 注意：
// - 因项目无 shadcn Select 组件，使用原生 <select>（Biome useNamingConvention
//   对原生 HTML 属性的 kebab-case 不会报错）
// - 本区块不直接渲染项目级设置表单，仅做项目选择与跳转入口
// - 路由树无 project-level settings 子路由，所有设置都在全局 /settings 页

import { FolderCog } from 'lucide-react';
import type { ReactElement } from 'react';

import { ErrorState } from '@/components/common/ErrorState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useProjectList } from '@/hooks/use-projects';

interface ProjectSettingsLinkProps {
  /** 当前选中的项目 ID（null 表示未选择） */
  selectedProjectId: string | null;
  /** 项目变更回调：通知父组件当前选择的项目 */
  onProjectChange: (projectId: string | null) => void;
}

/**
 * 项目选择器区块
 *
 * @example
 * <ProjectSettingsLink
 *   selectedProjectId={selected}
 *   onProjectChange={setSelected}
 * />
 */
export function ProjectSettingsLink({
  selectedProjectId,
  onProjectChange,
}: ProjectSettingsLinkProps): ReactElement {
  const { data: projects, isLoading, error, refetch } = useProjectList();

  // 加载中：展示旋转占位
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderCog className="size-4" />
            项目设置
          </CardTitle>
          <CardDescription>选择要配置的项目</CardDescription>
        </CardHeader>
        <CardContent>
          <LoadingSpinner label="正在加载项目列表..." />
        </CardContent>
      </Card>
    );
  }

  // 加载失败：展示错误信息 + 重试按钮
  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderCog className="size-4" />
            项目设置
          </CardTitle>
          <CardDescription>选择要配置的项目</CardDescription>
        </CardHeader>
        <CardContent>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </CardContent>
      </Card>
    );
  }

  // projects 可能为 undefined（query 未触发），用空数组兜底
  const safeProjects = projects ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderCog className="size-4" />
          项目设置
        </CardTitle>
        <CardDescription>选择要配置的项目</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="project-select">选择项目</Label>
          {/* 原生 select：避免引入 shadcn Select 依赖 */}
          <select
            id="project-select"
            value={selectedProjectId ?? ''}
            onChange={(e) => onProjectChange(e.target.value === '' ? null : e.target.value)}
            className="border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <option value="">请选择项目</option>
            {safeProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <p className="text-muted-foreground text-xs">
          选择项目后，可在下方调整该项目的 AI 模型参数
        </p>
      </CardContent>
    </Card>
  );
}
