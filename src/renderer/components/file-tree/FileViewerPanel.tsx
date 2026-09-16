// src/renderer/components/file-tree/FileViewerPanel.tsx
// 文件查看器面板（右面板「文件」tab 内容）· 组装层
// ──────────────────────────────────────────────────────────────
// 职责：
// - 受控视图（open / filePath 来自 useFileViewerStore）
// - 通过 useFileContent 拉取文件内容（TanStack Query 缓存）
// - 双模式：只读查看（shiki 高亮） / 编辑（textarea + shiki 叠加高亮）
// - 复制按钮 + 文件路径 + 行数显示
// - Ctrl+S 保存 + 脏数据未保存时阻止退出编辑
//
// 设计：
// - 编辑态用 textarea + shiki 叠加方案（零新依赖，符合项目惯例避免 Monaco/CodeMirror）
//   textarea 文字透明、caret 不透明，与下层 shiki 高亮对齐
// - 主题跟随：shiki 双主题（github-dark / github-light）随 useTheme 切换
// - 路径推断语言：基于扩展名映射到 shiki 标准 lang ID
//
// 拆分背景（2026-08 重构）：原文件 427 行，纯函数提取为 file-viewer-utils
// ──────────────────────────────────────────────────────────────

import { Check, Copy, Eye, FileText, Pencil, Save } from 'lucide-react';
import { type ReactElement, type RefObject, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/ui/spinner';
import { useCopy } from '@/hooks/use-copy';
import { useFileContent } from '@/hooks/use-file-content';
import { useFileWrite } from '@/hooks/use-file-write';
import { useTranslation } from '@/i18n/use-translation';
import { ensureLangLoaded, getHighlighter } from '@/lib/highlight';
import { basename, cn } from '@/lib/utils';
import { useTheme } from '@/providers/ThemeProvider';
import { confirm } from '@/stores/transient/confirm-dialog-store';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';

import { detectLangFromPath, lineCount } from './file-viewer-utils';

/** 大文件高亮降级阈值（行）：shiki 整文件 tokenize 超过则跳过高亮渲染纯文本 */
const MAX_HIGHLIGHT_LINES = 5000;

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
    // 大文件降级（2026-08 性能审计）：shiki 整文件 tokenize 在大文件上主线程卡顿
    // （2MB 上限内仍可近 2 万行）；超过阈值跳过高亮渲染纯文本，保 UI 流畅
    if (displayContent.split('\n').length > MAX_HIGHLIGHT_LINES) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const h = await getHighlighter();
        if (cancelled) return;
        // 2026-09 优化：首见延迟语言（go/rust 等）按需 loadLanguage，而非静态降级 'text'
        await ensureLangLoaded(h, lang);
        if (cancelled) return;
        const result = h.codeToHtml(displayContent, { lang, theme });
        setHtml(result);
      } catch {
        // lang 不支持等异常：降级为纯文本 pre
        if (!cancelled) setHtml(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [displayContent, lang, theme, open]);

  // 复制反馈统一走 useCopy（copied 2s 复位 + 失败 toast，文案收敛 common.copyFailed）
  const { copied, copy } = useCopy();
  const handleCopy = async (): Promise<void> => {
    await copy(displayContent);
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

  // 全局 Ctrl+S 桥接：编辑态打开时把 handleSave 注册到 file-viewer-store，
  // AppShell 的全局快捷键（settings.shortcuts.saveFile，可自定义）→ requestSave() 触发；
  // 关闭/退出编辑态/卸载时注销，避免无查看器时快捷键误触。
  useEffect(() => {
    if (!editMode || !open) {
      useFileViewerStore.getState().registerSaveHandler(null);
      return undefined;
    }
    useFileViewerStore.getState().registerSaveHandler(() => {
      void handleSave();
    });
    return () => useFileViewerStore.getState().registerSaveHandler(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: React Compiler 自动缓存 handleSave（依赖不变时引用稳定），无需 useCallback；未缓存时重复注册仅低效不错误
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
  // 行数：查看态优先用 IPC 返回的 totalLines（磁盘权威值，空文件为 0）；
  // 编辑态必须随编辑缓冲实时变化——此前固定显示磁盘行数，增删行后工具栏数字陈旧
  const totalLines = editMode
    ? lineCount(editedContent)
    : (data?.totalLines ?? lineCount(displayContent));

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
      <ViewerHeader fileName={fileName} filePath={filePath} editMode={editMode} isDirty={isDirty} />

      <ViewerToolbar
        totalLines={totalLines}
        lang={lang}
        editMode={editMode}
        isDirty={isDirty}
        isSaving={isSaving}
        copied={copied}
        contentEmpty={displayContent === ''}
        editDisabled={isLoading || error !== null}
        onEnterEdit={enterEditMode}
        onExitEdit={exitEditMode}
        onSave={() => void handleSave()}
        onCopy={() => void handleCopy()}
      />

      {/* 内容区：文件内容（侧边栏文件树已提供目录导航——面板只显示内容） */}
      <div className="file-viewer-layout">
        <div className="file-viewer-body">
          <ViewerBody
            isLoading={isLoading}
            error={error}
            editMode={editMode}
            content={displayContent}
            html={html}
            fileName={fileName}
            editor={{
              value: editedContent,
              onChange: setEditedContent,
              textareaRef,
              highlightRef,
              onScroll: handleTextareaScroll,
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ── 子组件：内容区五态分派 ────────────────────────────────────

/** 编辑态 DOM 绑定（textarea 与其下方 shiki 高亮叠加层） */
interface EditorBindings {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly highlightRef: RefObject<HTMLDivElement | null>;
  readonly onScroll: () => void;
}

interface EditorViewProps extends EditorBindings {
  readonly html: string | null;
  readonly fileName: string;
}

/**
 * 编辑态视图：shiki 高亮做背景层，textarea 做前景层
 * （文字透明、caret 不透明，与下层高亮逐行对齐）
 */
function EditorView({
  value,
  onChange,
  textareaRef,
  highlightRef,
  onScroll,
  html,
  fileName,
}: EditorViewProps): ReactElement {
  const { t } = useTranslation();
  return (
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
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={onScroll}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        // 空文件在编辑态给一句引导（textarea 自身无内容时全空，用户不知可输入）
        {...(value === '' ? { placeholder: t('common.emptyFileEdit') } : {})}
        aria-label={t('chat.editFileLabel', { name: fileName })}
      />
    </div>
  );
}

interface ViewerBodyProps {
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly editMode: boolean;
  /** 当前显示内容（查看态为磁盘原文，编辑态为编辑缓冲） */
  readonly content: string;
  readonly html: string | null;
  readonly fileName: string;
  readonly editor: EditorBindings;
}

/**
 * 内容区五态分派（加载 / 错误 / 编辑态 / 空内容 / 只读高亮 / 纯文本）
 *
 * 分派优先级（2026-09 file-tree 审计修正）：**编辑态优先于空内容**。
 * 此前空内容分支排在编辑态之前，导致「新建空文件 → 点编辑」后既拿不到
 * textarea、也没有别的输入面（只显示"空文件"占位），空文件永远无法写入内容——
 * 文件树能新建空文件而查看器无法编辑它，是端到端死路。
 * 查看态的空内容占位（emptyFile）保持不变。
 *
 * 抽离动机：此前是五层嵌套三元直接内联在 FileViewerPanel 的 JSX 中，
 * 使该组件认知复杂度达 46（门禁阈值 15）。改用早返回后主组件与子组件双双回落到阈值内。
 */
function ViewerBody({
  isLoading,
  error,
  editMode,
  content,
  html,
  fileName,
  editor,
}: ViewerBodyProps): ReactElement {
  const { t } = useTranslation();
  if (isLoading) return <div className="file-viewer-loading">{t('common.loading')}</div>;
  if (error !== null) {
    return (
      <div className="file-viewer-error">
        <p>{t('common.fileLoadFailed')}</p>
        <p className="file-viewer-error-detail">
          {error instanceof Error ? error.message : String(error)}
        </p>
      </div>
    );
  }
  // 编辑态优先：空文件也必须可编辑（textarea 为空串即可正常输入）
  if (editMode) {
    return <EditorView {...editor} html={html} fileName={fileName} />;
  }
  if (content === '') {
    return <div className="file-viewer-empty">{t('common.emptyFile')}</div>;
  }
  if (html !== null) {
    return (
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki 输出为可信的语法高亮 HTML（不来自用户输入）
      <div className="file-viewer-code" dangerouslySetInnerHTML={{ __html: html }} />
    );
  }
  return (
    <pre className="file-viewer-plaintext">
      <code>{content}</code>
    </pre>
  );
}

// ── 子组件：标题栏 / 工具栏 ──────────────────────────────────

interface ViewerHeaderProps {
  readonly fileName: string;
  readonly filePath: string | null;
  readonly editMode: boolean;
  readonly isDirty: boolean;
}

/** 标题栏：文件名 + 编辑态 badge + 未保存标记 + 完整路径 */
function ViewerHeader({ fileName, filePath, editMode, isDirty }: ViewerHeaderProps): ReactElement {
  const { t } = useTranslation();
  return (
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
  );
}

interface ViewerToolbarProps {
  readonly totalLines: number;
  readonly lang: string;
  readonly editMode: boolean;
  readonly isDirty: boolean;
  readonly isSaving: boolean;
  readonly copied: boolean;
  /** 内容为空的判定（空内容时禁用复制） */
  readonly contentEmpty: boolean;
  /** 内容尚未就绪（加载中 / 出错）时禁用「编辑」入口 */
  readonly editDisabled: boolean;
  readonly onEnterEdit: () => void;
  readonly onExitEdit: () => void;
  readonly onSave: () => void;
  readonly onCopy: () => void;
}

/** 工具栏：行数 + 语言 + 模式切换 + 保存 + 复制 */
function ViewerToolbar({
  totalLines,
  lang,
  editMode,
  isDirty,
  isSaving,
  copied,
  contentEmpty,
  editDisabled,
  onEnterEdit,
  onExitEdit,
  onSave,
  onCopy,
}: ViewerToolbarProps): ReactElement {
  const { t } = useTranslation();

  /** 退出编辑：脏数据先命令式确认（不静默丢弃未保存修改） */
  const handleExit = async (): Promise<void> => {
    if (!isDirty) {
      onExitEdit();
      return;
    }
    const confirmed = await confirm({
      title: t('fileViewer.unsaved'),
      message: t('fileViewer.confirmExitEdit'),
      danger: true,
    });
    if (confirmed) onExitEdit();
  };

  return (
    <div className="file-viewer-toolbar">
      <span className="file-viewer-meta">
        {totalLines} {t('fileViewer.lines', { count: totalLines })}
        {lang !== 'text' ? ` · ${lang}` : ''}
      </span>
      <div className="file-viewer-actions">
        {/* 模式切换按钮 */}
        {editMode ? (
          <button
            type="button"
            className="file-viewer-mode-btn"
            onClick={() => {
              void handleExit();
            }}
            title={t('fileViewer.switchToPreview')}
            aria-label={t('fileViewer.switchToPreview')}
          >
            <Eye size={12} />
            <span>{t('fileViewer.view')}</span>
          </button>
        ) : (
          <button
            type="button"
            className="file-viewer-mode-btn"
            onClick={onEnterEdit}
            disabled={editDisabled}
            title={t('fileViewer.switchToEdit')}
            aria-label={t('fileViewer.switchToEdit')}
          >
            <Pencil size={12} />
            <span>{t('fileViewer.edit')}</span>
          </button>
        )}

        {/* 保存按钮（仅编辑态可见） */}
        {editMode && (
          <button
            type="button"
            className={cn('file-viewer-save-btn', isDirty && 'dirty')}
            onClick={onSave}
            disabled={!isDirty || isSaving}
            title={`${t('common.save')} (Ctrl+S)`}
            aria-label={t('common.save')}
          >
            {isSaving ? <Spinner className="size-2.5" /> : <Save size={12} />}
            <span>{isSaving ? t('fileViewer.saving') : t('common.save')}</span>
          </button>
        )}

        {/* 复制按钮（始终可见） */}
        <button
          type="button"
          className={cn('file-viewer-copy-btn', copied && 'copied')}
          onClick={onCopy}
          disabled={contentEmpty}
          aria-label={copied ? t('common.copied') : t('fileViewer.copyContent')}
          title={copied ? t('common.copied') : t('fileViewer.copyContent')}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? t('common.copied') : t('common.copy')}</span>
        </button>
      </div>
    </div>
  );
}
