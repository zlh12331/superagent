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
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { getHighlighter, normalizeLang } from '@/components/chat/Markdown';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useFileContent } from '@/hooks/use-file-content';
import { useFileWrite } from '@/hooks/use-file-write';
import { cn } from '@/lib/utils';
import { useTheme } from '@/providers/ThemeProvider';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';

/**
 * 文件扩展名 → shiki 语言 ID 映射
 *
 * 仅映射与 shiki 预加载语言名不一致的情况（如 .ts → typescript 已对齐，无需在此列出）。
 * 未列出的扩展名将直接用扩展名去 normalizeLang（shiki 已知 lang id 时直接生效）。
 */
const EXT_TO_LANG: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
};

/**
 * 从文件路径推断 shiki 语言 ID
 *
 * 取最后一个 . 后的扩展名，转小写后查表；未命中时返回 'text'。
 * 无扩展名或未知扩展名 → 'text'（不高亮，但保留 pre 格式）。
 */
function detectLangFromPath(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) return 'text';
  const ext = filePath.slice(lastDot + 1).toLowerCase();
  const raw = EXT_TO_LANG[ext] ?? ext;
  return normalizeLang(raw);
}

/**
 * 从绝对路径提取 basename（兼容 Windows 反斜杠与 POSIX 正斜杠）
 */
function basename(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const lastBackslash = path.lastIndexOf('\\');
  const idx = Math.max(lastSlash, lastBackslash);
  if (idx === -1) return path;
  return path.slice(idx + 1);
}

/**
 * 文件查看器对话框
 *
 * 全局单例（挂载在 AppShell 根级），通过 useFileViewerStore 控制开关。
 * FileTreePanel 调用 store.openFile(path) 即可弹出本对话框。
 *
 * 双模式切换：
 * - 查看模式（默认）：shiki 高亮只读
 * - 编辑模式：textarea + shiki 叠加高亮，Ctrl+S 保存
 */
export function FileViewerDialog(): ReactElement {
  // 受控状态
  const open = useFileViewerStore((s) => s.open);
  const filePath = useFileViewerStore((s) => s.filePath);
  const close = useFileViewerStore((s) => s.close);

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

  // 推断语言（filePath 变化时重新计算）
  const lang = useMemo(
    () => (filePath !== null ? detectLangFromPath(filePath) : 'text'),
    [filePath],
  );

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
  const handleCopy = useCallback(async () => {
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
      toast.error('复制失败：剪贴板不可用');
    }
  }, [displayContent]);

  // 保存处理
  const handleSave = useCallback(async () => {
    if (filePath === null || !isDirty || isSaving) return;
    try {
      await saveFile({
        path: filePath,
        content: editedContent,
        append: false,
        createDirs: false,
      });
      markSaved();
      toast.success('已保存', { description: basename(filePath) });
    } catch {
      // onError 已在 use-file-write 中 toast 错误
    }
  }, [filePath, isDirty, isSaving, editedContent, saveFile, markSaved]);

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
  }, [editMode, open, handleSave]);

  // Dialog 关闭回调（Esc / 点击遮罩 / 点关闭按钮）
  // 脏数据保护：未保存时阻止关闭，提示用户
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        if (isDirty) {
          // 用 confirm 避免引入复杂确认对话框
          // 项目惯例：sonner toast 用于通知，confirm 用于阻塞式确认
          const confirmed = window.confirm('有未保存的修改，确定要关闭吗？');
          if (!confirmed) return;
          // 用户确认丢弃修改
          exitEditMode();
        }
        close();
      }
    },
    [close, isDirty, exitEditMode],
  );

  // textarea ref（用于滚动同步）
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  // textarea 滚动同步：编辑态下滚动 textarea 时同步高亮层
  const handleTextareaScroll = useCallback(() => {
    if (textareaRef.current !== null && highlightRef.current !== null) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  // 渲染
  const fileName = filePath !== null ? basename(filePath) : '';
  const totalLines = data?.totalLines ?? displayContent.split('\n').length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="file-viewer-dialog sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText size={16} strokeWidth={1.75} className="text-accent" />
            <span className="font-serif">{fileName}</span>
            {editMode && (
              <span className="file-viewer-edit-badge">
                <Pencil size={10} strokeWidth={2} />
                <span>编辑中</span>
              </span>
            )}
            {isDirty && <span className="file-viewer-dirty-dot" title="未保存" />}
          </DialogTitle>
          <DialogDescription className="font-mono text-[10px] break-all opacity-70">
            {filePath}
          </DialogDescription>
        </DialogHeader>

        {/* 工具栏：行数 + 模式切换 + 复制/保存按钮 */}
        <div className="file-viewer-toolbar">
          <span className="file-viewer-meta">
            {totalLines} 行{lang !== 'text' ? ` · ${lang}` : ''}
          </span>
          <div className="file-viewer-actions">
            {/* 模式切换按钮 */}
            {!editMode ? (
              <button
                type="button"
                className="file-viewer-mode-btn"
                onClick={enterEditMode}
                disabled={isLoading || error !== null}
                title="切换到编辑模式"
                aria-label="切换到编辑模式"
              >
                <Pencil size={12} />
                <span>编辑</span>
              </button>
            ) : (
              <button
                type="button"
                className="file-viewer-mode-btn"
                onClick={() => {
                  if (isDirty) {
                    const confirmed = window.confirm('退出编辑模式将丢弃未保存的修改，确定吗？');
                    if (!confirmed) return;
                  }
                  exitEditMode();
                }}
                title="切换到查看模式"
                aria-label="切换到查看模式"
              >
                <Eye size={12} />
                <span>查看</span>
              </button>
            )}

            {/* 保存按钮（仅编辑态可见） */}
            {editMode && (
              <button
                type="button"
                className={cn('file-viewer-save-btn', isDirty && 'dirty')}
                onClick={handleSave}
                disabled={!isDirty || isSaving}
                title="保存 (Ctrl+S)"
                aria-label="保存"
              >
                {isSaving ? (
                  <span className="file-viewer-spinner" role="status" />
                ) : (
                  <Save size={12} />
                )}
                <span>{isSaving ? '保存中…' : '保存'}</span>
              </button>
            )}

            {/* 复制按钮（始终可见） */}
            <button
              type="button"
              className={cn('file-viewer-copy-btn', copied && 'copied')}
              onClick={handleCopy}
              disabled={displayContent === ''}
              aria-label={copied ? '已复制' : '复制内容'}
              title={copied ? '已复制' : '复制内容'}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
          </div>
        </div>

        {/* 内容区：加载中 / 错误 / 高亮代码 / 编辑态 */}
        <div className="file-viewer-body">
          {isLoading ? (
            <div className="file-viewer-loading">加载中…</div>
          ) : error !== null ? (
            <div className="file-viewer-error">
              <p>加载失败</p>
              <p className="file-viewer-error-detail">
                {error instanceof Error ? error.message : String(error)}
              </p>
            </div>
          ) : displayContent === '' ? (
            <div className="file-viewer-empty">{editMode ? '空文件，开始编辑…' : '空文件'}</div>
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
                aria-label={`编辑 ${fileName}`}
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
      </DialogContent>
    </Dialog>
  );
}
