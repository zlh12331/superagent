/**
 * FileTreeNode — 单个文件树节点组件
 *
 * 对应 prototype.html `.ft-node`：
 * - 缩进按 level 计算（paddingLeft = 8 + level * 14）
 * - 文件夹：chevron 可点击展开/折叠，名称 font-medium
 * - 文件：chevron 隐藏（占位保留对齐），名称 text-dim
 * - 选中态：accent-glow 背景 + accent 文字色
 * - 右键触发 onContextMenu 回调
 */

import { memo } from 'react'
import { ChevronRight } from 'lucide-react'
import type { FileTreeNode as FileTreeNodeType } from './types'
import { cn } from '@/lib/utils'
import { FileIcon } from './FileIcon'

interface FileTreeNodeProps {
  /** 当前节点数据 */
  node: FileTreeNodeType
  /** 缩进层级（根节点为 0） */
  level: number
  /** 是否选中 */
  isActive: boolean
  /** 是否展开（仅 folder 有意义） */
  isExpanded: boolean
  /** 点击节点回调（选中或折叠/展开） */
  onSelect: (node: FileTreeNodeType) => void
  /** 切换展开状态回调（点击 chevron） */
  onToggle: (node: FileTreeNodeType) => void
  /** 右键菜单回调 */
  onContextMenu: (e: React.MouseEvent, node: FileTreeNodeType) => void
}

function FileTreeNodeComponent({
  node,
  level,
  isActive,
  isExpanded,
  onSelect,
  onToggle,
  onContextMenu,
}: FileTreeNodeProps) {
  const isFolder = node.type === 'folder'

  function handleClick() {
    // 文件夹点击 chevron 区域切换展开；点击名称也选中
    if (isFolder) {
      onToggle(node)
    }
    onSelect(node)
  }

  function handleChevronClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (isFolder) {
      onToggle(node)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleClick()
    } else if (e.key === 'ArrowRight' && isFolder && !isExpanded) {
      e.preventDefault()
      onToggle(node)
    } else if (e.key === 'ArrowLeft' && isFolder && isExpanded) {
      e.preventDefault()
      onToggle(node)
    }
  }

  return (
    <div
      role="treeitem"
      aria-label={node.name}
      aria-expanded={isFolder ? isExpanded : undefined}
      aria-selected={isActive}
      tabIndex={-1}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onContextMenu={e => onContextMenu(e, node)}
      style={{ paddingLeft: 8 + level * 14 }}
      className={cn(
        'flex min-w-0 cursor-pointer items-center gap-1 rounded px-2 py-[3px] font-mono text-[12px] transition-colors',
        isFolder ? 'font-medium text-[var(--text)]' : 'text-[var(--text-dim)]',
        'hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]',
        isActive && 'bg-[var(--accent-glow)] text-[var(--accent)]'
      )}
    >
      {/* 折叠箭头：文件夹可点击切换；文件用 invisible 占位以保持图标对齐 */}
      <ChevronRight
        width={10}
        height={10}
        strokeWidth={2.5}
        onClick={handleChevronClick}
        className={cn(
          'shrink-0 cursor-pointer text-[var(--text-faint)] transition-transform duration-150',
          isExpanded && 'rotate-90',
          !isFolder && 'invisible'
        )}
        aria-hidden
      />
      <FileIcon name={node.name} isFolder={isFolder} expanded={isExpanded} />
      <span className="truncate">{node.name}</span>
    </div>
  )
}

// 使用 memo 包裹：文件树节点仅在自身 props 变化时重渲染，
// 避免 fs/watch 事件触发 invalidateFileTree 时全量重渲染所有可见节点
export const FileTreeNode = memo(FileTreeNodeComponent)
