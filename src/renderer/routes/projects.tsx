// src/renderer/routes/projects.tsx
// 项目列表路由占位
// 设计文档 §3 路由结构 + Phase 7 仅占位（Phase 8 接入业务）
//
// 职责：
// - 展示项目列表入口（占位）
// - 后续 Phase 8 将接入 useQuery(apiClient.project.list) + 新建项目对话框
//
// RR7 lazy 约定：模块需 export function Component（命名导出，非默认导出）

import type { ReactElement } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * 项目列表页面（占位）
 */
export function Component(): ReactElement {
  return (
    <div className="mx-auto max-w-4xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>项目列表</CardTitle>
          <CardDescription>Phase 8 实现：项目卡片网格 + 新建项目对话框</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          此处将展示所有项目，支持搜索、归档、删除操作。
        </CardContent>
      </Card>
    </div>
  );
}

// RR7 lazy 约定的 display name
Component.displayName = 'ProjectsPage';
