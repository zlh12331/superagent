// src/renderer/components/file-tree/fuzzy-search-dialog.tsx
// 文件模糊搜索对话框（⌘F）：会话 + 文件统一搜索
// ──────────────────────────────────────────────────────────────
// 职责（仅编排与渲染）：
// - 输入框 + 结果列表渲染（会话在前、文件在后，键盘导航统一索引）
// - 结果项高亮匹配子串（<mark>）/ 两类结果的图标与副标题差异
// - 键盘导航（ArrowUp/Down/Enter）+ 挨项自动滚动
// - 确认结果：会话 → 切换激活会话并跳转；文件 → onSelect（父组件打开查看器）
//
// 数据来源：
// - 会话列表：useSessionsQuery（TanStack Query）
// - 文件搜索：useFileGlobSearch（防抖 + 竞态 + 失败上抛，见该 hook）
// - glob 模式构造 / 展示目录派生：lib/file-search（纯函数）
//
// 拆分记录（2026-09 file-tree 审计）：本文件原 414 行，glob 转义、防抖搜索、
// Promise 竞态、错误提示与渲染/键盘导航混居一处分居四种职责。现将
// 「纯函数 → lib/file-search」「防抖搜索 → hooks/use-file-glob-search」
// 「结果行 → 本文件内 ResultRow 子组件」拆出，组件自身只留编排。
// ──────────────────────────────────────────────────────────────

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
import { useSessionsQuery } from '@/hooks/use-sessions';
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
    // 行样式归 .fuzzy-result（globals.css 按钮类体系；选中态由 aria-selected 驱动，
    // 无需在 JSX 里重复一份条件类，选中判定与可访问性状态自此同源）
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={selected}
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

  // 会话列表（TanStack Query；会话搜索 + workingDir 派生共用）
  const sessionsQuery = useSessionsQuery();
  // P3：无限分页——平铺 pages
  const sessions = sessionsQuery.data?.pages.flatMap((page) => page.sessions) ?? [];
  // 激活会话的 workingDir（文件搜索根目录；无激活会话时仅会话搜索可用）
  const activeSessionId = useActiveSessionStore((state) => state.activeSessionId);
  const workingDir = sessions.find((session) => session.id === activeSessionId)?.workingDir ?? null;

  // 文件搜索（防抖 + 竞态 + 失败提示统一由 hook 负责）
  const fileResults = useFileGlobSearch({
    query,
    rootDir: workingDir,
    enabled: open,
    debounceMs: DEBOUNCE_MS,
    maxResults: FILE_RESULTS_LIMIT,
    onError: () => toast.error(t('fileTree.fuzzySearch.failed')),
  });

  // 会话匹配结果 — query 匹配会话标题时显示，最多 5 条
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

  // 统一结果列表 — 会话在上、文件在下，用于键盘导航的连续索引
  // （每次渲染重建数组：仅长度参与 effect 依赖，不构成记忆化收益）
  const combinedResults: readonly UnifiedResult[] = [
    ...sessionResults,
    ...fileResults.map((path) => ({ type: 'file' as const, path, title: basename(path) })),
  ];

  // 重置状态：每次打开对话框时清空 query。通过 rAF 延迟 setState，
  // 避免 effect 体内同步调用 setState 触发级联渲染
  // （文件结果由 useFileGlobSearch 的 enabled=false 分支清空）
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

  // 防御性收敛：selectedIndex 不能超出 combinedResults 范围（含会话+文件）。
  // 高亮、aria-activedescendant、滚动、Enter 确认四处一律以本值为准——
  // 此前滚动与确认读原始 selectedIndex，结果集收缩时会与高亮行错位。
  const safeSelectedIndex =
    combinedResults.length === 0 ? 0 : Math.min(selectedIndex, combinedResults.length - 1);

  // 选中项变化时自动滚动到可见区域（统一列表索引，含会话+文件）
  useEffect(() => {
    if (!open || combinedResults.length === 0) return;
    const list = listRef.current;
    if (list === null) return;
    const item = list.children[safeSelectedIndex];
    if (item instanceof HTMLElement) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }, [safeSelectedIndex, combinedResults.length, open]);

  // 确认单个结果：会话切换 / 文件 onSelect（键盘 Enter 与鼠标点击共用一份逻辑，
  // 避免两处跳转代码漂移）
  const confirmResult = (item: UnifiedResult): void => {
    if (item.type === 'session') {
      // 切换会话：设置激活 + 跳转聊天页（对齐参考项目 useSelectThread 语义）
      useActiveSessionStore.getState().setActiveSession(item.sessionId);
      navigate(ROUTES.chatPath(item.sessionId));
    } else {
      onSelect(item.path);
    }
    onClose();
  };

  // 键盘 Enter：确认当前选中项（结果可能已变化，越界由 undefined 守卫兜底）
  const handleConfirm = (): void => {
    const item = combinedResults[safeSelectedIndex];
    if (item !== undefined) confirmResult(item);
  };

  // 键盘导航：ArrowUp/Down 切换、Enter 确认（边界使用统一列表长度）
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
        className="top-[20vh] translate-y-0 left-[50%] translate-x-[-50%] w-[90vw] max-w-[560px] gap-0 rounded-[10px] border p-0 shadow-[var(--shadow-modal)]"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t('fileTree.fuzzySearch.title')}</DialogTitle>
        </DialogHeader>

        {/* 输入框 */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search width={14} height={14} className="shrink-0 text-text-faint" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // 查询变化即回到首行：结果集随后被替换，旧的选中下标已无意义
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
            className="flex-1 border-none bg-transparent text-[14px] text-foreground outline-none placeholder:text-text-faint"
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
            <div className="px-3 py-8 text-center text-[12px] text-text-faint">
              {t('fileTree.fuzzySearch.hint')}
            </div>
          ) : combinedResults.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] text-text-faint">
              {t('fileTree.fuzzySearch.noResults')}
            </div>
          ) : (
            // 统一渲染会话+文件结果：会话在前、文件在后，键盘导航统一索引
            combinedResults.map((item, i) => {
              const shared = {
                id: `fuzzy-result-${i}`,
                selected: i === safeSelectedIndex,
                onSelect: () => confirmResult(item),
                onHover: () => setSelectedIndex(i),
              };
              // 会话结果 — Hash 图标，点击切换到该会话
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
              // 文件结果 — FileIcon，点击调用 onSelect(path)
              return (
                <ResultRow
                  {...shared}
                  key={`file-${item.path}`}
                  icon={<FileIcon name={item.title} isFolder={false} />}
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
