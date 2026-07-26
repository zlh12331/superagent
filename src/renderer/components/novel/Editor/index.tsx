// src/renderer/components/novel/Editor/index.tsx
// Markdown 编辑器组件
// ──────────────────────────────────────────────────────────────
// 职责：
// - textarea 编辑器 + 底部字数统计
// - 自动保存（每 30 秒）
// - 全屏写作模式
// ──────────────────────────────────────────────────────────────

import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

interface EditorProps {
  title: string;
  content: string;
  projectId: string;
  chapterId: string;
  onSave: (content: string, title?: string) => Promise<void>;
}

export function Editor({ title, content, projectId: _projectId, chapterId: _chapterId, onSave }: EditorProps): ReactElement {
  const [text, setText] = useState(content);
  const [chapterTitle, setChapterTitle] = useState(title);
  const [fullscreen, setFullscreen] = useState(false);
  const [saving, setSaving] = useState(false);
  const lastSavedRef = useRef(content);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 统计字数（中英文混合）
  const wordCount = [...text].length;

  // 自动保存
  const doSave = useCallback(async () => {
    if (text === lastSavedRef.current) return;
    setSaving(true);
    try {
      await onSave(text, chapterTitle);
      lastSavedRef.current = text;
    } catch {
      // toast 已在父组件处理
    } finally {
      setSaving(false);
    }
  }, [text, chapterTitle, onSave]);

  // 每 30 秒自动保存
  useEffect(() => {
    if (autoSaveTimerRef.current !== null) {
      clearTimeout(autoSaveTimerRef.current);
    }
    autoSaveTimerRef.current = setTimeout(() => {
      void doSave();
    }, 30000);
    return () => {
      if (autoSaveTimerRef.current !== null) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [doSave]);

  // Ctrl+S 手动保存
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        void doSave();
        toast.success('已保存');
      }
      // F11 全屏切换
      if (event.key === 'F11') {
        event.preventDefault();
        setFullscreen((prev) => !prev);
      }
      // Esc 退出全屏
      if (event.key === 'Escape' && fullscreen) {
        setFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [doSave, fullscreen]);

  return (
    <div className={`flex flex-col ${fullscreen ? 'fixed inset-0 z-50 bg-background' : 'flex-1'}`}>
      {/* 标题栏 */}
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <input
          className="text-foreground flex-1 bg-transparent text-sm font-medium outline-none"
          value={chapterTitle}
          onChange={(e) => setChapterTitle(e.target.value)}
          placeholder="章节标题"
        />
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground rounded px-2 py-1 text-xs transition-colors"
          onClick={() => setFullscreen((prev) => !prev)}
        >
          {fullscreen ? '退出全屏' : '全屏'}
        </button>
        {saving && <span className="text-muted-foreground text-xs">保存中...</span>}
      </div>

      {/* 编辑器主体 */}
      <textarea
        className="text-foreground flex-1 resize-none border-0 bg-transparent p-4 text-sm leading-relaxed outline-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="开始写作..."
      />

      {/* 底部统计 */}
      <div className="flex items-center justify-between border-t px-4 py-1.5">
        <span className="text-muted-foreground text-xs">
          {wordCount} 字
        </span>
        <div className="flex gap-3">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground rounded px-2 py-0.5 text-xs transition-colors"
            onClick={() => void doSave()}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

export default Editor;
