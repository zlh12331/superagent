// src/renderer/components/layout/Sidebar.tsx
// 侧边栏 · 会话列表 · 对齐原型布局
// ──────────────────────────────────────────────────────────────
// 职责：
// - sidebar-head：新建会话按钮 + 搜索框 + tabs（最近/归档）
// - sidebar-list：会话列表（thread-item 结构，按 folder 分组）
// - sidebar-foot：用户信息区域（占位，功能预留）
//
// 设计（对齐原型 docs/prototype/prototype-v2.html）：
// - class 命名：sidebar / sidebar-head / sidebar-search / sidebar-tabs /
//   sidebar-tab / sidebar-list / thread-group-label / folder-label /
//   folder-items / thread-item / ti-row / ti-dot / ti-content / ti-title /
//   ti-meta / ti-actions / sidebar-foot
// - 文学风视觉令牌：深棕主色 + 衬线标题 + 等宽元信息
//
// 状态分层（符合项目规范）：
// - L2 Zustand：useActiveSessionStore 维护激活会话 id
// - L3 TanStack Query：useSessionsQuery 拉取列表
// - L3 TanStack Mutation：useDeleteSession
// ──────────────────────────────────────────────────────────────

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { MoreVertical, Plus, Search, Trash2 } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useNavigate } from 'react-router';
import { Virtuoso } from 'react-virtuoso';

import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { EmptyState } from '@/components/common/EmptyState';
import { FileTreePanel } from '@/components/file-tree/FileTreePanel';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useAsyncView } from '@/hooks/use-async-view';
import { useDeleteSession, useSessionsQuery } from '@/hooks/use-sessions';
import { useTranslation } from '@/i18n/use-translation';
import { ROUTES } from '@/lib/constants';
import { formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useWelcomeStore } from '@/stores/transient/welcome-store';

/** 从 workingDir 提取 basename，用于 folder 分组（无 basename 返回空串，展示时本地化「未分组」） */
function getFolderName(workingDir: string): string {
  const basename = workingDir.split(/[\\/]/).pop();
  return basename && basename.length > 0 ? basename : '';
}

/**
 * 侧边栏
 *
 * 三段式结构：sidebar-head（搜索+tabs）+ sidebar-list（会话列表）+ sidebar-foot（用户信息）。
 * 会话列表按 workingDir basename 分组为 folder-label + folder-items。
 */
