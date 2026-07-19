// src/renderer/routes/chapters.tsx
// 章节管理路由（章节工作台）
// 设计文档 §3 路由结构 + §5.1 数据流 + §8 Phase 8 章节编辑器
//
// 职责：
// - 通过 useChapterList 加载章节列表，渲染 Loading / Error / Empty / 工作台四种状态
// - 左侧 ChapterList：章节列表 + 拖拽排序 + 新建/删除入口
// - 右侧 ChapterToolbar + ChapterEditor：状态切换 + TipTap 3 富文本编辑
// - 自动保存：编辑器内容变化后 debounce 1500ms 调 useUpdateChapter
// - 切换章节前 flush 未保存内容（立即保存，不等 debounce）
//
// RR7 lazy 约定：模块需 export function Component（命名导出，非默认导出）

import type { ChapterStatus } from '@novel-writer/shared';
import { BookOpen } from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';

import { ChapterCreateDialog } from '@/components/chapter/ChapterCreateDialog';
import { ChapterEditor } from '@/components/chapter/ChapterEditor';
import { ChapterList } from '@/components/chapter/ChapterList';
import { ChapterToolbar } from '@/components/chapter/ChapterToolbar';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import {
  useChapterDetail,
  useChapterList,
  useDeleteChapter,
  useReorderChapters,
  useUpdateChapter,
} from '@/hooks/use-chapters';
import { handleIpcError } from '@/lib/handle-ipc-error';

/** 保存状态：idle 空闲 / saving 保存中 / saved 已保存 / error 保存失败 */
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** 自动保存 debounce 延迟（毫秒） */
const AUTOSAVE_DEBOUNCE_MS = 1500;

/** 保存成功后回到 idle 的延迟（毫秒） */
const SAVED_INDICATOR_MS = 2000;

/**
 * 章节管理页面
 *
 * 状态机：
 * - isLoading：展示 LoadingSpinner
 * - error：展示 ErrorState（带重试按钮）
 * - 空列表：展示 EmptyState + 新建对话框触发
 * - 正常：展示左侧章节列表 + 右侧工具栏与编辑器
 */
