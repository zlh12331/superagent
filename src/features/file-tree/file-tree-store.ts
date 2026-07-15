/**
 * 文件树状态管理（Zustand）— 仅保留纯 UI 状态
 *
 * 状态管理决策树位置：
 *   useState → Zustand → TanStack Query
 *   文件树数据（服务端持久化数据）已迁移到 TanStack Query（src/queries/file-tree.ts），
 *   本 store 仅保留纯 UI 状态：展开/折叠路径集合、选中项、侧栏视图切换、右键菜单状态。
 *
 * 迁移说明：
 *   - tree / loading / setTree / setLoading / refresh 已移除，
 *     由 useFileTree hook 替代
 *   - 保留 expandedPaths / selectedPath / sidebarView / contextMenu 及对应 setter
 *
 * 设计要点：
 * - expandedPaths 用 Set 存储，更新时整体替换以触发 React 重渲染
 * - contextMenu 包含位置 + 节点信息，关闭时置为 null
 */

import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { ContextMenuPosition, FileTreeNode, SidebarView } from './types'

/** 右键菜单完整状态：位置 + 目标节点信息 */
export interface FileTreeContextMenuState {
  position: ContextMenuPosition
  nodePath: string
  nodeType: 'file' | 'folder'
}

export interface FileTreeState {
  /** 已展开的文件夹路径集合 */
  expandedPaths: Set<string>
  /** 当前选中节点路径（null 表示无选中） */
  selectedPath: string | null
  /** 当前侧栏视图 */
  sidebarView: SidebarView
  /** 右键菜单状态（null 表示关闭） */
  contextMenu: FileTreeContextMenuState | null
  /**
   * 根目录是否已自动展开。
   * 初次加载文件树时自动展开根目录（初始 expandedPaths 为空 Set，
   * 因为根路径在数据加载前未知）。此标志防止每次刷新都重复展开。
   */
  rootAutoExpanded: boolean

  // 操作方法
  /** 切换某文件夹的展开/折叠状态 */
  toggleExpand: (path: string) => void
  /** 设置某文件夹的展开状态（true=展开 / false=折叠） */
  setExpanded: (path: string, expanded: boolean) => void
  /** 设置当前选中节点 */
  setSelectedPath: (path: string | null) => void
  /** 切换侧栏视图 */
  setSidebarView: (view: SidebarView) => void
  /** 设置右键菜单状态（传 null 关闭） */
  setContextMenu: (menu: FileTreeContextMenuState | null) => void
  /** 标记根目录已自动展开（首次加载后调用） */
  setRootAutoExpanded: (done: boolean) => void
}

/**
 * FileTree Store creator —— Zustand 状态切片工厂。
 *
 * 不直接调用 `create()`，便于在测试中将此 creator 传入独立的 store 实例，
 * 避免污染全局单例。模式与 src/store/* 中的其他 store 一致。
 *
 * 实现要点：
 *  - expandedPaths 使用 Set 存储已展开路径，更新时整体替换新 Set 以触发 React 重渲染
 *    （直接 mutate Set 不会触发 Object.is 浅比较）
 *  - contextMenu 包含位置 + 节点信息，关闭时置为 null
 *  - 所有 setter 通过 set 第三参数携带 action 名（devtools 可见）
 *
 * @param set —— Zustand 的 set 函数
 */
const fileTreeStoreCreator: StateCreator<
  FileTreeState,
  [['zustand/devtools', never]]
> = set => ({
  expandedPaths: new Set<string>(),
  selectedPath: null,
  sidebarView: 'threads',
  contextMenu: null,
  // 初始为 false：FileTree 加载到根节点后由 useEffect 自动展开一次，并置为 true
  rootAutoExpanded: false,

  toggleExpand: path =>
    set(
      state => {
        // 必须整体替换 Set 才能触发组件重渲染
        const next = new Set(state.expandedPaths)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        return { expandedPaths: next }
      },
      undefined,
      'toggleExpand'
    ),

  setExpanded: (path, expanded) =>
    set(
      state => {
        const next = new Set(state.expandedPaths)
        if (expanded) {
          next.add(path)
        } else {
          next.delete(path)
        }
        return { expandedPaths: next }
      },
      undefined,
      'setExpanded'
    ),

  setSelectedPath: path =>
    set({ selectedPath: path }, undefined, 'setSelectedPath'),

  setSidebarView: view =>
    set({ sidebarView: view }, undefined, 'setSidebarView'),

  setContextMenu: menu =>
    set({ contextMenu: menu }, undefined, 'setContextMenu'),

  // 标记根目录已自动展开，避免每次刷新文件树都重复展开
  setRootAutoExpanded: done =>
    set({ rootAutoExpanded: done }, undefined, 'setRootAutoExpanded'),
})

/**
 * FileTree Store 单例 hook。
 *
 * 通过 Zustand `create()` 创建全局唯一实例，并启用 devtools middleware
 * 便于在 Redux DevTools 中观察 state 变更（name='file-tree-store'）。
 *
 * @example
 * const expandedPaths = useFileTreeStore(s => s.expandedPaths)
 * const toggleExpand = useFileTreeStore(s => s.toggleExpand)
 */
export const useFileTreeStore = create<FileTreeState>()(
  devtools(fileTreeStoreCreator, {
    name: 'file-tree-store',
  })
)

// 保留 FileTreeNode 类型导出，供外部使用
export type { FileTreeNode }
