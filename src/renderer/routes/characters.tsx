// src/renderer/routes/characters.tsx
// 人物卡路由占位
// 设计文档 §3 路由结构 + Phase 7 仅占位（Phase 8 接入业务）
//
// 职责：
// - 展示人物列表 + 人物关系图（占位）
// - 后续 Phase 8 将接入 useQuery(apiClient.character.list) + ReactFlow 关系图

import type { ReactElement } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** 人物卡页面（占位） */
export function Component(): ReactElement {
  return (
    <div className="p-6">
      <Card>
        <CardHeader>
          <CardTitle>人物卡</CardTitle>
          <CardDescription>Phase 8 实现：人物列表 + 关系图（ReactFlow）</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          此处将展示人物卡片网格，支持新建/编辑/删除人物， 右侧关系图区域将使用 ReactFlow
          渲染人物关系网络。
        </CardContent>
      </Card>
    </div>
  );
}

Component.displayName = 'CharactersPage';
