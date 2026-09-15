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
// - sidebar-foot：用户信息区域（SidebarAccount 账户触发器 + 下拉菜单）
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
import type { UseQueryResult } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { motion } from 'motion/react';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { EmptyState } from '@/components/common/EmptyState';
import { FileTreePanel } from '@/components/file-tree/FileTreePanel';
import { SidebarAccount } from '@/components/layout/sidebar-account';
import { Button } from '@/components/ui/button';
import { useAsyncView } from '@/hooks/use-async-view';
import {
  type SessionListData,
  useDeleteSession,
  usePinSession,
  useSessionsQuery,
} from '@/hooks/use-sessions';
import { useWorkingDir } from '@/hooks/use-working-dir';
import { useTranslation } from '@/i18n/use-translation';
import {
  ROUTES,
  SEARCH_HIGHLIGHT_DEBOUNCE_MS,
  SEARCH_HIGHLIGHT_EXPIRE_MS,
  SEARCH_HIGHLIGHT_MIN_CHARS,
} from '@/lib/constants';
import { springTransition } from '@/lib/motion';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useSidebarPrefStore } from '@/stores/persistent/sidebar-pref-store';
import { confirm } from '@/stores/transient/confirm-dialog-store';
import { useUiStore } from '@/stores/transient/ui-store';
import { useWelcomeStore } from '@/stores/transient/welcome-store';

import { FolderLabel } from './folder-label';
import { LoadingList } from './loading-list';
import {
  buildSidebarEntries,
  filterSessions,
  getFolderName,
  groupSessionsByFolder,
} from './sidebar-utils';
import { SortableThreadItem } from './thread-item';

/**
 * 在系统文件管理器中打开目录（模块级提取：保持 Sidebar 函数体精简，棘轮只允许下降）。
 *
 * 失败时 toast 提示：此前 `.catch(() => {})` 完全静默，用户点了「在资源管理器中打开」
 * 却毫无反应、也无任何线索。
 */
function openInFileManager(dir: string, message: string): void {
  void window.api.app.openExternal({ url: `file:///${dir.replace(/\\/g, '/')}` }).catch(() => {
    toast.error(message);
  });
}

