/**
 * File tree feature — 文件树侧栏
 *
 * 负责文件树展示（展开/折叠、文件图标、右键菜单）、
 * 模糊搜索（连接 fuzzy_file_search_start 命令）、
 * fs watch 事件监听（自动刷新文件树）。
 *
 * 参考源码: prototype.html — 搜索 `file-tree`, `file-search`
 *
 * 组件实现: Task 17
 */

// 文件树主组件（侧栏视图切换时渲染）
export { FileTree } from './FileTree'
// 文件树节点组件
export { FileTreeNode } from './FileTreeNode'
// 文件图标组件
export { FileIcon } from './FileIcon'
// 右键上下文菜单
export { FileTreeContextMenu } from './FileTreeContextMenu'
// 模糊搜索对话框
export { FuzzySearchDialog } from './FuzzySearchDialog'
// 文件树状态管理 store
export { useFileTreeStore } from './file-tree-store'
export type { FileTreeState, FileTreeContextMenuState } from './file-tree-store'
// 类型定义
export type {
  FileNodeType,
  FileTreeNode as FileTreeNodeData,
  FuzzySearchResult,
  FileTreeAction,
  ContextMenuPosition,
  SidebarView,
} from './types'