export function Sidebar(): ReactElement {
  const navigate = useNavigate();
  // 本地化文案
  const { t } = useTranslation();

  // L3 TanStack Query：会话列表数据
  const query = useSessionsQuery();
  // 视图状态机映射（五态：loading / refreshing / error / empty / ready）
  const view = useAsyncView(query, { isEmpty: (d) => d.sessions.length === 0 });
  // L3 TanStack Mutation：删除会话
  const { mutate: deleteSession, isPending: isDeleting } = useDeleteSession();
  // L2 Zustand：激活会话 id
  const activeSessionId = useActiveSessionStore((state) => state.activeSessionId);
  const setActiveSession = useActiveSessionStore((state) => state.setActiveSession);
  const clearActiveSession = useActiveSessionStore((state) => state.clearActiveSession);
  // L2 Zustand：欢迎页模式
  const enterWelcomeMode = useWelcomeStore((state) => state.enterWelcomeMode);

  // 搜索关键字（功能预留：仅 UI，暂不实现过滤逻辑）
  const [searchKeyword, setSearchKeyword] = useState('');
  // 当前激活的 tab（recent / files / archived）
  const [activeTab, setActiveTab] = useState<'recent' | 'files' | 'archived'>('recent');

  // 派生：会话列表
  const sessions = query.data?.sessions ?? [];

  // 派生：当前激活会话的 workingDir（用于文件树面板）
  // 无激活会话时为 null，FileTreePanel 显示空状态
  const workingDir = ((): string | null => {
    if (activeSessionId === null) return null;
    return sessions.find((s) => s.id === activeSessionId)?.workingDir ?? null;
  })();

  // 派生：按 workingDir basename 分组
  // 结构：Map<folderName, Session[]>
  // 注意：sessions 为 readonly 数组，使用 spread 创建新数组避免 push 副作用
  const groupedSessions = ((): Map<string, typeof sessions> => {
    const groups = new Map<string, typeof sessions>();
    for (const session of sessions) {
      const folderName = getFolderName(session.workingDir);
      const existing = groups.get(folderName) ?? [];
      groups.set(folderName, [...existing, session]);
    }
    return groups;
  })();

  // 拖拽排序覆盖（folderName → 会话 id 顺序；未覆盖的文件夹保持服务端顺序）
  // 会话顺序由 updatedAt 决定，拖拽重排仅作为 UI 层临时排序（不持久化）
  const [orderOverrides, setOrderOverrides] = useState<ReadonlyMap<string, readonly string[]>>(
    () => new Map(),
  );
  // 折叠的文件夹集合（提升到 Sidebar：虚拟化列表需要整体过滤条目）
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const toggleFolder = (name: string): void => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };
  // PointerSensor：拖拽需移动 4px 才激活（避免与点击选择冲突）
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  /** 拖拽结束：同文件夹内重排（跨文件夹拖拽被 folder 归属过滤） */
  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (over === null || active.id === over.id) {
      return;
    }
    const folderName = String(active.data.current?.['folder'] ?? '');
    // 函数式更新：直接基于最新覆盖顺序计算，无需 ref 同步（React Compiler 合规）
    setOrderOverrides((prev) => {
      // 当前顺序：优先拖拽覆盖，否则取该文件夹的默认（服务端）顺序
      const folderSessions = sessions.filter((s) => getFolderName(s.workingDir) === folderName);
      const current = prev.get(folderName) ?? folderSessions.map((s) => s.id);
      const oldIndex = current.indexOf(String(active.id));
      const newIndex = current.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1) {
        return prev;
      }
      const next = arrayMove([...current], oldIndex, newIndex);
      return new Map(prev).set(folderName, next);
    });
  };

  // 扁平化列表条目：文件夹标签 + 会话项（Virtuoso 虚拟化渲染；React Compiler 自动缓存）
  const entries = ((): SidebarEntry[] => {
    const list: SidebarEntry[] = [];
    for (const [folderName, folderSessions] of groupedSessions) {
      list.push({ type: 'label', name: folderName });
      if (collapsedFolders.has(folderName)) {
        continue;
      }
      // 按拖拽覆盖顺序排列（未覆盖时保持服务端顺序）
      const byId = new Map(folderSessions.map((s) => [s.id, s]));
      const ordered = orderOverrides.get(folderName) ?? folderSessions.map((s) => s.id);
      for (const id of ordered) {
        const session = byId.get(id);
        if (session !== undefined) {
          list.push({ type: 'item', session });
        }
      }
    }
    return list;
  })();
  // dnd-kit SortableContext 所需的可见会话 id（仅未折叠文件夹）
  const sortableIds = ((): string[] => {
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.type === 'item') {
        ids.push(entry.session.id);
      }
    }
    return ids;
  })();

  // 点击「新建会话」：清空激活会话 + 进入欢迎页模式 + 跳转首页
  // 对齐原型 prototype-v2.html:13306-13336：
  // - 自动复用 workingDir：优先取当前激活会话的 workingDir
  //   若无激活会话，取 sessions 列表第一个（最近）的 workingDir
  //   若都无（首次启动 / 无历史会话），使用 null（「未选择项目」）
  // - 不弹原生目录选择对话框（由 HomePage composer-project-bar 的 folder dropdown 选择）
  // - 进入欢迎页后用户可继续编辑输入框，发送消息时按 pendingWorkingDir 创建会话
  const handleNewChat = (): void => {
    const lastWorkingDir =
      (activeSessionId !== null
        ? sessions.find((s) => s.id === activeSessionId)?.workingDir
        : undefined) ??
      sessions[0]?.workingDir ??
      null;

    clearActiveSession();
    enterWelcomeMode(lastWorkingDir);
    navigate(ROUTES.home);
  };

  // 在指定文件夹内新建会话（对齐原型 fl-add-btn 13338-13412 行为）
  // - 取该文件夹任一 session 的 workingDir 作为 pendingWorkingDir（同文件夹共享目录）
  // - 进入欢迎页模式 + 跳转首页，用户可继续编辑首条消息
  // - 不弹原生对话框（对齐原型 setWelcomeMode(true) + setPendingFolder）
  const handleCreateInFolder = (folderName: string): void => {
    const folderSession = sessions.find((s) => getFolderName(s.workingDir) === folderName);
    const workingDir = folderSession?.workingDir ?? null;
    clearActiveSession();
    enterWelcomeMode(workingDir);
    navigate(ROUTES.home);
  };

  // 点击会话项：设置激活 + 跳转聊天页
  const handleSelectSession = (sessionId: string): void => {
    setActiveSession(sessionId);
    navigate(ROUTES.chatPath(sessionId));
  };

  // 点击删除
  const handleDelete = (sessionId: string): void => {
    deleteSession(sessionId, {
      onSuccess: () => {
        if (sessionId === activeSessionId) {
          clearActiveSession();
          navigate(ROUTES.home);
        }
      },
    });
  };

  return (
    <aside className="sidebar" aria-label={t('sidebar.sessionList')}>
      {/* 顶部：新建会话按钮 + 搜索框 + tabs */}
      <div className="sidebar-head">
        <button type="button" className="new-thread-btn" onClick={handleNewChat}>
          <Plus className="size-3.5" strokeWidth={2.5} />
          {t('sidebar.newSession')}
        </button>
        <div className="sidebar-search">
          <Search className="sidebar-search-icon" size={13} strokeWidth={2} />
          <input
            type="text"
            className="sidebar-search-input"
            placeholder={t('sidebar.searchSessions')}
            aria-label={t('sidebar.searchSessions')}
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
          />
        </div>
        <div className="sidebar-tabs" role="tablist">
          <button
            type="button"
            className={cn('sidebar-tab', activeTab === 'recent' && 'active')}
            role="tab"
            aria-selected={activeTab === 'recent'}
            onClick={() => setActiveTab('recent')}
          >
            {t('sidebar.tabsRecent')} <span className="count">{sessions.length}</span>
          </button>
          <button
            type="button"
            className={cn('sidebar-tab', activeTab === 'files' && 'active')}
            role="tab"
            aria-selected={activeTab === 'files'}
            onClick={() => setActiveTab('files')}
          >
            {t('sidebar.tabsFiles')}
          </button>
          <button
            type="button"
            className={cn('sidebar-tab', activeTab === 'archived' && 'active')}
            role="tab"
            aria-selected={activeTab === 'archived'}
            onClick={() => setActiveTab('archived')}
          >
            {t('sidebar.tabsArchived')} <span className="count">0</span>
          </button>
        </div>
      </div>

      {/* 中间：根据 activeTab 切换会话列表 / 文件树 / 归档 */}
      <div className="sidebar-list">
        {activeTab === 'files' ? (
          <FileTreePanel workingDir={workingDir} />
        ) : (
          <AsyncBoundary
            view={view}
            skeleton={<LoadingList />}
            empty={
              <EmptyState
                title={t('sidebar.noSessions')}
                description={t('sidebar.newSessionHint')}
                actionLabel={t('sidebar.newSession')}
                onAction={handleNewChat}
              />
            }
          >
            {() => (
              <nav aria-label={t('sidebar.sessionList')}>
                <div className="thread-group-label">
                  <span>{t('sidebar.recentSessions')}</span>
                </div>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  {/* 虚拟化列表：标签 + 会话项扁平化渲染（Virtuoso 接管滚动） */}
                  <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                    <Virtuoso
                      data={entries}
                      computeItemKey={(_, entry) =>
                        entry.type === 'label' ? `label:${entry.name}` : entry.session.id
                      }
                      itemContent={(_, entry) => {
                        if (entry.type === 'label') {
                          return (
                            <FolderLabel
                              folderName={entry.name}
                              collapsed={collapsedFolders.has(entry.name)}
                              onToggle={() => toggleFolder(entry.name)}
                              onCreateInFolder={handleCreateInFolder}
                            />
                          );
                        }
                        const session = entry.session;
                        return (
                          <SortableThreadItem
                            key={session.id}
                            sessionId={session.id}
                            folderName={getFolderName(session.workingDir)}
                            title={session.title}
                            lastMessage={session.lastMessage}
                            updatedAt={session.updatedAt}
                            isActive={session.id === activeSessionId}
                            isDeleting={isDeleting}
                            onSelect={() => handleSelectSession(session.id)}
                            onDelete={() => handleDelete(session.id)}
                          />
                        );
                      }}
                    />
                  </SortableContext>
                </DndContext>
              </nav>
            )}
          </AsyncBoundary>
        )}
      </div>

      {/* 底部：用户信息（功能预留，占位） */}
      <div className="sidebar-foot">
        <div className="avatar">U</div>
        <div className="user-info">
          <div className="uname">{t('sidebar.notLoggedIn')}</div>
          <div className="uemail">local-user</div>
        </div>
      </div>
    </aside>
  );
}

