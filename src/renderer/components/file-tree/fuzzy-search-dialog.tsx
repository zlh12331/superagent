// src/renderer/components/file-tree/fuzzy-search-dialog.tsx
// 文件模糊搜索对话框（照搬参考项目 FuzzySearchDialog）
// ──────────────────────────────────────────────────────────────
// 功能：
// - 顶部居中弹窗，实时搜索（输入防抖 200ms）
// - 统一搜索结果：会话（匹配标题，最多 5 条）+ 文件（匹配文件名）
// - 结果列表：图标 + 文件名（高亮匹配）+ 路径
// - 键盘导航：ArrowUp/Down 切换、Enter 确认、Escape 关闭
// - 点击会话 → 切换会话；点击文件 → onSelect(path)（父组件打开文件查看器）
//
// 数据源适配（Electron 版）：
// - 参考项目 fuzzyFileSearch → 本项目的 search:glob IPC（**/*q* 子串匹配，
//   字母转 [aA] 字符类实现大小写不敏感，glob 特殊字符转义）
// - 参考项目 useThreads → 本项目 useSessionsQuery
// - 参考项目 useSelectThread → 本项目 setActiveSession + navigate
// - 文件搜索根目录：当前激活会话的 workingDir（无激活会话时仅会话搜索可用）
// ──────────────────────────────────────────────────────────────

import { Hash, Search } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useSessionsQuery } from '@/hooks/use-sessions';
import { useTranslation } from '@/i18n/use-translation';
import { ROUTES } from '@/lib/constants';
import { unwrap } from '@/lib/ipc';
import { cn } from '@/lib/utils';
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
 * glob 特殊字符转义（避免用户输入的 * ? [ ] { } 等干扰 glob 模式语义）。
 */
function escapeGlob(value: string): string {
  return value.replace(/[*?[\]{}()!]/g, (ch) => `\\${ch}`);
}

/**
 * 字母转 [aA] 字符类，实现 glob 文件名匹配的大小写不敏感
 * （ripgrep glob 默认大小写敏感，参考项目 fuzzyFileSearch 为大小写不敏感）。
 */
function toCaseInsensitiveGlob(value: string): string {
  return value.replace(/[a-zA-Z]/g, (ch) => {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    return `[${lower}${upper}]`;
  });
}

/**
 * 文件搜索（search:glob IPC）：递归通配符 + 关键词子串匹配文件名。
 * 返回绝对路径数组；浏览器模式（window.api 缺失）返回空数组。
 */
async function searchFiles(query: string, rootDir: string): Promise<string[]> {
  if (typeof window === 'undefined' || window.api === undefined) {
    return [];
  }
  const pattern = `**/*${toCaseInsensitiveGlob(escapeGlob(query))}*`;
  const response = await window.api.search.glob({
    pattern,
    path: rootDir,
    includeHidden: false,
    maxResults: FILE_RESULTS_LIMIT,
  });
  try {
    return [...unwrap(response).files];
  } catch {
    return [];
  }
}

/** 从完整路径提取文件名 */
function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/** 从完整路径中提取目录部分（不含文件名） */
function extractDir(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash) : '';
}

/**
 * 高亮匹配子串：将 title 按 query 切分，匹配部分用 <mark> 标记。
 * 仅做大小写不敏感的 includes 匹配（与文件搜索内部一致）。
 */
