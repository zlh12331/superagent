// src/renderer/components/file-tree/FileViewerDialog.tsx
// 文件预览对话框 · 组装层（语言检测/文件名提取纯函数移至 file-viewer-utils）
// ──────────────────────────────
// 拆分背景（2026-08 重构）：原文件 427 行，纯函数提取为独立文件
// ──────────────────────────────

// src/renderer/components/file-tree/FileViewerDialog.tsx
// 文件查看器对话框（点击文件树中的文件后弹出）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 受控 Dialog（open 状态来自 useFileViewerStore）
// - 通过 useFileContent 拉取文件内容（TanStack Query 缓存）
// - 双模式：只读查看（shiki 高亮） / 编辑（textarea + shiki 叠加高亮）
// - 复制按钮 + 文件路径面包屑 + 行数显示
// - Ctrl+S 保存 + 脏数据未保存时阻止关闭
//
// 设计：
// - 编辑态用 textarea + shiki 叠加方案（零新依赖，符合项目惯例避免 Monaco/CodeMirror）
//   textarea 文字透明、caret 不透明，与下层 shiki 高亮对齐
// - 主题跟随：shiki 双主题（github-dark / github-light）随 useTheme 切换
// - 路径推断语言：基于扩展名映射到 shiki 标准 lang ID
// ──────────────────────────────────────────────────────────────

import { Check, Copy, Eye, FileText, Pencil, Save } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { getHighlighter } from '@/components/chat/Markdown';
import { useFileContent } from '@/hooks/use-file-content';

import { useFileWrite } from '@/hooks/use-file-write';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useTheme } from '@/providers/ThemeProvider';
import { confirm } from '@/stores/transient/confirm-dialog-store';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';

import { basename, detectLangFromPath } from './file-viewer-utils';

