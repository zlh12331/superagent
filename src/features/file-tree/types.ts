/**
 * 文件树相关类型定义
 *
 * 描述文件树节点、模糊搜索结果、右键菜单操作等数据结构。
 * 供 file-tree feature 内部组件及外部消费者（如 Sidebar）使用。
 */

/** 文件节点类型：文件或文件夹 */
export type FileNodeType = 'file' | 'folder'

/** 文件树节点 */
export interface FileTreeNode {
  name: string
  path: string
  type: FileNodeType
  /** 子节点（仅 type='folder' 时存在） */
  children?: FileTreeNode[]
}

/** 模糊搜索结果项 */
export interface FuzzySearchResult {
  /** 文件名（含扩展名） */
  title: string
  /** 文件绝对路径 */
  path: string
  /** 匹配分数（0-1，越高越相关） */
  score: number
}

/** 右键菜单操作类型 */
export type FileTreeAction =
  | 'open'
  | 'newFile'
  | 'newFolder'
  | 'rename'
  | 'copy'
  | 'paste'
  | 'delete'
  | 'refresh'

/** 右键菜单位置（基于视口的像素坐标） */
export interface ContextMenuPosition {
  x: number
  y: number
}

/** 侧栏视图切换：会话列表 / 文件树 */
export type SidebarView = 'threads' | 'fileTree'
