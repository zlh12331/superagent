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
import { type ReactElement, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
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
  useSessionsFlat,
} from '@/hooks/use-sessions';
import { useSidebarHighlight } from '@/hooks/use-sidebar-highlight';
import { useWorkingDir } from '@/hooks/use-working-dir';
import { useTranslation } from '@/i18n/use-translation';
import { openExternal } from '@/lib/app-actions';
import { ROUTES } from '@/lib/constants';
import { springTransition } from '@/lib/motion';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useSidebarPrefStore } from '@/stores/persistent/sidebar-pref-store';
import {
  selectPendingApprovalSessionIds,
  useApprovalsStore,
} from '@/stores/transient/approvals-store';
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
  openExternal(`file:///${dir.replace(/\\/g, '/')}`).catch(() => {
    toast.error(message);
  });
}

/** 左侧栏：会话列表（分页/搜索/置顶分组）+ 快捷导航 + 账户区 */
export function Sidebar(): ReactElement {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const query = useSessionsFlat();
  const sessions = query.data ?? [];
  const hasMore = query.hasNextPage === true && query.isFetchingNextPage === false;
  const view = useAsyncView(
    {
      ...query,
      data: query.data === undefined ? undefined : { sessions, total: sessions.length },
    } as unknown as UseQueryResult<SessionListData, Error>,
    { isEmpty: (d) => d.sessions.length === 0 },
  );
  const { mutate: deleteSession, isPending: isDeleting } = useDeleteSession();
  const { mutate: pinSession } = usePinSession();
  /** 置顶切换：mutation 触发（invalidate 自动重排） */
  const togglePin = (sessionId: string, pinned: boolean): void => {
    pinSession({ id: sessionId, pinned });
  };
  const activeSessionId = useActiveSessionStore((state) => state.activeSessionId);
  const setActiveSession = useActiveSessionStore((state) => state.setActiveSession);
  const clearActiveSession = useActiveSessionStore((state) => state.clearActiveSession);
  const enterWelcomeMode = useWelcomeStore((state) => state.enterWelcomeMode);

  const [searchKeyword, setSearchKeyword] = useState('');
  const isSearching = searchKeyword.trim().length > 0;
  const filteredSessions = filterSessions(sessions, searchKeyword);

  const { highlightedIds: highlightedThreadIds } = useSidebarHighlight(searchKeyword, sessions);
  const sidebarView = useUiStore((state) => state.sidebarView);
  const setSidebarView = useUiStore((state) => state.setSidebarView);

  const workingDir = useWorkingDir(activeSessionId);

  const groupedSessions = groupSessionsByFolder(filteredSessions);

  const orderOverrides = useSidebarPrefStore((s) => s.orderOverrides);
  const setOrderOverride = useSidebarPrefStore((s) => s.setOrderOverride);
  const collapsedFolders = useSidebarPrefStore((s) => s.collapsedFolders);
  const toggleFolder = useSidebarPrefStore((s) => s.toggleFolder);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const pendingApprovalSessionIds = useApprovalsStore(useShallow(selectPendingApprovalSessionIds));

  /** 拖拽结束：同文件夹内重排（跨文件夹拖拽被 folder 归属过滤）；覆盖写入持久化 store */
  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (over === null || active.id === over.id) {
      return;
    }
    const folderName = String(active.data.current?.['folder'] ?? '');
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

  const { entries, sortableIds } = buildSidebarEntries({
    sessions,
    groupedSessions,
    collapsedFolders,
    isSearching,
    orderOverrides,
  });

  const handleNewChat = (): void => {
    const lastWorkingDir =
      (activeSessionId !== null
        ? sessions.find((s) => s.id === activeSessionId)?.workingDir
        : undefined) ??
      sessions[0]?.workingDir ??
      null;

    clearActiveSession();
    enterWelcomeMode(lastWorkingDir);
    setSearchKeyword('');
    navigate(ROUTES.home);
  };

  const handleCreateInFolder = (folderName: string): void => {
    const folderSession = sessions.find((s) => getFolderName(s.workingDir) === folderName);
    const workingDir = folderSession?.workingDir ?? null;
    clearActiveSession();
    enterWelcomeMode(workingDir);
    setSearchKeyword('');
    navigate(ROUTES.home);
  };

  const handleSelectSession = (sessionId: string): void => {
    setActiveSession(sessionId);
    navigate(ROUTES.chatPath(sessionId));
  };

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

  /** 取某文件夹下任一会话的 workingDir（同文件夹共享目录） */
  const findFolderWorkingDir = (folderName: string): string | undefined =>
    sessions.find((s) => getFolderName(s.workingDir) === folderName)?.workingDir;

  /** 右键菜单「在资源管理器中打开」：取该组目录交给系统文件管理器 */
  const handleOpenFolderInExplorer = (folderName: string): void => {
    const dir = findFolderWorkingDir(folderName);
    if (dir !== undefined) {
      openInFileManager(dir, t('common.openInExplorerFailed'));
    }
  };

  /** 右键菜单「删除文件夹」：确认后批量删除该组会话 */
  const handleDeleteFolder = async (folderName: string): Promise<void> => {
    const folderSessions = sessions.filter((s) => getFolderName(s.workingDir) === folderName);
    const ok = await confirm({
      title: t('sidebar.deleteFolderConfirmTitle', { name: folderName }),
      message: t('sidebar.deleteFolderConfirmDesc'),
      danger: true,
    });
    if (!ok) return;
    for (const s of folderSessions) {
      deleteSession(s.id);
    }
  };

  return (
    <aside className="sidebar" aria-label={t('sidebar.sessionList')}>
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

      <div className="sidebar-list">
        {sidebarView === 'fileTree' ? (
          <FileTreePanel workingDir={workingDir} />
        ) : (
          <AsyncBoundary
            view={view}
            skeleton={<LoadingList />}
            empty={
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
                  className="h-full"
                />
              )
            }
          >
            {() => (
              <nav aria-label={t('sidebar.sessionList')} className="flex h-full flex-col">
                <div className="thread-group-label">
                  <span>{t('sidebar.recentSessions')}</span>
                </div>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                    <div className="min-h-0 flex-1 overflow-y-auto pb-2">
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
                              onOpenInExplorer={handleOpenFolderInExplorer}
                              onDeleteFolder={(folderName) => {
                                void handleDeleteFolder(folderName);
                              }}
                            />
                          ) : (
                            <SortableThreadItem
                              key={entry.session.id}
                              sessionId={entry.session.id}
                              folderName={getFolderName(entry.session.workingDir)}
                              title={entry.session.title}
                              updatedAt={entry.session.updatedAt}
                              isActive={entry.session.id === activeSessionId}
                              isDeleting={isDeleting}
                              isPinned={entry.session.pinned === true}
                              isRunning={entry.session.lastRunStatus === 'running'}
                              hasPendingApproval={pendingApprovalSessionIds.includes(
                                entry.session.id,
                              )}
                              highlighted={highlightedThreadIds.has(entry.session.id)}
                              onSelect={() => handleSelectSession(entry.session.id)}
                              onDelete={() => handleDelete(entry.session.id)}
                              onTogglePin={() =>
                                togglePin(entry.session.id, entry.session.pinned !== true)
                              }
                              onOpenFiles={() => {
                                handleSelectSession(entry.session.id);
                                setSidebarView('fileTree');
                              }}
                              onOpenInExplorer={() => {
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

      <SidebarAccount />
    </aside>
  );
}
