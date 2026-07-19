// src/renderer/routes/chapters.tsx
// 章节管理路由占位
// 设计文档 §3 路由结构 + Phase 7 仅占位（Phase 8 接入业务）
//
// 职责：
// - 展示章节列表 + 编辑器入口（占位）
// - 后续 Phase 8 将接入 useQuery(apiClient.chapter.list) + TipTap 3 编辑器

import type { ReactElement } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** 章节管理页面（占位） */
export function Component(): ReactElement {
  return (
    <div className="p-6">
      <Card>
        <CardHeader>
          <CardTitle>章节管理</CardTitle>
          <CardDescription>Phase 8 实现：章节树 + TipTap 3 编辑器</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          此处将展示章节列表，支持拖拽排序、新建/编辑/删除章节， 右侧编辑器区域将集成 TipTap 3
          富文本编辑器。
        </CardContent>
      </Card>
    </div>
  );
}

Component.displayName = 'ChaptersPage';