export function Component(): ReactElement {
  const { projectId } = useParams();
  // useParams 返回 string | undefined，hooks 接受 string | null | undefined
  // 此处直接透传，由 hook 内部 enabled 控制

  // 当前选中章节 ID（null 表示未选中，初始为 null，列表加载后自动选中第一个）
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  // 新建章节对话框开关
  const [createOpen, setCreateOpen] = useState(false);
  // 待删除章节 ID（null 表示未进入删除确认流程）
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  // 保存状态指示器
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  // 实时字数（来自编辑器 CharacterCount，工具栏显示用）
  const [wordCount, setWordCount] = useState(0);

  // debounce 定时器 ref（避免闭包陷阱，跨渲染保持最新引用）
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 待保存的内容 ref（onContentChange 写入，saveChapter 读取并清空）
  const pendingContentRef = useRef<{ content: string; wordCount: number } | null>(null);

  // 数据 hooks
  const { data: chapters, isLoading, error, refetch } = useChapterList(projectId);
  const { data: activeChapter } = useChapterDetail(activeChapterId);
  const { mutateAsync: updateAsync } = useUpdateChapter();
  const { mutateAsync: deleteAsync } = useDeleteChapter();
  const { mutateAsync: reorderAsync } = useReorderChapters();

  /**
   * 保存章节内容到后端
   *
   * @param id - 章节 ID
   * @param data - 待保存的 content + wordCount
   */
  const saveChapter = async (
    id: string,
    data: { content: string; wordCount: number },
  ): Promise<void> => {
    setSaveStatus('saving');
    try {
      await updateAsync({ id, content: data.content, wordCount: data.wordCount });
      // 保存成功：清空 pending，2 秒后回到 idle
      pendingContentRef.current = null;
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), SAVED_INDICATOR_MS);
    } catch (err) {
      handleIpcError(err);
      setSaveStatus('error');
    }
  };

  // 用 ref 保存最新的 saveChapter，避免 useEffect cleanup 中的闭包陷阱
  // （cleanup 在 activeChapterId 变化时执行，捕获的是旧 saveChapter，可能闭包过期）
  const saveChapterRef = useRef(saveChapter);
  saveChapterRef.current = saveChapter;

  /**
   * 章节切换前 flush 未保存内容
   *
   * 依赖 activeChapterId：当 ID 变化时，cleanup 用旧 ID 立即保存待保存内容
   * （不等 debounce，避免切换章节丢失编辑）
   */
  useEffect(() => {
    return () => {
      if (pendingContentRef.current && activeChapterId) {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        // 切换前立即保存（通过 ref 调用最新 saveChapter，避免闭包陷阱）
        void saveChapterRef.current(activeChapterId, pendingContentRef.current);
      }
    };
  }, [activeChapterId]);

  /**
   * 自动选中第一个章节
   *
   * 当章节列表加载完成且 activeChapterId 为 null 时，选中第一个章节
   * 也处理 active chapter 被删除后自动切换到第一个可用章节
   */
  useEffect(() => {
    if (chapters === undefined) return;
    if (chapters.length === 0) {
      // 列表为空：清空选中
      if (activeChapterId !== null) {
        setActiveChapterId(null);
      }
      return;
    }
    // activeChapterId 为 null 或不在列表中（已删除）→ 选中第一个
    const exists = activeChapterId !== null && chapters.some((c) => c.id === activeChapterId);
    if (!exists) {
      const first = chapters[0];
      if (first) {
        setActiveChapterId(first.id);
      }
    }
  }, [chapters, activeChapterId]);

  /**
   * 章节切换时重置实时字数（来自章节详情的 wordCount）
   *
   * 依赖 activeChapter：当详情加载完成或刷新时同步字数
   * 注意：保存后查询刷新也会触发，但保存值与编辑器一致，setWordCount 为 no-op
   */
  useEffect(() => {
    if (activeChapter) {
      setWordCount(activeChapter.wordCount);
    }
  }, [activeChapter]);

  /**
   * 编辑器内容变化回调（由 ChapterEditor 的 onUpdate 触发）
   *
   * 1. 更新实时字数状态（工具栏显示）
   * 2. 写入 pendingContentRef（供 debounce 保存读取）
   * 3. 重置 debounce 定时器，1500ms 后调 saveChapter
   */
  const handleContentChange = (content: string, newWordCount: number): void => {
    setWordCount(newWordCount);
    pendingContentRef.current = { content, wordCount: newWordCount };
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      if (activeChapterId && pendingContentRef.current) {
        void saveChapter(activeChapterId, pendingContentRef.current);
      }
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  /** 拖拽排序回调：调用 useReorderChapters 持久化新顺序 */
  const handleReorder = (orderedIds: string[]): void => {
    if (!projectId) return;
    void reorderAsync({ projectId, orderedIds }).catch(handleIpcError);
  };

  /** 状态切换回调：立即保存 status 字段（独立于内容自动保存） */
  const handleStatusChange = (status: ChapterStatus): void => {
    if (!activeChapter) return;
    void updateAsync({ id: activeChapter.id, status }).catch(handleIpcError);
  };

  /** 删除章节：由 ConfirmDialog 确认后执行 */
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
    return <LoadingSpinner label="正在加载章节列表..." />;
  }

  // 加载失败：展示错误信息 + 重试按钮
  if (error) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  // 空列表：引导用户新建第一章
  if (chapters === undefined || chapters.length === 0) {
    return (
      <>
        <div className="mx-auto max-w-4xl p-6">
          <EmptyState
            icon={<BookOpen className="size-6" />}
            title="还没有章节"
            description="开始你的第一章创作"
            actionLabel="新建章节"
            onAction={() => setCreateOpen(true)}
          />
        </div>
        <ChapterCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          projectId={projectId ?? ''}
          nextSortOrder={0}
        />
      </>
    );
  }

  // 计算新建章节的 sortOrder（当前最大 + 1）
  const nextSortOrder = chapters.reduce((max, c) => Math.max(max, c.sortOrder), -1) + 1;

  return (
    <div className="flex h-full">
      {/* 左侧：章节列表侧边栏（固定宽度 240px） */}
      <ChapterList
        projectId={projectId ?? ''}
        chapters={chapters}
        activeChapterId={activeChapterId}
        onSelectChapter={setActiveChapterId}
        onCreateClick={() => setCreateOpen(true)}
        onDeleteChapter={(id) => setDeleteTarget(id)}
        onReorder={handleReorder}
      />
      {/* 右侧：工具栏 + 编辑器 */}
      <main className="flex min-w-0 flex-1 flex-col">
        {activeChapter ? (
          <>
            <ChapterToolbar
              chapter={activeChapter}
              onStatusChange={handleStatusChange}
              wordCount={wordCount}
              saveStatus={saveStatus}
            />
            <ChapterEditor chapter={activeChapter} onContentChange={handleContentChange} />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState title="请选择左侧章节" description="从左侧列表选择一个章节开始编辑" />
          </div>
        )}
      </main>
      {/* 新建章节对话框（受控） */}
      <ChapterCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId ?? ''}
        nextSortOrder={nextSortOrder}
      />
      {/* 删除二次确认对话框 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="删除章节"
        description="确定删除此章节？章节内容将永久丢失，此操作不可恢复。"
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}

// RR7 lazy 约定的 display name
Component.displayName = 'ChaptersPage';