function highlightMatch(title: string, query: string): React.ReactNode {
  const q = query.trim();
  if (q.length === 0) return title;
  const lower = title.toLowerCase();
  const ql = q.toLowerCase();
  const idx = lower.indexOf(ql);
  if (idx < 0) return title;

  return (
    <>
      {title.slice(0, idx)}
      <mark className="rounded bg-[color-mix(in_srgb,var(--success)_20%,transparent)] px-0.5 text-[var(--accent)]">
        {title.slice(idx, idx + q.length)}
      </mark>
      {title.slice(idx + q.length)}
    </>
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
  // 本地化文案
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 会话列表（TanStack Query；会话搜索 + workingDir 派生共用）
  const sessionsQuery = useSessionsQuery();
  // P3：无限分页——平铺 pages
  const sessions = sessionsQuery.data?.pages.flatMap((page) => page.sessions) ?? [];
  // 激活会话的 workingDir（文件搜索根目录；无激活会话时仅会话搜索可用）
  const activeSessionId = useActiveSessionStore((state) => state.activeSessionId);
  const workingDir = ((): string | null => {
    if (activeSessionId === null) return null;
    return sessions.find((s) => s.id === activeSessionId)?.workingDir ?? null;
  })();

  // 会话匹配结果 — query 匹配会话标题时显示，最多 5 条
  const sessionResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    return sessions
      .filter((s) => s.title.toLowerCase().includes(q))
      .slice(0, SESSION_RESULTS_LIMIT)
      .map((s) => ({
        type: 'session' as const,
        sessionId: s.id,
        title: s.title,
        cwd: s.workingDir,
      }));
  }, [sessions, query]);

  // 统一结果列表 — 会话在上、文件在下，用于键盘导航的连续索引
  const combinedResults = useMemo<UnifiedResult[]>(() => {
    const files = fileResults.map((path) => ({
      type: 'file' as const,
      path,
      title: basename(path),
    }));
    return [...sessionResults, ...files];
  }, [sessionResults, fileResults]);

  // 重置状态：每次打开对话框时清空 query / results。
  // 通过 rAF 延迟 setState，避免 effect 体内同步调用 setState 触发级联渲染
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = requestAnimationFrame(() => {
      if (cancelled) return;
      setQuery('');
      setFileResults([]);
      setSelectedIndex(0);
      inputRef.current?.focus();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, [open]);

  // 防抖搜索：query 变化时延迟 DEBOUNCE_MS 调用文件搜索（200ms，对齐参考项目）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      const q = query.trim();
      if (q.length === 0) {
        setFileResults([]);
        setSelectedIndex(0);
        return;
      }
      // 无激活会话（无 workingDir）时跳过文件搜索，会话搜索仍可用
      if (workingDir === null) {
        setFileResults([]);
        setSelectedIndex(0);
        return;
      }
      searchFiles(q, workingDir)
        .then((paths) => {
          if (!cancelled) {
            setFileResults(paths);
            setSelectedIndex(0);
          }
        })
        .catch(() => {
          if (!cancelled) {
            toast.error(t('fileTree.fuzzySearch.failed'));
            setFileResults([]);
          }
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, open, workingDir, t]);

  // 选中项变化时自动滚动到可见区域（统一列表索引，含会话+文件）
  useEffect(() => {
    if (!open || combinedResults.length === 0) return;
    const list = listRef.current;
    if (list === null) return;
    const item = list.children[selectedIndex];
    if (item instanceof HTMLElement) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, combinedResults.length, open]);

  // 确认选择：会话切换 / 文件 onSelect（参考项目 handleConfirm 语义）
  const handleConfirm = useCallback(() => {
    const item = combinedResults[selectedIndex];
    if (item === undefined) return;
    if (item.type === 'session') {
      // 切换会话：设置激活 + 跳转聊天页（对齐参考项目 useSelectThread 语义）
      useActiveSessionStore.getState().setActiveSession(item.sessionId);
      navigate(ROUTES.chatPath(item.sessionId));
    } else {
      onSelect(item.path);
    }
    onClose();
  }, [combinedResults, selectedIndex, onSelect, navigate, onClose]);

  // 键盘导航：ArrowUp/Down 切换、Enter 确认（边界使用统一列表长度）
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
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
    },
    [combinedResults.length, handleConfirm],
  );

  // 防御性：selectedIndex 不能超出 combinedResults 范围（含会话+文件）
  const safeSelectedIndex = useMemo(
    () => (combinedResults.length === 0 ? 0 : Math.min(selectedIndex, combinedResults.length - 1)),
    [selectedIndex, combinedResults.length],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-[20vh] translate-y-0 left-[50%] translate-x-[-50%] w-[90vw] max-w-[560px] gap-0 rounded-[10px] border p-0 shadow-[var(--shadow-modal)]"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t('fileTree.fuzzySearch.title')}</DialogTitle>
        </DialogHeader>

        {/* 输入框 */}
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Search
            width={14}
            height={14}
            className="shrink-0 text-[var(--text-faint)]"
            aria-hidden
          />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('fileTree.fuzzySearch.placeholder')}
            aria-label={t('fileTree.fuzzySearch.ariaLabel')}
            aria-autocomplete="list"
            aria-controls="fuzzy-search-results"
            aria-activedescendant={
              combinedResults.length > 0 ? `fuzzy-result-${safeSelectedIndex}` : undefined
            }
            className="flex-1 border-none bg-transparent text-[14px] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
          />
        </div>

        {/* 结果列表 */}
        <div
          id="fuzzy-search-results"
          ref={listRef}
          role="listbox"
          className="max-h-[400px] overflow-y-auto p-1.5"
        >
          {query.trim().length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] text-[var(--text-faint)]">
              {t('fileTree.fuzzySearch.hint')}
            </div>
          ) : combinedResults.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] text-[var(--text-faint)]">
              {t('fileTree.fuzzySearch.noResults')}
            </div>
          ) : (
            // 统一渲染会话+文件结果：会话在前、文件在后，键盘导航统一索引
            combinedResults.map((item, i) => {
              // 选中态样式：左侧 accent 竖线 + 浅色背景
              const selectedCls =
                i === safeSelectedIndex
                  ? 'border-l-2 border-[var(--accent)] bg-[var(--bg-elev-2)]'
                  : 'border-l-2 border-transparent';
              // 公共 className — 所有结果项共用
              const baseCls =
                'flex w-full items-center gap-2 rounded-md px-2.5 py-[7px] text-left cursor-pointer transition-colors';

              // 会话结果 — Hash 图标，点击切换到该会话
              if (item.type === 'session') {
                return (
                  <button
                    key={`session-${item.sessionId}`}
                    id={`fuzzy-result-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === safeSelectedIndex}
                    onClick={() => {
                      useActiveSessionStore.getState().setActiveSession(item.sessionId);
                      navigate(ROUTES.chatPath(item.sessionId));
                      onClose();
                    }}
                    onMouseEnter={() => setSelectedIndex(i)}
                    className={cn(baseCls, selectedCls)}
                  >
                    <Hash className="size-3.5 shrink-0 text-[var(--text-faint)]" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] text-[var(--text)]">
                        {highlightMatch(item.title, query)}
                      </div>
                      {item.cwd !== null && (
                        <div className="truncate text-[var(--font-size-2xs)] text-[var(--text-faint)]">
                          {item.cwd}
                        </div>
                      )}
                    </div>
                  </button>
                );
              }

              // 文件结果 — FileIcon，点击调用 onSelect(path)
              const dir = extractDir(item.path);
              return (
                <button
                  key={`file-${item.path}`}
                  id={`fuzzy-result-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === safeSelectedIndex}
                  onClick={() => {
                    onSelect(item.path);
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className={cn(baseCls, selectedCls)}
                >
                  <FileIcon name={item.title} isFolder={false} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12px] text-[var(--text)]">
                      {highlightMatch(item.title, query)}
                    </div>
                    {dir.length > 0 && (
                      <div className="truncate text-[var(--font-size-2xs)] text-[var(--text-faint)]">
                        {dir}
                      </div>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
