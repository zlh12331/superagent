// src/renderer/stores/transient/file-tree-store.ts
// 文件树状态管理（L2 客户端共享状态层 - transient）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 维护当前根目录（绑定到激活会话的 workingDir）
// - 维护目录展开/折叠状态（path -> 是否展开）
// - 维护激活的文件路径（高亮当前选中文件）
// - 缓存已加载的目录条目（path -> FileEntry[]）
// - 维护加载中目录集合（避免重复请求 + UI 骨架屏）
// - 提供文件变更事件的增量更新（upsert/remove/rename）
// - 维护新建/重命名的内联编辑状态（creatingEntry / renamingPath）
// - 维护操作中路径集合（pendingOps，用于禁用相关 UI 防止重复操作）
//
// 设计：
// - 纯状态容器：不持有 IPC 订阅与请求逻辑（由 useFileTree / useFileTreeOps hook 负责）
// - 扁平化缓存：entries Map 按「父目录路径 -> 子条目数组」组织，避免递归树结构序列化
// - 排序约定：目录在前、文件在后；同类按名称升序（不区分大小写）
// - 内联编辑：新建/重命名时先在 UI 显示临时节点（tempName），用户确认后再调 IPC 落盘
// - 不持久化：文件树状态随会话切换重置，重启后为空
// ──────────────────────────────────────────────────────────────

import type { FileEntry } from '@novel-writer/shared';
import { create } from 'zustand';

/**
 * 新建条目的内联编辑状态
 *
 * 用户点击工具栏「新建文件/目录」或上下文菜单「在此处新建」后，
 * 在指定父目录下渲染一个可编辑的临时节点，用户输入名称后回车确认。
 */
export interface CreatingEntry {
  /** 新建条目所在的父目录（绝对路径） */
  readonly parentDir: string;
  /** 新建类型：文件或目录 */
  readonly type: 'file' | 'directory';
  /** 临时显示的名称（用户输入实时更新，初始为空字符串） */
  readonly tempName: string;
}

/**
 * 文件树状态形状
 */
interface FileTreeState {
  /** 当前根目录（激活会话的 workingDir，无激活会话时为 null） */
  readonly rootPath: string | null;
  /** 已展开的目录路径集合 */
  readonly expandedPaths: ReadonlySet<string>;
  /** 当前激活的文件路径（用于高亮，无选中时为 null） */
  readonly activeFilePath: string | null;
  /** 目录条目缓存：父目录路径 -> 子条目数组（已排序） */
  readonly entries: ReadonlyMap<string, readonly FileEntry[]>;
  /** 加载中的目录路径集合（用于骨架屏展示） */
  readonly loadingPaths: ReadonlySet<string>;
  /** 新建条目的内联编辑状态（null 表示未在新建流程） */
  readonly creatingEntry: CreatingEntry | null;
  /** 重命名目标的路径（null 表示未在重命名流程） */
  readonly renamingPath: string | null;
  /** 操作中的路径集合（创建/删除/重命名进行中，用于禁用相关 UI 防止重复操作） */
  readonly pendingOps: ReadonlySet<string>;

  // ── 浏览/加载方法 ──────────────────────────────────
  /** 设置根目录（会切换会话时调用，自动重置状态并展开根目录） */
  readonly setRootPath: (path: string | null) => void;
  /** 切换目录展开/折叠状态 */
  readonly toggleExpand: (path: string) => void;
  /** 显式设置目录展开状态 */
  readonly setExpanded: (path: string, expanded: boolean) => void;
  /** 设置激活的文件路径（点击文件时调用） */
  readonly setActiveFile: (path: string | null) => void;
  /** 设置指定目录的子条目（list IPC 返回后调用） */
  readonly setEntries: (path: string, entries: readonly FileEntry[]) => void;
  /** 增量更新：新增或替换条目（file:watch create 事件） */
  readonly upsertEntry: (parentDir: string, entry: FileEntry) => void;
  /** 增量更新：移除条目（file:watch delete 事件） */
  readonly removeEntry: (parentDir: string, entryPath: string) => void;
  /** 增量更新：重命名条目（file:watch rename 事件） */
  readonly renameEntry: (parentDir: string, oldPath: string, newEntry: FileEntry) => void;
  /** 设置目录加载状态（list IPC 请求前后调用） */
  readonly setLoading: (path: string, loading: boolean) => void;

  // ── 新建/重命名内联编辑方法 ────────────────────────
  /** 开始新建流程：在指定父目录下显示临时节点，tempName 初始为空 */
  readonly startCreate: (parentDir: string, type: 'file' | 'directory') => void;
  /** 更新临时节点名称（用户输入时实时调用） */
  readonly setCreatingName: (name: string) => void;
  /** 取消新建流程（用户按 Esc 或失焦时调用） */
  readonly cancelCreate: () => void;
  /** 开始重命名流程：标记目标路径，UI 在该节点上显示内联输入框 */
  readonly startRename: (path: string) => void;
  /** 取消重命名流程 */
  readonly cancelRename: () => void;

  // ── 操作中状态方法 ──────────────────────────────────
  /** 标记路径为操作中（创建/删除/重命名 IPC 发起前调用，IPC 完成后清除） */
  readonly setPendingOp: (path: string, pending: boolean) => void;

  /** 重置所有状态（会话切换、组件卸载时调用） */
  readonly reset: () => void;

  // ── 搜索方法 ────────────────────────────────────────
  /** 获取所有已加载的文件路径列表（不包含目录） */
  readonly getAllFilePaths: () => readonly string[];
}