export function FileViewerPanel(): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 受控状态
  const open = useFileViewerStore((s) => s.open);
  const filePath = useFileViewerStore((s) => s.filePath);

  // 编辑模式状态
  const editMode = useFileViewerStore((s) => s.editMode);
  const isDirty = useFileViewerStore((s) => s.isDirty);
  const originalContent = useFileViewerStore((s) => s.originalContent);
  const editedContent = useFileViewerStore((s) => s.editedContent);
  const setLoadedContent = useFileViewerStore((s) => s.setLoadedContent);
  const enterEditMode = useFileViewerStore((s) => s.enterEditMode);
  const exitEditMode = useFileViewerStore((s) => s.exitEditMode);
  const setEditedContent = useFileViewerStore((s) => s.setEditedContent);
  const markSaved = useFileViewerStore((s) => s.markSaved);

  // 拉取文件内容（filePath 为 null 时跳过查询）
  const { data, isLoading, error } = useFileContent(open ? filePath : null);

  // 写入 mutation
  const { mutateAsync: saveFile, isPending: isSaving } = useFileWrite();

  // 主题跟随
  const { resolvedTheme } = useTheme();
  const theme: 'github-dark' | 'github-light' =
    resolvedTheme === 'dark' ? 'github-dark' : 'github-light';

  // 推断语言（filePath 变化时重新计算，React Compiler 自动缓存）
  const lang = filePath !== null ? detectLangFromPath(filePath) : 'text';

  // IPC 数据到达后同步到 store
  useEffect(() => {
    if (data !== undefined) {
      // 仅在 originalContent 为空或与当前 data.content 不同时同步，
      // 避免编辑态时 useQuery 后台刷新覆盖用户未保存的修改
      if (!isDirty) {
        setLoadedContent(data.content);
      }
    }
  }, [data, isDirty, setLoadedContent]);

  // shiki 异步高亮（基于当前显示的内容：编辑态用 editedContent，查看态用 originalContent）
  const [html, setHtml] = useState<string | null>(null);
  const displayContent = editMode ? editedContent : originalContent;
  useEffect(() => {
    if (displayContent === '' || open === false) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    getHighlighter()
      .then((h) => {
        if (cancelled) return;
        try {
          const result = h.codeToHtml(displayContent, { lang, theme });
          setHtml(result);
        } catch {
          // lang 不支持等异常：降级为纯文本 pre
          setHtml(null);
        }
      })
      .catch(() => {
        setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [displayContent, lang, theme, open]);

  // 复制按钮
  const [copied, setCopied] = useState(false);
  // copy 按钮 2s 复位定时器：组件卸载时清理，避免 setState on unmounted component 内存泄漏
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );
  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(displayContent);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 2000);
    } catch {
      toast.error(t('fileViewer.copyFailed'));
    }
  };

  // 保存处理
  const handleSave = async (): Promise<void> => {
    if (filePath === null || !isDirty || isSaving) return;
    try {
      await saveFile({
        path: filePath,
        content: editedContent,
        append: false,
        createDirs: false,
      });
      markSaved();
      toast.success(t('fileViewer.saved'), { description: basename(filePath) });
    } catch {
      // onError 已在 use-file-write 中 toast 错误
    }
  };

  // Ctrl+S / Cmd+S 快捷键保存
  useEffect(() => {
    if (!editMode || !open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const isSaveShortcut = (e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S');
      if (isSaveShortcut) {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // biome-ignore lint/correctness/useExhaustiveDependencies: React Compiler 自动缓存 handleSave（依赖不变时引用稳定），无需 useCallback；未缓存时重复绑定仅低效不错误
  }, [editMode, open, handleSave]);

  // textarea ref（用于滚动同步）
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  // textarea 滚动同步：编辑态下滚动 textarea 时同步高亮层
  const handleTextareaScroll = (): void => {
    if (textareaRef.current !== null && highlightRef.current !== null) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  };

  // 渲染
  const fileName = filePath !== null ? basename(filePath) : '';
  const totalLines = data?.totalLines ?? displayContent.split('\n').length;

  // 未选择文件时显示引导（右面板"文件"tab 空态）
  if (!open) {
    return (
      <div className="text-muted-foreground/60 flex h-full flex-col items-center justify-center gap-1.5 p-3 text-xs">
        <FileText className="size-4" strokeWidth={1.5} />
        {t('fileViewer.selectFile')}
      </div>
    );
  }

  return (
    <div className="file-viewer-panel flex h-full flex-col">
      {/* 标题：文件名 + 编辑态 badge + 脏数据标记 + 完整路径 */}
      <div className="file-viewer-header flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <FileText size={16} strokeWidth={1.75} className="text-accent" />
        <span className="font-serif">{fileName}</span>
        {editMode && (
          <span className="file-viewer-edit-badge">
            <Pencil size={10} strokeWidth={2} />
            <span>{t('fileViewer.editor')}</span>
          </span>
        )}
        {isDirty && <span className="file-viewer-dirty-dot" title={t('fileViewer.unsaved')} />}
        <span
          className="text-muted-foreground/70 ml-auto min-w-0 flex-1 truncate text-right font-mono text-2xs"
          title={filePath ?? undefined}
        >
          {filePath}
        </span>
      </div>

      {/* 工具栏：行数 + 模式切换 + 复制/保存按钮 */}
      <div className="file-viewer-toolbar">
        <span className="file-viewer-meta">
          {totalLines} {t('fileViewer.lines', { count: totalLines })}
          {lang !== 'text' ? ` · ${lang}` : ''}
        </span>
        <div className="file-viewer-actions">
          {/* 模式切换按钮 */}
          {!editMode ? (
            <button
              type="button"
              className="file-viewer-mode-btn"
              onClick={enterEditMode}
              disabled={isLoading || error !== null}
              title={t('fileViewer.switchToEdit')}
              aria-label={t('fileViewer.switchToEdit')}
            >
              <Pencil size={12} />
              <span>{t('fileViewer.edit')}</span>
            </button>
          ) : (
            <button
              type="button"
              className="file-viewer-mode-btn"
              onClick={async () => {
                if (isDirty) {
                  const confirmed = await confirm({
                    title: t('fileViewer.unsaved'),
                    message: t('fileViewer.confirmExitEdit'),
                    danger: true,
                  });
                  if (!confirmed) return;
                }
                exitEditMode();
              }}
              title={t('fileViewer.switchToPreview')}
              aria-label={t('fileViewer.switchToPreview')}
            >
              <Eye size={12} />
              <span>{t('fileViewer.view')}</span>
            </button>
          )}

          {/* 保存按钮（仅编辑态可见） */}
          {editMode && (
            <button
              type="button"
              className={cn('file-viewer-save-btn', isDirty && 'dirty')}
              onClick={handleSave}
              disabled={!isDirty || isSaving}
              title={`${t('common.save')} (Ctrl+S)`}
              aria-label={t('common.save')}
            >
              {isSaving ? (
                <span className="file-viewer-spinner" role="status" />
              ) : (
                <Save size={12} />
              )}
              <span>{isSaving ? t('fileViewer.saving') : t('common.save')}</span>
            </button>
          )}

          {/* 复制按钮（始终可见） */}
          <button
            type="button"
            className={cn('file-viewer-copy-btn', copied && 'copied')}
            onClick={handleCopy}
            disabled={displayContent === ''}
            aria-label={copied ? t('common.copied') : t('fileViewer.copyContent')}
            title={copied ? t('common.copied') : t('fileViewer.copyContent')}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span>{copied ? t('common.copied') : t('common.copy')}</span>
          </button>
        </div>
      </div>

      {/* 内容区：文件内容（侧边栏文件树已提供目录导航——面板只显示内容） */}
      <div className="file-viewer-layout">
        <div className="file-viewer-body">
          {isLoading ? (
            <div className="file-viewer-loading">{t('common.loading')}</div>
          ) : error !== null ? (
            <div className="file-viewer-error">
              <p>{t('common.fileLoadFailed')}</p>
              <p className="file-viewer-error-detail">
                {error instanceof Error ? error.message : String(error)}
              </p>
            </div>
          ) : displayContent === '' ? (
            <div className="file-viewer-empty">
              {editMode ? t('common.emptyFileEdit') : t('common.emptyFile')}
            </div>
          ) : editMode ? (
            // 编辑态：textarea + shiki 叠加
            <div className="file-viewer-editor">
              {/* 高亮层（背景，pointer-events: none） */}
              {html !== null && (
                <div
                  ref={highlightRef}
                  className="file-viewer-editor-highlight"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki 输出为可信的语法高亮 HTML
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              )}
              {/* textarea 层（前景，文字透明、caret 不透明） */}
              <textarea
                ref={textareaRef}
                className="file-viewer-editor-textarea"
                value={editedContent}
                onChange={(e) => setEditedContent(e.target.value)}
                onScroll={handleTextareaScroll}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                wrap="off"
                aria-label={t('chat.editFileLabel', { name: fileName })}
              />
            </div>
          ) : html !== null ? (
            // 查看态：shiki 高亮
            // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki 输出为可信的语法高亮 HTML（不来自用户输入）
            <div className="file-viewer-code" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className="file-viewer-plaintext">
              <code>{displayContent}</code>
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
