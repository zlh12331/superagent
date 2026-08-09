// src/renderer/components/layout/Sidebar.tsx
// 侧边栏 · 组装层（会话列表/文件夹标签/线程项/加载态提取至独立文件）
// ──────────────────────────────────────────────
// 拆分背景（2026-08 重构）：原文件 641 行，按职责拆分：
// - folder-label.tsx：文件夹标签
// - thread-item.tsx：会话线程项（含拖拽排序）
// - loading-list.tsx：加载占位
// - sidebar-utils.ts：纯函数
// ──────────────────────────────────────────────

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
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { FolderTree, Plus, Search } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { EmptyState } from '@/components/common/EmptyState';
import { FileTreePanel } from '@/components/file-tree/FileTreePanel';
import { SidebarAccount } from '@/components/layout/sidebar-account';
import { useAsyncView } from '@/hooks/use-async-view';
import { useDeleteSession, useSessionsQuery } from '@/hooks/use-sessions';
import { useTranslation } from '@/i18n/use-translation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useSidebarPrefStore } from '@/stores/persistent/sidebar-pref-store';
import { useUiStore } from '@/stores/transient/ui-store';
import { useWelcomeStore } from '@/stores/transient/welcome-store';

import { FolderLabel } from './folder-label';
import { LoadingList } from './loading-list';
import { getFolderName } from './sidebar-utils';
import { SortableThreadItem } from './thread-item';

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
  // 当前激活的 tab（recent / archived；文件树是独立视图 sidebarView，不进 tablist）
  const [activeTab, setActiveTab] = useState<'recent' | 'archived'>('recent');
  // 侧栏视图（文件树为独立视图：对齐参考项目 codex.openFileTree 命令切换）
  const sidebarView = useUiStore((state) => state.sidebarView);
  const setSidebarView = useUiStore((state) => state.setSidebarView);

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
  // 显式 useMemo：React Compiler 对 IIFE 的自动缓存可能滞后于异步 query 数据到位，
  // 导致 reload 后列表首次以空数据计算并被缓存（虚拟列表静默空渲染）
  const groupedSessions = useMemo(() => {
    const groups = new Map<string, typeof sessions>();
    for (const session of sessions) {
      const folderName = getFolderName(session.workingDir);
      const existing = groups.get(folderName) ?? [];
      groups.set(folderName, [...existing, session]);
    }
    return groups;
  }, [sessions]);

  // 拖拽排序覆盖 + 折叠文件夹：持久化到 localStorage（sidebar-pref-store）——
  // 用户显式操作跨重启保留（此前本地 useState 刷新即丢）
  const orderOverrides = useSidebarPrefStore((s) => s.orderOverrides);
  const setOrderOverride = useSidebarPrefStore((s) => s.setOrderOverride);
  const collapsedFolders = useSidebarPrefStore((s) => s.collapsedFolders);
  const toggleFolder = useSidebarPrefStore((s) => s.toggleFolder);
  // PointerSensor：拖拽需移动 4px 才激活（避免与点击选择冲突）
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  /** 拖拽结束：同文件夹内重排（跨文件夹拖拽被 folder 归属过滤）；覆盖写入持久化 store */
  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (over === null || active.id === over.id) {
      return;
    }
    const folderName = String(active.data.current?.['folder'] ?? '');
    // 当前顺序：优先拖拽覆盖，否则取该文件夹的默认（服务端）顺序
    const folderSessions = sessions.filter((s) => getFolderName(s.workingDir) === folderName);
    const current = orderOverrides[folderName] ?? folderSessions.map((s) => s.id);
    const oldIndex = current.indexOf(String(active.id));
    const newIndex = current.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) {
      return;
    }
    const next = arrayMove([...current], oldIndex, newIndex);
    setOrderOverride(folderName, next);
  };

  // 扁平化列表条目：文件夹标签 + 会话项（Virtuoso 虚拟化渲染）
  // 显式 useMemo（同 groupedSessions）：避免 Compiler 缓存异步数据到位前的空计算
  const entries = useMemo((): SidebarEntry[] => {
    const list: SidebarEntry[] = [];
    for (const [folderName, folderSessions] of groupedSessions) {
      list.push({ type: 'label', name: folderName });
      if (collapsedFolders.includes(folderName)) {
        continue;
      }
      // 按拖拽覆盖顺序排列（未覆盖时保持服务端顺序）
      const byId = new Map(folderSessions.map((s) => [s.id, s]));
      const ordered = orderOverrides[folderName] ?? folderSessions.map((s) => s.id);
      for (const id of ordered) {
        const session = byId.get(id);
        if (session !== undefined) {
          list.push({ type: 'item', session });
        }
      }
    }
    return list;
  }, [groupedSessions, collapsedFolders, orderOverrides]);
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
        {/* 文件树视图切换按钮（对齐原型 sidebar-filetree 入口；
            此前仅命令面板可达，侧栏无直接入口） */}
        <button
          type="button"
          className={cn('icon-btn sidebar-filetree-btn', sidebarView === 'fileTree' && 'active')}
          onClick={() => setSidebarView(sidebarView === 'fileTree' ? 'threads' : 'fileTree')}
          aria-label={t('sidebar.fileTree')}
          title={t('sidebar.fileTree')}
        >
          <FolderTree className="size-3.5" strokeWidth={1.5} />
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
            className={cn('sidebar-tab', activeTab === 'archived' && 'active')}
            role="tab"
            aria-selected={activeTab === 'archived'}
            onClick={() => setActiveTab('archived')}
          >
            {t('sidebar.tabsArchived')} <span className="count">0</span>
          </button>
        </div>
      </div>

      {/* 中间：会话列表 / 归档 / 文件树（文件树为独立视图 sidebarView，对齐参考项目） */}
      <div className="sidebar-list">
        {sidebarView === 'fileTree' ? (
          <FileTreePanel workingDir={workingDir} />
        ) : activeTab === 'archived' ? (
          <EmptyState
            title={t('sidebar.noArchived')}
            description={t('sidebar.noArchivedHint')}
            className="h-full"
          />
        ) : (
          <AsyncBoundary
            view={view}
            skeleton={<LoadingList />}
            empty={
              // 空态无 CTA：侧栏头部已有「新建会话」按钮，重复按钮冗余（对齐原型空态）
              <EmptyState
                title={t('sidebar.noSessions')}
                description={t('sidebar.newSessionHint')}
                // h-full：空态在列表区垂直居中（对齐参考项目空态视觉）
                className="h-full"
              />
            }
          >
            {() => (
              // h-full：高度链传递（sidebar-list → nav → Virtuoso），
              // 缺链时 Virtuoso 视口高度 0 → 虚拟列表不渲染任何会话项
              <nav aria-label={t('sidebar.sessionList')} className="h-full">
                <div className="thread-group-label">
                  <span>{t('sidebar.recentSessions')}</span>
                </div>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  {/* 会话列表：普通滚动渲染（去 Virtuoso）——
                      会话量级（几十条）无需虚拟化；react-virtuoso 在 React 19 + Compiler
                      下存在 data 空→非空更新时序 bug（reload 后列表静默空渲染），
                      虚拟化收益低，普通滚动彻底规避 */}
                  <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                    <div className="h-full overflow-y-auto pb-2">
                      {entries.map((entry) =>
                        entry.type === 'label' ? (
                          <FolderLabel
                            key={`label:${entry.name}`}
                            folderName={entry.name}
                            collapsed={collapsedFolders.includes(entry.name)}
                            onToggle={() => toggleFolder(entry.name)}
                            onCreateInFolder={handleCreateInFolder}
                          />
                        ) : (
                          <SortableThreadItem
                            key={entry.session.id}
                            sessionId={entry.session.id}
                            folderName={getFolderName(entry.session.workingDir)}
                            title={entry.session.title}
                            lastMessage={entry.session.lastMessage}
                            updatedAt={entry.session.updatedAt}
                            isActive={entry.session.id === activeSessionId}
                            isDeleting={isDeleting}
                            onSelect={() => handleSelectSession(entry.session.id)}
                            onDelete={() => handleDelete(entry.session.id)}
                          />
                        ),
                      )}
                    </div>
                  </SortableContext>
                </DndContext>
              </nav>
            )}
          </AsyncBoundary>
        )}
      </div>

      {/* 底部：账户触发器 + 下拉菜单（对齐参考项目 SidebarAccountSection） */}
      <SidebarAccount />
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

/** 文件夹标签：折叠箭头 + 图标 + 名称 + hover 新建按钮 */
