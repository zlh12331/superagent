/**
 * ThreadContextMenu — 会话项的右键上下文菜单。
 *
 * 对齐 prototype.html 的 `.ctx-menu`（第 5838-5862 行）：
 * - 重命名 (rename)
 * - 置顶 (pin)
 * - --- separator ---
 * - 归档 (archive) — 已归档时隐藏
 * - 创建副本 (duplicate)
 * - --- separator ---
 * - 删除 (delete) — 危险样式
 *
 * 定位于 clientX/clientY，点击外部或按 Escape 关闭。
 */

import { useEffect, useRef } from 'react'
import { Pencil, Pin, Archive, Copy, Trash2 } from 'lucide-react'

/**
 * 右键菜单的显示位置（基于鼠标 clientX/clientY 计算）。
 */
export interface ContextMenuPosition {
  /** 横坐标（像素，相对视口左上角） */
  x: number
  /** 纵坐标（像素，相对视口左上角） */
  y: number
}

interface ThreadContextMenuProps {
  /** 菜单显示位置 */
  position: ContextMenuPosition
  /** 当前会话是否已归档（归档时隐藏「归档」项） */
  isArchived: boolean
  /** 当前会话是否已删除（删除时隐藏「置顶 / 归档 / 创建副本」） */
  isDeleted: boolean
  /** 当前会话是否已置顶（已置顶时菜单项显示为「取消置顶」） */
  isPinned: boolean
  /** 重命名回调 */
  onRename: () => void
  /** 置顶回调 */
  onPin: () => void
  /** 归档回调 */
  onArchive: () => void
  /** 创建副本回调 */
  onDuplicate: () => void
  /** 删除回调 */
  onDelete: () => void
  /** 关闭菜单回调（点击外部、Escape、菜单项点击后均会触发） */
  onClose: () => void
}

/**
 * ThreadContextMenu 组件 —— 会话项的右键上下文菜单。
 *
 * 渲染逻辑：
 *  - 使用 fixed 定位到鼠标点击坐标
 *  - 视口边界 clamp：x/y 不超过 innerWidth/innerHeight - 菜单宽/高
 *  - 菜单项顺序：重命名 → 置顶 → 分隔 → 归档 → 创建副本 → 分隔 → 删除
 *  - 根据 isArchived / isDeleted 隐藏不适用项
 *
 * 副作用：
 *  - mount 时注册 document mousedown + keydown 监听，实现「点击外部 / Escape 关闭」
 *  - unmount 时移除监听
 *
 * @param props —— 见 ThreadContextMenuProps 接口
 */
export function ThreadContextMenu({
  position,
  isArchived,
  isDeleted,
  isPinned,
  onRename,
  onPin,
  onArchive,
  onDuplicate,
  onDelete,
  onClose,
}: ThreadContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // 监听 contextmenu 事件：用户在菜单外右键时关闭当前菜单
    // （对齐 prototype.html L12024-12026：sidebar 外右键时关闭）
    //
    // 关键：必须检查 e.defaultPrevented —— Sidebar 的 onContextMenu 在 thread item 上右键时
    // 会调用 e.preventDefault() 并 setCtxMenu(新状态)。若不检查 defaultPrevented，
    // 本监听器会随后调用 onClose()→setCtxMenu(null)，由于 React 18 批处理，
    // 后执行的 setCtxMenu(null) 会覆盖 setCtxMenu(新状态)，导致菜单不显示
    // （表现为用户右键会话"没反应"）。
    function handleContextMenuOutside(e: MouseEvent) {
      // 已被 React 合成事件 preventDefault —— 说明在 thread item 上右键，Sidebar 正在处理
      if (e.defaultPrevented) return
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('contextmenu', handleContextMenuOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('contextmenu', handleContextMenuOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  // 将位置限制在视口内，确保菜单不会溢出
  const x = Math.min(position.x, window.innerWidth - 200)
  const y = Math.min(position.y, window.innerHeight - 260)

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="会话操作菜单"
      style={{ left: x, top: y }}
      className="fixed z-[var(--z-drawer)] min-w-[160px] rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elev)] p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
    >
      <ContextMenuItem
        icon={<Pencil width={13} height={13} />}
        label="重命名"
        onClick={() => {
          onRename()
          onClose()
        }}
      />
      {!isDeleted && (
        <ContextMenuItem
          icon={<Pin width={13} height={13} />}
          label={isPinned ? '取消置顶' : '置顶'}
          onClick={() => {
            onPin()
            onClose()
          }}
        />
      )}
      <div className="my-1 h-px bg-[var(--border)]" />
      {!isArchived && !isDeleted && (
        <ContextMenuItem
          icon={<Archive width={13} height={13} />}
          label="归档"
          onClick={() => {
            onArchive()
            onClose()
          }}
        />
      )}
      {!isDeleted && (
        <ContextMenuItem
          icon={<Copy width={13} height={13} />}
          label="创建副本"
          onClick={() => {
            onDuplicate()
            onClose()
          }}
        />
      )}
      <div className="my-1 h-px bg-[var(--border)]" />
      <ContextMenuItem
        icon={<Trash2 width={13} height={13} />}
        label="删除"
        danger
        onClick={() => {
          onDelete()
          onClose()
        }}
      />
    </div>
  )
}

interface ContextMenuItemProps {
  /** 行首图标（lucide-react 节点） */
  icon: React.ReactNode
  /** 行显示文字 */
  label: string
  /** 是否为危险操作（删除）—— 红色文字 + 红色 hover 背景 */
  danger?: boolean
  /** 点击回调（由父组件在调用时附加 onClose） */
  onClick: () => void
}

/**
 * ContextMenuItem —— ThreadContextMenu 内部使用的菜单项组件。
 *
 * 仅在 ThreadContextMenu 内部使用，不对外导出。
 *
 * @param props —— 见 ContextMenuItemProps 接口
 */
function ContextMenuItem({
  icon,
  label,
  danger,
  onClick,
}: ContextMenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={
        danger
          ? 'flex w-full items-center gap-2 rounded px-2.5 py-[7px] text-left font-sans text-[12px] text-[var(--error)] hover:bg-[rgba(255,107,107,0.1)]'
          : 'flex w-full items-center gap-2 rounded px-2.5 py-[7px] text-left font-sans text-[12px] text-[var(--text)] hover:bg-[var(--bg-elev-2)]'
      }
    >
      {icon}
      {label}
    </button>
  )
}
