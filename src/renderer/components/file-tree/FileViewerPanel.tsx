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
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { confirm } from '@/stores/transient/confirm-dialog-store';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';

import { detectLangFromPath, lineCount } from './file-viewer-utils';

/** 大文件高亮降级阈值（行）：shiki 整文件 tokenize 超过则跳过高亮渲染纯文本 */
const MAX_HIGHLIGHT_LINES = 5000;

/** 文件查看面板（右面板）：shiki 高亮查看/编辑/保存，超 5000 行降级纯文本 */
export function FileViewerPanel(): ReactElement {
  const { t } = useTranslation();
  const open = useFileViewerStore((s) => s.open);
  const filePath = useFileViewerStore((s) => s.filePath);

  const editMode = useFileViewerStore((s) => s.editMode);
  const isDirty = useFileViewerStore((s) => s.isDirty);
  const originalContent = useFileViewerStore((s) => s.originalContent);
  const editedContent = useFileViewerStore((s) => s.editedContent);
  const setLoadedContent = useFileViewerStore((s) => s.setLoadedContent);
  const enterEditMode = useFileViewerStore((s) => s.enterEditMode);
  const exitEditMode = useFileViewerStore((s) => s.exitEditMode);
  const setEditedContent = useFileViewerStore((s) => s.setEditedContent);
  const markSaved = useFileViewerStore((s) => s.markSaved);

  const { data, isLoading, error } = useFileContent(open ? filePath : null);

  const { mutateAsync: saveFile, isPending: isSaving } = useFileWrite();

  const { resolvedTheme } = useTheme();
  const theme: 'github-dark' | 'github-light' =
    resolvedTheme === 'dark' ? 'github-dark' : 'github-light';

  const lang = filePath !== null ? detectLangFromPath(filePath) : 'text';

  useEffect(() => {
    if (data !== undefined) {
      if (!isDirty) {
        setLoadedContent(data.content);
      }
    }
  }, [data, isDirty, setLoadedContent]);

  const [html, setHtml] = useState<string | null>(null);
  const displayContent = editMode ? editedContent : originalContent;
  useEffect(() => {
    if (displayContent === '' || open === false) {
      setHtml(null);
      return;
    }
    if (lineCount(displayContent) > MAX_HIGHLIGHT_LINES) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const h = await getHighlighter();
        if (cancelled) return;
        await ensureLangLoaded(h, lang);
        if (cancelled) return;
        const result = h.codeToHtml(displayContent, { lang, theme });
        setHtml(result);
      } catch {
        if (!cancelled) setHtml(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [displayContent, lang, theme, open]);

  const { copied, copy } = useCopy();
  const handleCopy = async (): Promise<void> => {
    await copy(displayContent);
  };

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
    } catch {}
  };

  const saveHandlerRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    saveHandlerRef.current = () => {
      void handleSave();
    };
  });

  useEffect(() => {
    if (!editMode || !open) {
      useFileViewerStore.getState().registerSaveHandler(null);
      return undefined;
    }
    useFileViewerStore.getState().registerSaveHandler(() => {
      saveHandlerRef.current();
    });
    return () => useFileViewerStore.getState().registerSaveHandler(null);
  }, [editMode, open]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  const wordWrap = useSettingsStore((s) => s.editor.wordWrap);

  const handleTextareaScroll = (): void => {
    if (textareaRef.current !== null && highlightRef.current !== null) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref.current 是受控读，html 为高亮层挂载信号
  useEffect(() => {
    const highlight = highlightRef.current;
    if (highlight === null) {
      return;
    }
    const textarea = textareaRef.current;
    if (!editMode || !wordWrap || textarea === null) {
      highlight.style.paddingRight = '';
      return;
    }
    const occupancy = textarea.offsetWidth - textarea.clientWidth;
    highlight.style.paddingRight = occupancy > 0 ? `${occupancy}px` : '0px';
    return () => {
      highlight.style.paddingRight = '';
    };
  }, [editMode, wordWrap, html]);

  const fileName = filePath !== null ? basename(filePath) : '';
  const totalLines = editMode
    ? lineCount(editedContent)
    : (data?.totalLines ?? lineCount(displayContent));

  if (!open) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1.5 p-3 text-xs">
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

      <div className="file-viewer-layout">
        <div className={cn('file-viewer-body', wordWrap && 'file-viewer-wrap')}>
          <ViewerBody
            isLoading={isLoading}
            error={error}
            editMode={editMode}
            content={displayContent}
            html={html}
            fileName={fileName}
            wordWrap={wordWrap}
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
  /** 自动换行（37 号 A）：wrap 开关 + 双层 pre-wrap 类） */
  readonly wordWrap: boolean;
}

/**
 * 编辑态视图：shiki 高亮做背景层，textarea 做前景层
 * （文字透明、caret 不透明，与下层高亮逐行对齐）
 *
 * 37 号 A：wordWrap 开启时 textarea `wrap="soft"` + 容器 file-viewer-wrap 类
 * （CSS 将双层切为 pre-wrap + break-all 的确定换行算法——同字体/同宽/同内边距
 * 下逐行对齐不破）。
 */
function EditorView({
  value,
  onChange,
  textareaRef,
  highlightRef,
  onScroll,
  html,
  fileName,
  wordWrap,
}: EditorViewProps): ReactElement {
  const { t } = useTranslation();
  return (
    <div className={cn('file-viewer-editor', wordWrap && 'file-viewer-wrap')}>
      {html !== null && (
        <div
          ref={highlightRef}
          className="file-viewer-editor-highlight"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki 输出为可信的语法高亮 HTML
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
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
        wrap={wordWrap ? 'soft' : 'off'}
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
  /** 自动换行（37 号 A：编辑态 textarea wrap + 高亮层同步） */
  readonly wordWrap: boolean;
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
  wordWrap,
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
  if (editMode) {
    return <EditorView {...editor} html={html} fileName={fileName} wordWrap={wordWrap} />;
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
        className="text-muted-foreground ml-auto min-w-0 flex-1 truncate text-right font-mono text-2xs"
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
