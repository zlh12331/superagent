// src/renderer/routes/rag.tsx
// RAG 文档工作台路由
// 设计文档 §3 路由结构 + §5.1 数据流 + §6 RAG 检索增强
//
// 职责：
// - 通过 useRagDocumentList 加载已入库文档，渲染 Loading / Error / 工作台三种状态
// - 左侧：RagDocumentList（文档列表 + 上传入口 + 删除入口）
// - 右侧：RagSearchTestPanel（检索测试：query + topK + threshold + 结果列表）
// - 上传对话框：RagUploadDialog（受控）
// - 删除二次确认：ConfirmDialog
//
// RR7 lazy 约定：模块需 export function Component（命名导出，非默认导出）

import type { ReactElement } from 'react';
import { useState } from 'react';
import { useParams } from 'react-router';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ErrorState } from '@/components/common/ErrorState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { RagDocumentList } from '@/components/rag/RagDocumentList';
import { RagSearchTestPanel } from '@/components/rag/RagSearchTestPanel';
import { RagUploadDialog } from '@/components/rag/RagUploadDialog';
import { useDeleteRagDocument, useRagDocumentList } from '@/hooks/use-rag';

/**
 * RAG 文档工作台页面
 *
 * 状态机：
 * - isLoading：展示 LoadingSpinner
 * - error：展示 ErrorState（带重试按钮）
 * - 正常：左侧文档列表 + 右侧检索测试面板
 *
 * 注意：空列表状态由 RagDocumentList 内部处理（EmptyState + 引导上传按钮），
 * 路由层不再单独渲染 EmptyState，让列表组件与上传按钮始终可用。
 */
export function Component(): ReactElement {
  const { projectId } = useParams();
  // useParams 返回 string | undefined；为 undefined 时传空字符串，
  // hook 内部 enabled 判断为 false 不会发起请求，避免无效查询
  const safeProjectId = projectId ?? '';

  // 数据 hooks
  const { data: documents, isLoading, error, refetch } = useRagDocumentList(safeProjectId);
  const { mutateAsync: deleteAsync } = useDeleteRagDocument();

  // 上传对话框开关
  const [uploadOpen, setUploadOpen] = useState(false);
  // 待删除文档 ID（null 表示未进入删除确认流程）
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  /**
   * 删除文档：由 ConfirmDialog 确认后执行
   *
   * 失败已由 mutation onError 统一处理（toast），此处无需再处理。
   */
  const handleDelete = async (): Promise<void> => {
    if (deleteTarget === null) return;
    try {
      await deleteAsync(deleteTarget);
    } catch {
      // 失败已由 mutation onError 统一处理（toast），此处无需再处理
    }
    setDeleteTarget(null);
  };

  // 加载中：展示旋转加载占位
  if (isLoading) {
    return <LoadingSpinner label="正在加载文档列表..." />;
  }

  // 加载失败：展示错误信息 + 重试按钮
  if (error) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  // documents 可能为 undefined（理论上是 query 还未触发），用空数组兜底避免传 undefined
  const safeDocuments = documents ?? [];

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between">
        <h1 className="text-foreground text-lg font-semibold">RAG 文档</h1>
      </div>

      {/* 主体：左右双列布局，左侧文档列表 + 右侧检索测试 */}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
        {/* 左侧：已入库文档列表 */}
        <RagDocumentList
          projectId={safeProjectId}
          documents={safeDocuments}
          onUploadClick={() => setUploadOpen(true)}
          onDeleteDocument={(id) => setDeleteTarget(id)}
        />
        {/* 右侧：检索测试面板 */}
        <RagSearchTestPanel projectId={safeProjectId} />
      </div>

      {/* 上传对话框（受控） */}
      <RagUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} projectId={safeProjectId} />
      {/* 删除二次确认对话框 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="删除文档"
        description="确定删除此文档？该文档的所有切片与向量将一并删除，此操作不可恢复。"
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}

// RR7 lazy 约定的 display name
Component.displayName = 'RagPage';
