// src/renderer/components/rag/RagDocumentList.tsx
// RAG 文档列表组件
// 设计文档 §5.1 数据流 + §6 RAG 检索增强 + §7.10 用户友好提示
//
// 职责：
// - 渲染已入库的 RAG 文档列表（标题 / 切片数 / 时间 / 类型）
// - 顶部提供"+ 上传文档"按钮，触发父组件打开上传对话框
// - 每项右侧 DropdownMenu 提供"删除"操作（具体执行由父组件二次确认）
// - 空列表时展示 EmptyState 引导上传第一个文档
//
// 注意：
// - 本组件为纯展示型组件，不直接调用 mutation，删除/上传均通过回调上抛父组件
// - DropdownMenu 触发器需 stopPropagation，避免点击触发器时同时触发卡片选中
//   （此处没有卡片选中场景，但保留 stopPropagation 习惯，便于未来扩展）

import type { RagDocument } from '@novel-writer/shared';
import { FileText, MoreVertical, Plus, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';

import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatRelativeTime } from '@/lib/format';

interface RagDocumentListProps {
  /** 当前项目 ID（预留，目前未在组件内直接使用） */
  projectId: string;
  /** 已入库文档列表（父组件已加载完毕） */
  documents: RagDocument[];
  /** 点击"+ 上传文档"按钮回调（父组件打开上传对话框） */
  onUploadClick: () => void;
  /** 删除文档回调（父组件弹出二次确认） */
  onDeleteDocument: (id: string) => void;
}

/**
 * 根据 mimeType 返回人类可读的类型标签
 *
 * 用 includes 而非 === 容错 charset 后缀（如 'text/markdown; charset=utf-8'）。
 * 未识别的 mimeType 直接原样返回，便于调试。
 */
function getMimeTypeLabel(mimeType: string | null | undefined): string {
  // null / undefined 都视为未知类型
  if (mimeType === null || mimeType === undefined) return '未知';
  if (mimeType.includes('markdown')) return 'Markdown';
  if (mimeType.includes('plain')) return '文本';
  if (mimeType.includes('json')) return 'JSON';
  // 其他类型原样展示，便于用户识别
  return mimeType;
}

/**
 * RAG 文档列表
 *
 * @example
 * <RagDocumentList
 *   projectId={projectId}
 *   documents={documents}
 *   onUploadClick={() => setUploadOpen(true)}
 *   onDeleteDocument={(id) => setDeleteTarget(id)}
 * />
 */
export function RagDocumentList({
  projectId: _projectId,
  documents,
  onUploadClick,
  onDeleteDocument,
}: RagDocumentListProps): ReactElement {
  // 空列表：引导用户上传第一个文档
  if (documents.length === 0) {
    return (
      <section className="bg-card flex h-full flex-col border">
        {/* 顶部标题栏 + 上传按钮 */}
        <div className="flex items-center justify-between border-b p-3">
          <h2 className="text-foreground text-sm font-semibold">已入库文档</h2>
          <Button size="sm" onClick={onUploadClick}>
            <Plus className="size-4" />
            上传文档
          </Button>
        </div>
        {/* 空状态：图标 + 标题 + 描述 + 引导按钮 */}
        <div className="flex-1">
          <EmptyState
            icon={<FileText className="size-6" />}
            title="还没有文档"
            description="上传 Markdown / 文本 / JSON 文档，AI 对话将基于这些文档进行检索增强"
            actionLabel="上传第一个文档"
            onAction={onUploadClick}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="bg-card flex h-full flex-col border">
      {/* 顶部标题栏 + 上传按钮 */}
      <div className="flex items-center justify-between border-b p-3">
        <h2 className="text-foreground text-sm font-semibold">已入库文档</h2>
        <Button size="sm" onClick={onUploadClick}>
          <Plus className="size-4" />
          上传文档
        </Button>
      </div>
      {/* 文档列表：ScrollArea 提供细滚动条 */}
      <ScrollArea className="flex-1">
        <ul className="flex flex-col gap-0.5 p-2">
          {documents.map((doc) => {
            // 删除操作：上抛文档 ID，由父组件弹出确认框
            const handleDelete = (): void => {
              onDeleteDocument(doc.id);
            };
            return (
              <li key={doc.id}>
                {/* biome-ignore lint/a11y/useSemanticElements: 外层需承载 DropdownMenu 触发 Button，HTML 不允许 button 嵌套 button，故用 div + role=button */}
                <div
                  role="group"
                  className="group hover:bg-accent flex items-center gap-2 rounded-sm px-2 py-2 text-sm transition-colors"
                >
                  {/* 左侧图标 */}
                  <FileText className="text-muted-foreground size-4 shrink-0" />
                  {/* 中间内容：标题 + 元信息 */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{doc.title}</p>
                    <p className="text-muted-foreground mt-0.5 truncate text-xs">
                      {/* 元信息：切片数 · 相对时间 · 类型 */}
                      {doc.chunksCount} 切片 · {formatRelativeTime(doc.createdAt)} ·{' '}
                      {getMimeTypeLabel(doc.mimeType)}
                    </p>
                  </div>
                  {/* 右侧操作菜单：点击触发器时不冒泡，避免影响未来可能加上的卡片选中 */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 opacity-0 group-hover:opacity-100"
                        aria-label="文档操作"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreVertical className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem variant="destructive" onClick={handleDelete}>
                        <Trash2 className="size-4" />
                        删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </section>
  );
}