export function Sidebar(): ReactElement {
  const navigate = useNavigate();
  // 本地化文案
  const { t } = useTranslation();

  // L3 TanStack Query：会话列表数据（P3：无限分页）
  const query = useSessionsQuery();
  // 平铺分页数据为会话列表（useInfiniteQuery 的 data.pages 结构）
  const sessions = useMemo(
    () => query.data?.pages.flatMap((page) => page.sessions) ?? [],
    [query.data],
  );
  const hasMore = query.hasNextPage === true && query.isFetchingNextPage === false;
  // 视图状态机映射（五态：loading / refreshing / error / empty / ready）
  // 适配：useAsyncView 消费 UseQueryResult 形状，此处把分页数据投影为单页形状
  const view = useAsyncView(
    {
      ...query,
      data: query.data === undefined ? undefined : { sessions, total: sessions.length },
    } as unknown as UseQueryResult<SessionListData, Error>,
    { isEmpty: (d) => d.sessions.length === 0 },
  );
  // L3 TanStack Mutation：删除会话
  const { mutate: deleteSession, isPending: isDeleting } = useDeleteSession();
  // L3 TanStack Mutation：置顶/取消置顶（对齐参考项目 pinned-header 分组）
  const { mutate: pinSession } = usePinSession();
  /** 置顶切换：mutation 触发（invalidate 自动重排） */
  const togglePin = (sessionId: string, pinned: boolean): void => {
    pinSession({ id: sessionId, pinned });
  };
  // L2 Zustand：激活会话 id
  const activeSessionId = useActiveSessionStore((state) => state.activeSessionId);
  const setActiveSession = useActiveSessionStore((state) => state.setActiveSession);
  const clearActiveSession = useActiveSessionStore((state) => state.clearActiveSession);
  // L2 Zustand：欢迎页模式
  const enterWelcomeMode = useWelcomeStore((state) => state.enterWelcomeMode);

  // 搜索过滤（对齐参考项目 filteredThreads：即时过滤，保持输入响应性）
  const [searchKeyword, setSearchKeyword] = useState('');
  const isSearching = searchKeyword.trim().length > 0;
  // 过滤会话：标题或工作目录匹配（大小写不敏感，即时生效）——纯函数见 sidebar-utils
  const filteredSessions = filterSessions(sessions, searchKeyword);

  // 搜索高亮（照搬参考项目 I-S-001/P1-10/11）：
  // - 300ms 防抖后计算匹配项并高亮（非即时，对齐原型 debounce 300ms）
  // - 高亮 2 秒后自动清除（闪烁效果，对齐原型 setTimeout(() => outline='', 2000)）
  // - 少于 2 字符不高亮（对齐原型 if (q.length < 2) return）
  // 即时过滤（filteredSessions）不受影响，保持输入响应性
  const [highlightedThreadIds, setHighlightedThreadIds] = useState<Set<string>>(() => new Set());
  // 高亮过期定时器引用 — 新的防抖触发时清除之前的过期定时器，避免叠加
  const highlightExpireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 通过 ref 读取最新 sessions，避免将 sessions 放入 effect 依赖：
  // sessions 变化（缓存刷新、乐观更新回写）会重置防抖计时器，导致输入过程中
  // 的高亮计算被反复打断。计时器触发时仍能读到最新的 sessions。
  const sessionsRef = useRef(sessions);
  // 在 effect 中同步 ref —— react-hooks/refs 规则禁止在渲染阶段写入 ref.current
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    const q = searchKeyword.trim().toLowerCase();

    // 300ms 防抖后计算匹配项（对齐原型 setTimeout(..., 300)）
    const debounceTimer = setTimeout(() => {
      // 少于 SEARCH_HIGHLIGHT_MIN_CHARS 字符不高亮（对齐原型 q.length < 2 检查）
      // 不主动清除——让之前的高亮自然过期（对齐原型行为）
      if (q.length < SEARCH_HIGHLIGHT_MIN_CHARS) return;

      const matched = new Set<string>();
      // 用 sessionsRef.current 读取最新会话列表，避免将其加入依赖而打断防抖
      for (const s of sessionsRef.current) {
        if (s.title.toLowerCase().includes(q) || s.workingDir.toLowerCase().includes(q)) {
          matched.add(s.id);
        }
      }
      setHighlightedThreadIds(matched);

      // 清除之前的过期定时器（避免多次搜索叠加）
      if (highlightExpireTimerRef.current !== null) {
        clearTimeout(highlightExpireTimerRef.current);
      }
      // 2 秒后自动清除高亮（对齐原型 setTimeout(() => { item.style.outline = ''; }, 2000)）
      highlightExpireTimerRef.current = setTimeout(() => {
        setHighlightedThreadIds(new Set());
        highlightExpireTimerRef.current = null;
      }, SEARCH_HIGHLIGHT_EXPIRE_MS);
    }, SEARCH_HIGHLIGHT_DEBOUNCE_MS);

    return () => clearTimeout(debounceTimer);
    // 仅依赖 searchKeyword；sessions 通过 ref 读取，避免防抖被打断
  }, [searchKeyword]);
  // 组件卸载时清除过期定时器，防止内存泄漏
  useEffect(() => {
    return () => {
      if (highlightExpireTimerRef.current !== null) {
        clearTimeout(highlightExpireTimerRef.current);
        highlightExpireTimerRef.current = null;
      }
    };
  }, []);
  // 侧栏视图（文件树为独立视图：对齐参考项目 codex.openFileTree 命令切换）
  const sidebarView = useUiStore((state) => state.sidebarView);
  const setSidebarView = useUiStore((state) => state.setSidebarView);

  // 派生：当前激活会话的 workingDir（用于文件树面板）
  // 无激活会话时为 null，FileTreePanel 显示空状态
  // 唯一权威入口 useWorkingDir（此前为本地 IIFE find，与 AppShell/终端各读一份镜像）
  const workingDir = useWorkingDir(activeSessionId);

  // 派生：按 workingDir basename 分组（搜索时基于过滤后的会话）
  // （不再手写 useMemo：React Compiler 2026-08-30 起真实生效，自动记忆化接管；
  //   原注释"Compiler 缓存滞后"基于编译器当时从未生效的误判，理由已不成立）
  const groupedSessions = groupSessionsByFolder(filteredSessions);

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

  // 扁平化列表条目：文件夹标签 + 会话项（普通滚动渲染，原 Virtuoso 已移除）。
  // 规则（置顶置前 / 覆盖排序 / 折叠语义）与测试见 sidebar-utils.buildSidebarEntries。
  // （不再手写 useMemo，理由同 groupedSessions：编译器自动记忆化接管）
  const { entries, sortableIds } = buildSidebarEntries({
    sessions,
    groupedSessions,
    collapsedFolders,
    isSearching,
    orderOverrides,
  });

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
    // 清空搜索词，确保新会话界面不被过滤（对齐参考项目 handleCreateThread）
    setSearchKeyword('');
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
    // 清空搜索词，确保新会话界面不被过滤（对齐参考项目 handleCreateThread）
    setSearchKeyword('');
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
        <motion.button
          type="button"
          className="new-thread-btn"
          onClick={handleNewChat}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.96 }}
          transition={springTransition}
        >
          <Plus className="size-3.5" strokeWidth={2.5} />
          {t('sidebar.newSession')}
        </motion.button>
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
        {/* 会话列表标题（2026-09-08：移除「归档」tab——它只渲染永久空态，
            与项目「未实现功能不暴露入口」原则冲突；单 tab 不再需要
            tablist/roving-tabindex 键盘导航语义） */}
        <div className="sidebar-tabs">
          <span className="sidebar-tab active">
            {t('sidebar.tabsRecent')} <span className="count">{sessions.length}</span>
            <motion.span
              layoutId="sidebar-tab-active-bar"
              className="bg-accent absolute inset-x-2 bottom-0 h-[2px] rounded-full"
              transition={springTransition}
            />
          </span>
        </div>
      </div>

      {/* 中间：会话列表 / 文件树（文件树为独立视图 sidebarView，对齐参考项目） */}
      <div className="sidebar-list">
        {sidebarView === 'fileTree' ? (
          // 文件树视图（头部返回/刷新由 FileTreePanel 内部提供——对齐参考项目 FileTree）
          <FileTreePanel workingDir={workingDir} />
        ) : (
          <AsyncBoundary
            view={view}
            skeleton={<LoadingList />}
            empty={
              // 空态无 CTA：侧栏头部已有「新建会话」按钮，重复按钮冗余（对齐原型空态）；
              // 搜索无结果时显示独立文案（对齐参考项目搜索空态三态）
              isSearching ? (
                <EmptyState
                  title={t('sidebar.searchNoResults', { query: searchKeyword })}
                  description={t('sidebar.searchNoResultsHint')}
                  className="h-full"
                />
              ) : (
                <EmptyState
                  title={t('sidebar.noSessions')}
                  description={t('sidebar.newSessionHint')}
                  // h-full：空态在列表区垂直居中（对齐参考项目空态视觉）
                  className="h-full"
                />
              )
            }
          >
            {() => (
              // h-full：高度链传递（sidebar-list → nav → Virtuoso），
              // 缺链时 Virtuoso 视口高度 0 → 虚拟列表不渲染任何会话项
              <nav aria-label={t('sidebar.sessionList')} className="flex h-full flex-col">
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
                    {/* min-h-0 flex-1：label 占高后列表区占剩余高度，避免 nav 溢出导致
                        内容未占满时也显示滚动条（用户标注：2 个会话不该出滚动条） */}
                    <div className="min-h-0 flex-1 overflow-y-auto pb-2">
                      {/* 搜索无结果：显示搜索空态（对齐参考项目搜索空态三态） */}
                      {isSearching && entries.length === 0 ? (
                        <EmptyState
                          title={t('sidebar.searchNoResults', { query: searchKeyword })}
                          description={t('sidebar.searchNoResultsHint')}
                          className="h-full"
                        />
                      ) : (
                        entries.map((entry) =>
                          entry.type === 'label' ? (
                            <FolderLabel
                              key={`label:${entry.name}`}
                              folderName={entry.name}
                              collapsed={collapsedFolders.includes(entry.name)}
                              onToggle={() => toggleFolder(entry.name)}
                              onCreateInFolder={handleCreateInFolder}
                              onOpenInExplorer={(folderName) => {
                                // 在资源管理器中打开文件夹（取该组第一个会话的 workingDir）
                                const dir = sessions.find(
                                  (s) => getFolderName(s.workingDir) === folderName,
                                )?.workingDir;
                                if (dir !== undefined) {
                                  openInFileManager(dir, t('common.openInExplorerFailed'));
                                }
                              }}
                              onDeleteFolder={(folderName) => {
                                // 删除文件夹：确认弹窗后批量删除该组会话
                                const folderSessions = sessions.filter(
                                  (s) => getFolderName(s.workingDir) === folderName,
                                );
                                void confirm({
                                  title: t('sidebar.deleteFolderConfirmTitle', {
                                    name: folderName,
                                  }),
                                  message: t('sidebar.deleteFolderConfirmDesc'),
                                  danger: true,
                                }).then((ok) => {
                                  if (!ok) return;
                                  for (const s of folderSessions) {
                                    deleteSession(s.id);
                                  }
                                });
                              }}
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
                              isPinned={entry.session.pinned === true}
                              highlighted={highlightedThreadIds.has(entry.session.id)}
                              onSelect={() => handleSelectSession(entry.session.id)}
                              onDelete={() => handleDelete(entry.session.id)}
                              onTogglePin={() =>
                                togglePin(entry.session.id, entry.session.pinned !== true)
                              }
                              onOpenFiles={() => {
                                // 对齐原型 showThreadFileTree：先切换到该会话（主区），再打开其文件树
                                handleSelectSession(entry.session.id);
                                setSidebarView('fileTree');
                              }}
                              onOpenInExplorer={() => {
                                // 在资源管理器中打开会话工作目录（对齐同类桌面应用惯例）
                                openInFileManager(
                                  entry.session.workingDir,
                                  t('common.openInExplorerFailed'),
                                );
                              }}
                            />
                          ),
                        )
                      )}
                      {hasMore && !isSearching && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-foreground hover:border-border mt-1 w-full border border-dashed"
                          onClick={() => void query.fetchNextPage()}
                        >
                          {t('sidebar.loadMore')}
                        </Button>
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

/** 文件夹标签：折叠箭头 + 图标 + 名称 + hover 新建按钮 */