/**
 * 文件树状态 store
 *
 * 不持久化：文件树状态随会话切换重置。
 *
 * @example
 * ```tsx
 * const rootPath = useFileTreeStore((s) => s.rootPath);
 * const expanded = useFileTreeStore((s) => s.expandedPaths);
 * const toggle = useFileTreeStore((s) => s.toggleExpand);
 * ```
 */
export const useFileTreeStore = create<FileTreeState>()((set) => ({
  rootPath: null,
  expandedPaths: new Set<string>(),
  activeFilePath: null,
  entries: new Map<string, readonly FileEntry[]>(),
  loadingPaths: new Set<string>(),
  creatingEntry: null,
  renamingPath: null,
  pendingOps: new Set<string>(),

  setRootPath: (path) =>
    set(() => {
      if (path === null) {
        return {
          rootPath: null,
          expandedPaths: new Set<string>(),
          activeFilePath: null,
          entries: new Map<string, readonly FileEntry[]>(),
          loadingPaths: new Set<string>(),
          creatingEntry: null,
          renamingPath: null,
          pendingOps: new Set<string>(),
        };
      }
      // 切换根目录时重置状态，并默认展开根目录
      return {
        rootPath: path,
        expandedPaths: new Set<string>([path]),
        activeFilePath: null,
        entries: new Map<string, readonly FileEntry[]>(),
        loadingPaths: new Set<string>(),
        creatingEntry: null,
        renamingPath: null,
        pendingOps: new Set<string>(),
      };
    }),

  toggleExpand: (path) =>
    set((state) => {
      const next = new Set(state.expandedPaths);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { expandedPaths: next };
    }),

  setExpanded: (path, expanded) =>
    set((state) => {
      const next = new Set(state.expandedPaths);
      if (expanded) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return { expandedPaths: next };
    }),

  setActiveFile: (path) => set(() => ({ activeFilePath: path })),

  setEntries: (path, entries) =>
    set((state) => {
      const next = new Map(state.entries);
      // 排序后存入，保证 UI 渲染稳定（目录在前，同类按名称升序）
      const sorted = [...entries].sort(compareEntries);
      next.set(path, sorted);
      return { entries: next };
    }),

  upsertEntry: (parentDir, entry) =>
    set((state) => {
      const existing = state.entries.get(parentDir) ?? [];
      // 移除同名旧条目（若存在），追加新条目并重新排序
      const filtered = existing.filter((e) => e.name !== entry.name);
      const next = [...filtered, entry].sort(compareEntries);
      const entries = new Map(state.entries);
      entries.set(parentDir, next);
      return { entries };
    }),

  removeEntry: (parentDir, entryPath) =>
    set((state) => {
      const existing = state.entries.get(parentDir);
      if (existing === undefined) return state;
      const next = existing.filter((e) => e.path !== entryPath);
      const entries = new Map(state.entries);
      entries.set(parentDir, next);
      return { entries };
    }),

  renameEntry: (parentDir, oldPath, newEntry) =>
    set((state) => {
      const existing = state.entries.get(parentDir) ?? [];
      // 移除旧路径条目，追加新条目并重新排序
      const filtered = existing.filter((e) => e.path !== oldPath);
      const next = [...filtered, newEntry].sort(compareEntries);
      const entries = new Map(state.entries);
      entries.set(parentDir, next);
      return { entries };
    }),

  setLoading: (path, loading) =>
    set((state) => {
      const next = new Set(state.loadingPaths);
      if (loading) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return { loadingPaths: next };
    }),

  // ── 新建/重命名内联编辑 ─────────────────────────────
  startCreate: (parentDir, type) =>
    set(() => ({
      creatingEntry: { parentDir, type, tempName: '' },
      // 进入新建流程时取消可能的重命名流程，避免两个内联输入框同时显示
      renamingPath: null,
    })),

  setCreatingName: (name) =>
    set((state) => {
      if (state.creatingEntry === null) return state;
      return { creatingEntry: { ...state.creatingEntry, tempName: name } };
    }),

  cancelCreate: () => set(() => ({ creatingEntry: null })),

  startRename: (path) =>
    set(() => ({
      renamingPath: path,
      // 进入重命名流程时取消可能的新建流程
      creatingEntry: null,
    })),

  cancelRename: () => set(() => ({ renamingPath: null })),

  // ── 操作中状态 ──────────────────────────────────────
  setPendingOp: (path, pending) =>
    set((state) => {
      const next = new Set(state.pendingOps);
      if (pending) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return { pendingOps: next };
    }),

  reset: () =>
    set(() => ({
      rootPath: null,
      expandedPaths: new Set<string>(),
      activeFilePath: null,
      entries: new Map<string, readonly FileEntry[]>(),
      loadingPaths: new Set<string>(),
      creatingEntry: null,
      renamingPath: null,
      pendingOps: new Set<string>(),
    })),

  getAllFilePaths: () => {
    const result: string[] = [];
    const state = useFileTreeStore.getState();
    for (const entries of state.entries.values()) {
      for (const entry of entries) {
        if (entry.type !== 'directory') {
          result.push(entry.path);
        }
      }
    }
    return result.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  },
}));

/**
 * 条目排序：目录在前、文件在后；同类按名称升序（不区分大小写）
 *
 * 用于 setEntries / upsertEntry / renameEntry 时保证 UI 渲染稳定。
 */
function compareEntries(a: FileEntry, b: FileEntry): number {
  // 目录在前
  if (a.type === 'directory' && b.type !== 'directory') return -1;
  if (a.type !== 'directory' && b.type === 'directory') return 1;
  // 同类按名称（不区分大小写）
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}
