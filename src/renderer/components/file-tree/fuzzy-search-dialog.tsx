import { Hash, Search } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useFileGlobSearch } from '@/hooks/use-file-glob-search';
import { useSessionsFlat } from '@/hooks/use-sessions';
import { useTranslation } from '@/i18n/use-translation';
import { ROUTES } from '@/lib/constants';
import { extractDir } from '@/lib/file-search';
import { basename, cn } from '@/lib/utils';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';

import { FileIcon } from './file-icon';

interface FuzzySearchDialogProps {
  /** 是否打开 */
  readonly open: boolean;
  /** 关闭回调 */
  readonly onClose: () => void;
  /** 选中某文件路径回调（父组件打开文件查看器） */
  readonly onSelect: (path: string) => void;
}

/**
 * 统一搜索结果项 — 会话或文件。
 * 会话匹配显示在文件匹配上方，键盘导航在统一列表中连续索引。
 */
type UnifiedResult =
  | {
      readonly type: 'session';
      readonly sessionId: string;
      readonly title: string;
      readonly cwd: string | null;
    }
  | { readonly type: 'file'; readonly path: string; readonly title: string };

/** 防抖延迟（毫秒） */
const DEBOUNCE_MS = 200;
/** 文件结果数上限（对齐参考项目 fuzzyFileSearch 默认上限） */
const FILE_RESULTS_LIMIT = 50;
/** 会话结果数上限 */
const SESSION_RESULTS_LIMIT = 5;

/**
 * 高亮匹配子串：将 title 按 query 切分，匹配部分用 <mark> 标记。
 * 仅做大小写不敏感的 includes 匹配（与文件搜索内部一致）。
 */
function highlightMatch(title: string, query: string): ReactNode {
  const q = query.trim();
  if (q.length === 0) return title;
  const idx = title.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return title;

  return (
    <>
      {title.slice(0, idx)}
      <mark className="rounded bg-[color-mix(in_srgb,var(--success)_20%,transparent)] px-0.5 text-accent">
        {title.slice(idx, idx + q.length)}
      </mark>
      {title.slice(idx + q.length)}
    </>
  );
}

/**
 * 结果行（会话 / 文件共用）
 *
 * 抽离动机：两类结果的 <button> 此前各写一份 className 与选中态三元、
 * 仅图标与副标题不同，任一侧改样式都需同步另一侧。现收敛为单一渲染路径，
 * 差异经 props 注入（icon / title / subtitle / monospace）。
 */
interface ResultRowProps {
  /** DOM id（供 aria-activedescendant 指向） */
  readonly id: string;
  /** 是否为键盘/悬停选中的行 */
  readonly selected: boolean;
  /** 确认选择（点击） */
  readonly onSelect: () => void;
  /** 鼠标进入同步选中索引 */
  readonly onHover: () => void;
  /** 行首图标（会话 Hash / 文件 FileIcon） */
  readonly icon: ReactNode;
  /** 主标题（已做匹配高亮） */
  readonly title: ReactNode;
  /** 副标题（会话 cwd / 文件目录）；null 表示不渲染 */
  readonly subtitle: string | null;
  /** 主标题是否用等宽字体（文件路径风格） */
  readonly monospace: boolean;
}

function ResultRow({
  id,
  selected,
  onSelect,
  onHover,
  icon,
  title,
  subtitle,
  monospace,
}: ResultRowProps): ReactElement {
  return (
    <button
      id={id}
      type="button"
      aria-selected={selected}
      role="option"
      onClick={onSelect}
      onMouseEnter={onHover}
      className="fuzzy-result"
    >
      {icon}
      <div className="fuzzy-result-body">
        <div className={cn('fuzzy-result-title', monospace && 'font-mono')}>{title}</div>
        {subtitle !== null && <div className="fuzzy-result-subtitle">{subtitle}</div>}
      </div>
    </button>
  );
}

/**
 * 模糊搜索对话框 — 模糊搜索工作区文件与历史会话，支持键盘导航与选中跳转。
 */
