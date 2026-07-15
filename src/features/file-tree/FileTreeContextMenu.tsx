/**
 * FileTreeContextMenu — 文件树右键菜单
 *
 * 参考现有 ThreadContextMenu 的实现模式：
 * - fixed 定位到点击坐标（带视口边界 clamp）
 * - 点击外部 / Escape 关闭
 * - 菜单项：打开 / 新建文件 / 新建文件夹 / 重命名 / 复制 / 删除
 * - 文件夹节点才显示「新建文件 / 新建文件夹」
 */

import { useEffect, useRef } from 'react'
import {
  Copy,
  FilePlus,
  FileText,
  FolderPlus,
  Pencil,
  Trash2,
} from 'lucide-react'
import type { ContextMenuPosition, FileTreeAction } from './types'

interface FileTreeContextMenuProps {
  /** 菜单显示位置 */
  position: ContextMenuPosition
  /** 触发菜单的节点类型 */
  nodeType: 'file' | 'folder'
  /** 选中某操作时回调 */
  onAction: (action: FileTreeAction) => void
  /** 关闭菜单 */
  onClose: () => void
}

interface MenuItemConfig {
  action: FileTreeAction
  label: string
  icon: React.ReactNode
  danger?: boolean
}

export function FileTreeContextMenu({
  position,
  nodeType,
  onAction,
  onClose,
}: FileTreeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  // 点击外部 / Escape 关闭
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  // 边界 clamp：避免菜单超出视口
  const x = Math.min(position.x, window.innerWidth - 200)
  const y = Math.min(position.y, window.innerHeight - 260)

  // 菜单项分组：用 separator 分隔的二维数组
  const groups: MenuItemConfig[][] = [
    [
      {
        action: 'open',
        label: '打开',
        icon: <FileText width={13} height={13} />,
      },
    ],
  ]

  // 仅文件夹支持新建
  if (nodeType === 'folder') {
    groups.push([
      {
        action: 'newFile',
        label: '新建文件',
        icon: <FilePlus width={13} height={13} />,
      },
      {
        action: 'newFolder',
        label: '新建文件夹',
        icon: <FolderPlus width={13} height={13} />,
      },
    ])
  }

  groups.push([
    {
      action: 'rename',
      label: '重命名',
      icon: <Pencil width={13} height={13} />,
    },
    {
      action: 'copy',
      label: '复制',
      icon: <Copy width={13} height={13} />,
    },
  ])

  groups.push([
    {
      action: 'delete',
      label: '删除',
      icon: <Trash2 width={13} height={13} />,
      danger: true,
    },
  ])

  function handleItemClick(action: FileTreeAction) {
    onAction(action)
    onClose()
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="文件树操作菜单"
      style={{ left: x, top: y }}
      className="fixed z-[var(--z-drawer)] min-w-[160px] rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elev)] p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
    >
      {groups.map((group, gi) => (
        <div key={gi}>
          {gi > 0 && <div className="my-1 h-px bg-[var(--border)]" />}
          {group.map(item => (
            <button
              key={item.action}
              type="button"
              role="menuitem"
              onClick={() => handleItemClick(item.action)}
              className={
                item.danger
                  ? 'flex w-full items-center gap-2 rounded px-2.5 py-[7px] text-left font-sans text-[12px] text-[var(--error)] hover:bg-[rgba(255,107,107,0.1)]'
                  : 'flex w-full items-center gap-2 rounded px-2.5 py-[7px] text-left font-sans text-[12px] text-[var(--text)] hover:bg-[var(--bg-elev-2)]'
              }
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
