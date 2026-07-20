// src/renderer/components/chapter/ChapterList.tsx
// 章节列表侧边栏 · 极简文学风（含拖拽排序）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 暖米色背景（与 Topbar 同色）
// - 章节项激活态：左侧 3px 墨水条 + 暖米高亮底 + 深棕衬线标题
// - 章节项悬停态：浅暖米底 + 圆点变深
// - 字数用等宽字体（呼应"墨水计数"感）
// - "新建章节"按钮：虚线边框 + 深棕描边（参考 demo .new-chapter-btn）
// ──────────────────────────────────────────────────────────────
//
// 职责：
// - 渲染章节列表（标题 + 字数），高亮当前选中章节
// - 顶部提供"+ 新建章节"按钮，触发父组件打开新建对话框
// - 每项右侧 DropdownMenu 提供"删除"操作
// - 原生 HTML5 拖拽（draggable=true + onDragStart/onDragOver/onDrop）实现排序
//
// 注意：
// - 不引入 react-dnd，直接使用浏览器原生 DnD API，依赖少、包体小
// - 拖拽视觉反馈：被拖项半透明（opacity-50），目标项顶部显示插入指示线
// - 排序后的 ID 数组上抛给父组件，由父组件调 useReorderChapters 持久化
// - 删除按钮的 DropdownMenu 触发器需 stopPropagation，避免触发章节选中

import type { Chapter } from '@novel-writer/shared';
import { MoreVertical, Plus, Trash2 } from 'lucide-react';
import type { DragEvent, ReactElement } from 'react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatWordCount } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ChapterListProps {
  /** 当前项目 ID（预留，目前未在组件内直接使用） */
  projectId: string;
  /** 已按 sortOrder 升序排列的章节列表 */
  chapters: Chapter[];
  /** 当前选中章节 ID（null 表示未选中） */
  activeChapterId: string | null;
  /** 选中章节回调 */
  onSelectChapter: (id: string) => void;
  /** 点击"新建章节"按钮回调（父组件打开对话框） */
  onCreateClick: () => void;
  /** 删除章节回调（父组件弹出二次确认） */
  onDeleteChapter: (id: string) => void;
  /** 拖拽排序完成后回调，入参为新顺序的章节 ID 数组 */
  onReorder: (orderedIds: string[]) => void;
}

/**
 * 章节列表侧边栏
 *
 * @example
 * <ChapterList
 *   projectId={projectId}
 *   chapters={chapters}
 *   activeChapterId={activeChapterId}
 *   onSelectChapter={(id) => setActiveChapterId(id)}
 *   onCreateClick={() => setCreateOpen(true)}
 *   onDeleteChapter={(id) => setDeleteTarget(id)}
 *   onReorder={(ids) => void reorderAsync({ projectId, orderedIds: ids })}
 * />
 */