export function FuzzySearchDialog({
  open,
  onClose,
  onSelect,
}: FuzzySearchDialogProps): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const sessions = useSessionsFlat().data ?? [];
  const activeSessionId = useActiveSessionStore((state) => state.activeSessionId);
  const workingDir = sessions.find((session) => session.id === activeSessionId)?.workingDir ?? null;

  const fileResults = useFileGlobSearch({
    query,
    rootDir: workingDir,
    enabled: open,
    debounceMs: DEBOUNCE_MS,
    maxResults: FILE_RESULTS_LIMIT,
    onError: () => toast.error(t('fileTree.fuzzySearch.failed')),
  });

  const sessionQuery = query.trim().toLowerCase();
  const sessionResults: readonly UnifiedResult[] =
    sessionQuery === ''
      ? []
      : sessions
          .filter((session) => session.title.toLowerCase().includes(sessionQuery))
          .slice(0, SESSION_RESULTS_LIMIT)
          .map((session) => ({
            type: 'session' as const,
            sessionId: session.id,
            title: session.title,
            cwd: session.workingDir,
          }));

  const combinedResults: readonly UnifiedResult[] = [
    ...sessionResults,
    ...fileResults.map((path) => ({ type: 'file' as const, path, title: basename(path) })),
  ];

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = requestAnimationFrame(() => {
      if (cancelled) return;
      setQuery('');
      setSelectedIndex(0);
      inputRef.current?.focus();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, [open]);

  const safeSelectedIndex =
    combinedResults.length === 0 ? 0 : Math.min(selectedIndex, combinedResults.length - 1);

  useEffect(() => {
    if (!open || combinedResults.length === 0) return;
    const list = listRef.current;
    if (list === null) return;
    const item = list.children[safeSelectedIndex];
    if (item instanceof HTMLElement) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }, [safeSelectedIndex, combinedResults.length, open]);

  const confirmResult = (item: UnifiedResult): void => {
    if (item.type === 'session') {
      useActiveSessionStore.getState().setActiveSession(item.sessionId);
      navigate(ROUTES.chatPath(item.sessionId));
    } else {
      onSelect(item.path);
    }
    onClose();
  };

  const handleConfirm = (): void => {
    const item = combinedResults[safeSelectedIndex];
    if (item !== undefined) confirmResult(item);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, Math.max(combinedResults.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-[20vh] translate-y-0 left-[50%] translate-x-[-50%] w-[90vw] max-w-[560px] gap-0 rounded-lg border p-0 shadow-[var(--shadow-modal)]"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t('fileTree.fuzzySearch.title')}</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search width={14} height={14} className="shrink-0 text-text-faint" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('fileTree.fuzzySearch.placeholder')}
            aria-label={t('fileTree.fuzzySearch.ariaLabel')}
            aria-autocomplete="list"
            aria-controls="fuzzy-search-results"
            aria-activedescendant={
              combinedResults.length > 0 ? `fuzzy-result-${safeSelectedIndex}` : undefined
            }
            className="flex-1 border-none bg-transparent text-md text-foreground outline-none placeholder:text-text-faint"
          />
        </div>

        <div
          id="fuzzy-search-results"
          ref={listRef}
          role="listbox"
          className="max-h-[400px] overflow-y-auto p-1.5"
        >
          {query.trim().length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-text-faint">
              {t('fileTree.fuzzySearch.hint')}
            </div>
          ) : combinedResults.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-text-faint">
              {t('fileTree.fuzzySearch.noResults')}
            </div>
          ) : (
            combinedResults.map((item, i) => {
              const shared = {
                id: `fuzzy-result-${i}`,
                selected: i === safeSelectedIndex,
                onSelect: () => confirmResult(item),
                onHover: () => setSelectedIndex(i),
              };
              if (item.type === 'session') {
                return (
                  <ResultRow
                    {...shared}
                    key={`session-${item.sessionId}`}
                    icon={<Hash className="size-3.5 shrink-0 text-text-faint" aria-hidden />}
                    title={highlightMatch(item.title, query)}
                    subtitle={item.cwd}
                    monospace={false}
                  />
                );
              }
              return (
                <ResultRow
                  {...shared}
                  key={`file-${item.path}`}
                  icon={<FileIcon name={item.title} />}
                  title={highlightMatch(item.title, query)}
                  subtitle={extractDir(item.path) || null}
                  monospace
                />
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
