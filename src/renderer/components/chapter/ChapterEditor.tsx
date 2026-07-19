// src/renderer/components/chapter/ChapterEditor.tsx
// TipTap 3 富文本编辑器封装
// 设计文档 §5.1 数据流 + §8 Phase 8 章节编辑器
//
// 职责：
// - 用 useEditor 创建 TipTap 编辑器实例（StarterKit + Placeholder + CharacterCount）
// - 章节切换时通过 editor.commands.setContent 重置内容（不发 onUpdate）
// - 内容变化通过 onUpdate 回调上抛 HTML + 字数（父组件做 debounce 自动保存）
// - 组件卸载时由 useEditor 内部自动 destroy 编辑器
//
// 注意：
// - immediatelyRender: false 是 TipTap 3 推荐配置，避免 React 19 SSR/hydration 警告
//   （Electron 渲染层虽然是纯 CSR，但遵循官方建议保持一致性）
// - useEditor 返回 Editor | null（immediatelyRender: false 时），需 null 兜底
// - 编辑器样式通过 EditorContent 的 className 注入（ProseMirror 实际 DOM 在 .ProseMirror 类下）
// - prose 类需 @tailwindcss/typography 插件，未安装时为 no-op，不影响功能
// - useEffect 仅依赖 chapter.id（不依赖 content），避免保存后查询刷新导致光标重置；
//   通过 ref 读取最新 content，规避 Biome useExhaustiveDependencies 警告

import type { Chapter } from '@novel-writer/shared';
import { CharacterCount } from '@tiptap/extension-character-count';
import { Placeholder } from '@tiptap/extension-placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

interface ChapterEditorProps {
  /** 当前选中章节（必填，由父组件保证非空） */
  chapter: Chapter;
  /**
   * 内容变化回调（父组件做 debounce 后调 useUpdateChapter）
   *
   * @param content - HTML 字符串
   * @param wordCount - 字数（来自 CharacterCount 扩展）
   */
  onContentChange: (content: string, wordCount: number) => void;
}

/**
 * TipTap 3 富文本编辑器
 *
 * @example
 * <ChapterEditor chapter={activeChapter} onContentChange={handleContentChange} />
 */
export function ChapterEditor({ chapter, onContentChange }: ChapterEditorProps): ReactElement {
  // 用 ref 保存最新 chapter.content，供 useEffect 在 chapter.id 变化时读取
  // 避免把 chapter.content 放入 useEffect 依赖数组（保存后查询刷新会重置光标）
  const contentRef = useRef(chapter.content);
  contentRef.current = chapter.content;

  // 创建编辑器实例：immediatelyRender: false 避免 React 19 hydration 警告
  // 返回类型为 Editor | null，需在 useEffect 中做 null 兜底
  const editor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder: '开始写作...' }), CharacterCount],
    content: chapter.content,
    immediatelyRender: false,
    onUpdate: ({ editor: ed }) => {
      const html = ed.getHTML();
      const count = ed.storage.characterCount.characters();
      onContentChange(html, count);
    },
  });

  // 章节切换时重置编辑器内容
  // TipTap 3 的 setContent 第二参数为 SetContentOptions 对象：
  // { emitUpdate: false } 表示不发 onUpdate 事件
  // （避免切换章节触发自动保存，因为新内容是已持久化的）
  // 依赖数组仅含 chapter.id + editor：只在切换章节或编辑器初始化时执行
  // biome-ignore lint/correctness/useExhaustiveDependencies: chapter.id 是触发章节切换重置内容的关键依赖，contentRef.current 为 ref 无需进入依赖
  useEffect(() => {
    if (editor === null || editor.isDestroyed) return;
    editor.commands.setContent(contentRef.current, { emitUpdate: false });
  }, [editor, chapter.id]);

  return (
    <div
      className={cn(
        'min-h-[60vh] flex-1 overflow-y-auto border-b p-6',
        'focus-within:border-primary focus-within:ring-ring/30 focus-within:ring-2',
      )}
    >
      <EditorContent editor={editor} className="prose prose-sm max-w-none focus:outline-none" />
    </div>
  );
}