export function ChapterList({
  projectId: _projectId,
  chapters,
  activeChapterId,
  onSelectChapter,
  onCreateClick,
  onDeleteChapter,
  onReorder,
}: ChapterListProps): ReactElement {
  // 被拖拽章节的 ID（拖拽期间不为 null）
  const [draggedId, setDraggedId] = useState<string | null>(null);
  // 当前拖拽悬停的目标章节 ID（用于显示插入指示线）
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  /**
   * 拖拽开始：记录被拖拽的章节 ID
   * 通过 dataTransfer.effectAllowed = 'move' 告知浏览器允许移动操作
   */
  const handleDragStart = (e: DragEvent<HTMLDivElement>, id: string): void => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
    // dataTransfer.setData 是 HTML5 DnD 规范要求，部分浏览器需要才能触发 drop
    e.dataTransfer.setData('text/plain', id);
  };

  /**
   * 拖拽悬停：阻止默认行为允许 drop，并记录悬停目标 ID
   */
  const handleDragOver = (e: DragEvent<HTMLDivElement>, id: string): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (id !== dragOverId) {
      setDragOverId(id);
    }
  };

  /**
   * 拖拽放下：根据起止位置重排章节 ID 数组并上抛
   *
   * 算法：
   * 1. 从原数组中移除被拖拽项
   * 2. 找到目标项在新数组中的索引
   * 3. 把被拖拽项插入到目标项之前
   */
  const handleDrop = (e: DragEvent<HTMLDivElement>, targetId: string): void => {
    e.preventDefault();
    if (draggedId === null || draggedId === targetId) {
      // 同一项或无效拖拽：仅清理状态
      setDraggedId(null);
      setDragOverId(null);
      return;
    }
    // 复制章节列表，按现有顺序提取 ID
    const ids = chapters.map((c) => c.id);
    const fromIndex = ids.indexOf(draggedId);
    const toIndex = ids.indexOf(targetId);
    if (fromIndex === -1 || toIndex === -1) {
      setDraggedId(null);
      setDragOverId(null);
      return;
    }
    // 移除被拖拽项
    ids.splice(fromIndex, 1);
    // 插入到目标位置（splice 第二参数 0 表示插入不删除）
    ids.splice(toIndex, 0, draggedId);
    onReorder(ids);
    setDraggedId(null);
    setDragOverId(null);
  };

  /** 拖拽离开组件区域：清理悬停状态（不清理 draggedId，因为可能再回到列表） */
  const handleDragLeave = (): void => {
    setDragOverId(null);
  };

  /** 拖拽结束：兜底清理所有 DnD 状态 */
  const handleDragEnd = (): void => {
    setDraggedId(null);
    setDragOverId(null);
  };

  return (
    <aside className="bg-sidebar border-sidebar-border flex w-60 shrink-0 flex-col border-r">
      {/* 顶部新建章节按钮（虚线边框 + 深棕描边，参考 demo .new-chapter-btn） */}
      <div className="p-3">
        <button
          type="button"
          onClick={onCreateClick}
          className="text-muted-foreground hover:text-primary hover:bg-primary/4 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-xs transition-colors duration-150"
        >
          <Plus className="size-3.5" strokeWidth={1.5} />
          <span className="font-sans tracking-wide">新建章节</span>
        </button>
      </div>
      {/* 章节列表：ScrollArea 提供细滚动条 */}
      <ScrollArea className="flex-1">
        <ul className="flex flex-col gap-0.5 p-2" onDragLeave={handleDragLeave}>
          {chapters.map((chapter) => {
            const isActive = chapter.id === activeChapterId;
            const isDragging = chapter.id === draggedId;
            const isDragOver = chapter.id === dragOverId && draggedId !== null;
            return (
              <li key={chapter.id}>
                {/* biome-ignore lint/a11y/useSemanticElements: 外层需 draggable + 内含 DropdownMenu 触发 Button，HTML 不允许 button 嵌套 button，故用 div + role=button */}
                <div
                  role="button"
                  tabIndex={0}
                  draggable
                  onDragStart={(e) => handleDragStart(e, chapter.id)}
                  onDragOver={(e) => handleDragOver(e, chapter.id)}
                  onDrop={(e) => handleDrop(e, chapter.id)}
                  onDragEnd={handleDragEnd}
                  onClick={() => onSelectChapter(chapter.id)}
                  onKeyDown={(e) => {
                    // Enter / Space 触发选中，符合无障碍按钮语义
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectChapter(chapter.id);
                    }
                  }}
                  className={cn(
                    'group relative flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-150',
                    'hover:bg-sidebar-accent',
                    'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
                    // 激活态：暖米高亮 + 深棕文字
                    isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
                    isDragging && 'opacity-50',
                    // 拖拽插入指示线（顶部 2px 深棕边）
                    isDragOver && 'border-t-2 border-primary',
                  )}
                >
                  {/* 激活态左侧墨水条（3px 宽，深棕色，垂直居中） */}
                  {isActive && (
                    <span
                      aria-hidden
                      className="bg-primary absolute top-1/2 left-0.5 h-4 w-[3px] -translate-y-1/2 rounded-[1px]"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    {/* 章节标题用衬线字体（呼应文学风） */}
                    <p
                      className={cn(
                        'truncate font-serif tracking-wide',
                        isActive ? 'font-medium' : 'text-sidebar-foreground/85',
                      )}
                    >
                      {chapter.title}
                    </p>
                    {/* 字数用等宽字体（呼应"墨水计数"感） */}
                    <p className="text-muted-foreground mt-0.5 font-mono text-[10px] tracking-wider">
                      {formatWordCount(chapter.wordCount)}
                    </p>
                  </div>
                  {/* 操作菜单：触发器 stopPropagation 避免触发章节选中 */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 opacity-0 group-hover:opacity-100"
                        aria-label="章节操作"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreVertical className="size-3.5" strokeWidth={1.5} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteChapter(chapter.id);
                        }}
                      >
                        <Trash2 className="size-4" strokeWidth={1.5} />
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
    </aside>
  );
}