// ── 子组件：文件夹标签（Virtuoso 扁平化列表的 label 条目） ────

/** 虚拟化列表条目：文件夹标签 | 会话项 */
type SidebarEntry =
  | { readonly type: 'label'; readonly name: string }
  | {
      readonly type: 'item';
      readonly session: {
        readonly id: string;
        readonly title: string;
        readonly lastMessage: string | undefined;
        readonly updatedAt: number;
        readonly workingDir: string;
      };
    };

interface FolderLabelProps {
  readonly folderName: string;
  /** 是否折叠（折叠时隐藏该组会话项） */
  readonly collapsed: boolean;
  /** 切换折叠 */
  readonly onToggle: () => void;
  /** 在此文件夹内新建会话（fl-add-btn 触发） */
  readonly onCreateInFolder: (folderName: string) => void;
}

/** 文件夹标签：折叠箭头 + 图标 + 名称 + hover 新建按钮 */
function FolderLabel({
  folderName,
  collapsed,
  onToggle,
  onCreateInFolder,
}: FolderLabelProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();

  return (
    <button
      type="button"
      className={cn('folder-label', collapsed && 'collapsed')}
      onClick={onToggle}
      aria-expanded={!collapsed}
    >
      <span className="fl-chevron">
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          role="img"
          aria-label={t('sidebar.collapseFolder')}
        >
          <title>{t('sidebar.collapseFolder')}</title>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </span>
      <span className="fl-icon">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          role="img"
          aria-label={t('sidebar.folder')}
        >
          <title>{t('sidebar.folder')}</title>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      </span>
      <span className="fl-name">{folderName.length > 0 ? folderName : t('sidebar.unlabeled')}</span>
      {/* fl-add-btn：在此文件夹新建会话（对齐原型 5975-5980 行，hover 显示） */}
      {/* biome-ignore lint/a11y/useSemanticElements: 嵌套在 <button> 内，HTML 规范禁止 button-in-button，用 span[role=button] 绕过 */}
      <span
        className="fl-add-btn"
        role="button"
        tabIndex={0}
        aria-label={t('sidebar.newSessionIn', { name: folderName })}
        title={t('sidebar.newSessionInFolder')}
        onClick={(event) => {
          event.stopPropagation();
          onCreateInFolder(folderName);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            onCreateInFolder(folderName);
          }
        }}
      >
        <Plus className="size-3" strokeWidth={2.5} />
      </span>
    </button>
  );
}

