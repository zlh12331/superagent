/**
 * Terminal feature — 标签栏组件
 *
 * 水平排列的终端标签，匹配 prototype.html .term-tabs 样式。
 * 每个标签: 图标 + 名称 + 关闭按钮，末尾有 "+" 新建按钮。
 */

import { Terminal as TerminalIcon, Plus } from 'lucide-react'
import type { TerminalId, TerminalSession } from './types'
import { cn } from '@/lib/utils'

interface TerminalTabsProps {
  /** 所有终端会话列表（顺序即 Tab 显示顺序） */
  sessions: TerminalSession[]
  /** 当前激活的会话 ID（用于高亮判定） */
  activeId: TerminalId | null
  /** 点击 Tab 回调（切换激活会话） */
  onSelect: (id: TerminalId) => void
  /** 点击关闭按钮回调（关闭对应会话） */
  onClose: (id: TerminalId) => void
  /** 点击「+」按钮回调（新建会话） */
  onAdd: () => void
}

/**
 * TerminalTabs 组件 —— 终端标签栏。
 *
 * 渲染逻辑：
 *  - 水平排列所有会话 Tab：图标 + 标题（截断） + 关闭按钮（×）
 *  - 激活 Tab 使用 accent 色 + 底部强调线，非激活 Tab hover 时显示淡色背景
 *  - 关闭按钮：激活时常显，非激活时 hover 显示（避免视觉噪音）
 *  - 末尾固定「+」按钮，点击新建会话
 *  - 标签栏横向可滚动（hidden scrollbar），适配大量 Tab 场景
 *
 * 状态依赖：
 *  - 纯展示组件，所有数据与回调通过 props 传入
 *
 * @param props —— 见 TerminalTabsProps 接口
 */
export function TerminalTabs({
  sessions,
  activeId,
  onSelect,
  onClose,
  onAdd,
}: TerminalTabsProps) {
  // 键盘导航：Enter/Space 切换 Tab，Delete/Backspace 关闭 Tab
  const handleKeyDown = (e: React.KeyboardEvent, session: TerminalSession) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(session.id)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      onClose(session.id)
    }
  }

  return (
    <div
      role="tablist"
      aria-label="终端标签"
      className="flex shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b border-[var(--border)] bg-[var(--bg-elev)] px-1 min-h-[30px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {sessions.map((session, index) => {
        const isActive = session.id === activeId
        return (
          <div
            key={session.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={cn(
              'group relative flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-[var(--border)] pl-2.5 pr-2 whitespace-nowrap transition-colors',
              index === 0 && 'border-l border-l-[var(--border)]',
              isActive
                ? 'bg-[var(--bg)] text-[var(--text)] shadow-[inset_0_-1px_0_var(--accent)]'
                : 'bg-transparent text-[var(--text-faint)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]'
            )}
            onClick={() => onSelect(session.id)}
            onKeyDown={e => handleKeyDown(e, session)}
          >
            <TerminalIcon size={12} className="shrink-0 text-[var(--accent)]" />
            <span className="max-w-[100px] overflow-hidden text-ellipsis font-mono text-[11px]">
              {session.title}
            </span>
            <button
              className={cn(
                'ml-0.5 inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent text-[14px] leading-none text-[var(--text-faint)] transition-colors hover:bg-[rgba(239,68,68,0.15)] hover:text-[#ef4444]',
                isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
              onClick={e => {
                e.stopPropagation()
                onClose(session.id)
              }}
              aria-label="关闭终端"
              title="关闭终端"
            >
              ×
            </button>
          </div>
        )
      })}
      <button
        className="inline-flex h-[30px] w-7 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]"
        onClick={onAdd}
        aria-label="新建终端"
        title="新建终端"
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
