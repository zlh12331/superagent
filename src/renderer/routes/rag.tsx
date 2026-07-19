// src/renderer/routes/rag.tsx
// RAG 文档路由占位
// 设计文档 §3 路由结构 + §6 RAG 检索增强
//
// 职责：
// - 展示已入库文档列表 + 文档入库入口（占位）
// - 后续 Phase 8 将接入 useQuery(apiClient.rag.listDocuments) + 文件上传

import type { ReactElement } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** RAG 文档页面（占位） */
export function Component(): ReactElement {
  return (
    <div className="p-6">
      <Card>
        <CardHeader>
          <CardTitle>RAG 文档</CardTitle>
          <CardDescription>Phase 8 实现：文档列表 + 上传 + 检索测试</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          此处将展示已入库文档列表，支持拖拽上传 PDF/Markdown/TXT， 文档将切片并写入 pgvector，用于
          AI 对话中的检索增强。
        </CardContent>
      </Card>
    </div>
  );
}

Component.displayName = 'RagPage';
