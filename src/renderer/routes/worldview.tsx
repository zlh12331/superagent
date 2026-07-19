// src/renderer/routes/worldview.tsx
// 世界观路由占位
// 设计文档 §3 路由结构 + Phase 7 仅占位（Phase 8 接入业务）
//
// 职责：
// - 展示世界观树（占位）
// - 后续 Phase 8 将接入 useQuery(apiClient.worldview.tree) + 树形视图

import type { ReactElement } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** 世界观页面（占位） */
export function Component(): ReactElement {
  return (
    <div className="p-6">
      <Card>
        <CardHeader>
          <CardTitle>世界观</CardTitle>
          <CardDescription>Phase 8 实现：世界观树（递归树形视图）</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          此处将展示世界观层级树，支持新建/编辑/删除节点，
          每个节点可包含设定文本与子节点，整体以树形结构呈现。
        </CardContent>
      </Card>
    </div>
  );
}

Component.displayName = 'WorldviewPage';