// ── 子组件：可拖拽会话项（@dnd-kit/sortable 包装） ────────────

interface SortableThreadItemProps {
  readonly sessionId: string;
  readonly folderName: string;
  readonly title: string;
  readonly lastMessage: string | undefined;
  readonly updatedAt: number;
  readonly isActive: boolean;
  readonly isDeleting: boolean;
  readonly onSelect: () => void;
  readonly onDelete: () => void;
}

/** 可拖拽会话项：useSortable 提供拖拽句柄属性，ti-dot 作为手柄 */
function SortableThreadItem({
  sessionId,
  folderName,
  title,
  lastMessage,
  updatedAt,
  isActive,
  isDeleting,
  onSelect,
  onDelete,
}: SortableThreadItemProps): ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sessionId,
    data: { folder: folderName },
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform:
          transform === null ? undefined : `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        transition,
      }}
      className={isDragging ? 'opacity-50' : undefined}
    >
      <ThreadItem
        title={title}
        lastMessage={lastMessage}
        updatedAt={updatedAt}
        isActive={isActive}
        isDeleting={isDeleting}
        onSelect={onSelect}
        onDelete={onDelete}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

// ── 子组件：会话列表项（对齐原型 thread-item 结构） ──────────────

interface ThreadItemProps {
  readonly title: string;
  readonly lastMessage: string | undefined;
  readonly updatedAt: number;
  readonly isActive: boolean;
  readonly isDeleting: boolean;
  readonly onSelect: () => void;
  readonly onDelete: () => void;
  /** 拖拽手柄属性（@dnd-kit useSortable 的 attributes + listeners，挂在 ti-dot 上） */
  readonly dragHandleProps?: Record<string, unknown>;
}

/** 会话列表项 - 对齐原型 .thread-item 结构 */
function ThreadItem({
  title,
  lastMessage,
  updatedAt,
  isActive,
  isDeleting,
  onSelect,
  onDelete,
  dragHandleProps,
}: ThreadItemProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 元信息：时间 + 预览（取 lastMessage 前 20 字符）
  const metaParts: string[] = [formatRelativeTime(updatedAt, t)];
  if (lastMessage !== undefined && lastMessage.length > 0) {
    const preview = lastMessage.length > 20 ? `${lastMessage.slice(0, 20)}…` : lastMessage;
    metaParts.push(preview);
  }
  const metaText = metaParts.join(' · ');

  return (
    // biome-ignore lint/a11y/useSemanticElements: 外层含 DropdownMenu 触发器（button），HTML 禁止 button 嵌套
    <div
      role="button"
      tabIndex={0}
      className={cn('thread-item', isActive && 'active')}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      aria-current={isActive ? 'page' : undefined}
    >
      <div className="ti-row">
        {/* ti-dot：拖拽手柄（dnd-kit），hover 显示抓取光标；不参与点击选择（title 提供可访问说明） */}
        <span
          className="ti-dot cursor-grab active:cursor-grabbing"
          title={t('sidebar.dragSort')}
          {...dragHandleProps}
        />
        <div className="ti-content">
          <div className="ti-title" title={title}>
            {title}
          </div>
          <div className="ti-meta">{metaText}</div>
        </div>
        <div className="ti-actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:bg-sidebar-accent-foreground/10 hover:text-sidebar-foreground h-6 w-6"
                aria-label={t('sidebar.sessionActions')}
                disabled={isDeleting}
                onClick={(event) => event.stopPropagation()}
              >
                <MoreVertical className="size-3.5" strokeWidth={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  onDelete();
                }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="size-3.5" strokeWidth={1.5} />
                删除会话
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

// ── 子组件：加载中 / 空状态 ───────────────────────────────────

/** 加载中骨架屏（5 行占位） */
function LoadingList(): ReactElement {
  return (
    <ul className="flex flex-col gap-1 p-1">
      {Array.from({ length: 5 }).map((_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架屏占位，index 稳定且无重排
        <li key={index} className="px-2 py-2">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="mt-2 h-2 w-1/2" />
        </li>
      ))}
    </ul>
  );
}
