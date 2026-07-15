/**
 * ThreadItem — 侧栏列表中的单个会话项。
 *
 * 对应 prototype.html `.thread-item` 结构：
 * - 状态点（激活时使用强调色，否则为淡色）
 * - 标题（两行截断）+ 元信息（相对时间 · 消息数）
 * - 悬停操作：文件树切换、更多菜单（重命名 / 删除）
 * - 已归档：悬停时显示"恢复"按钮
 * - 内联重命名模式
 *
 * @see prototype.html 第 5134-5142 行（项模板）
 * @see prototype.html 第 5204-5213 行（归档项）
 */

import { memo, useEffect, useRef, useState } from 'react'
import { MoreHorizontal, FolderOpen, Pencil, Trash2 } from 'lucide-react'
import type { Thread } from '@/lib/codex/types'
import { cn } from '@/lib/utils'
import { formatRelativeShort } from '@/lib/codex/time'

interface ThreadItemProps {
  /** 当前会话数据 */
  thread: Thread
  /** 是否为当前激活会话（用于高亮态） */
  active: boolean
  /** 搜索匹配高亮 — 由 Sidebar 防抖搜索后传入，2 秒后自动移除 */
  highlighted?: boolean
  /**
   * 外部触发的重命名模式（受控）—— 为 true 时进入内联重命名。
   * 由 Sidebar 的右键菜单「重命名」触发，与 ThreadItem 内部「更多操作」按钮触发的
   * setRenaming(true) 互补。两种触发方式共用同一套 commitRename/cancelRename 逻辑。
   */
  renaming?: boolean
  /**
   * 重命名结束回调（无论提交还是取消）—— 用于清除 Sidebar 的 renamingThreadId。
   * 不传则不通知（内部「更多操作」按钮触发时无需通知外部）。
   */
  onRenameEnd?: () => void
  onSelect: (threadId: string) => void
  /** 重命名回调（提交非空且与原标题不同的名称时触发） */
  onRename: (threadId: string, name: string) => void
  /** 删除会话回调 */
  onDelete: (threadId: string) => void
  /** 归档会话回调 */
  onArchive: (threadId: string) => void
  /** 恢复归档会话回调（仅归档会话显示恢复按钮） */
  onRestore: (threadId: string) => void
  /** 切换到文件树视图回调 */
  onShowFiles: (threadId: string) => void
}

/**
 * ThreadItem 组件 —— 侧栏列表中的单个会话项。
 *
 * 渲染逻辑：
 *  - 状态点：激活时 accent 强调色 + 发光，否则为淡色
 *  - 标题：两行截断（line-clamp-2）
 *  - 元信息：相对时间 · 消息数（font-mono 等宽对齐）
 *  - 悬停操作（仅非归档会话）：
 *    - 「查看目录」按钮 → onShowFiles
 *    - 「更多操作」按钮 → 弹出菜单（重命名 / 归档 / 删除会话）
 *  - 归档会话：悬停显示「恢复」按钮
 *  - 内联重命名：input 替换标题，Enter 提交 / Escape 取消 / onBlur 提交
 *
 * 状态依赖：
 *  - 本地 useState 管理 renaming / renameValue / menuOpen
 *  - 通过 props 接收 thread 数据与 6 个回调
 *
 * 副作用：
 *  - renaming 变为 true 时自动 focus + select 输入框
 *  - menuOpen 时注册 document mousedown 监听，点击外部关闭菜单
 *
 * 设计决策：
 *  - 外层使用 role="group" 而非 "button"：容器内含可聚焦按钮，
 *    若外层为 button 会触发 axe 的 nested-interactive 违规
 *  - 保留 tabIndex={0} + 键盘事件，确保 Enter/Space 仍可选择会话
 *
 * @param props —— 见 ThreadItemProps 接口
 */
function ThreadItemComponent({
  thread,
  active,
  highlighted = false,
  renaming: externalRenaming = false,
  onRenameEnd,
  onSelect,
  onRename,
  onDelete,
  onArchive,
  onRestore,
  onShowFiles,
}: ThreadItemProps) {
  const [internalRenaming, setInternalRenaming] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // renaming 状态由内部触发（「更多操作」按钮）和外部触发（右键菜单）共同决定
  const renaming = externalRenaming || internalRenaming

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [renaming])

  useEffect(() => {
    if (!menuOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen])

  // 使用 uncontrolled input（defaultValue + key）避免 renameValue state：
  //  - key 随 thread.title 变化时 input 重新挂载，defaultValue 自动同步最新标题
  //  - 避免在 useEffect/render 中调用 setState 同步外部触发状态（违反 ESLint 规则）
  //  - commitRename 直接从 inputRef.current.value 读取
  function commitRename() {
    const input = inputRef.current
    const trimmed = (input?.value ?? '').trim()
    const finalName = trimmed || thread.title
    setInternalRenaming(false)
    // 通知外部清除 renamingThreadId（若由右键菜单触发）
    onRenameEnd?.()
    if (finalName !== thread.title) {
      onRename(thread.id, finalName)
    }
  }

  function cancelRename() {
    setInternalRenaming(false)
    // 通知外部清除 renamingThreadId（若由右键菜单触发）
    onRenameEnd?.()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelRename()
    }
  }

  function handleClick() {
    if (renaming) return
    onSelect(thread.id)
  }

  function handleKeyDownItem(e: React.KeyboardEvent<HTMLDivElement>) {
    if (renaming) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(thread.id)
    }
  }

  const metaText = `${formatRelativeShort(thread.updatedAt)} · ${thread.metadata.msgs} msgs`

  return (
    // 使用 role="group" 而非 "button"：此容器内含 "查看目录" 和 "更多操作"
    // 两个可聚焦按钮，若外层为 button 会触发 axe 的 nested-interactive 违规
    // （交互控件不得嵌套）。保留 tabIndex={0} + 键盘事件处理，
    // Enter/Space 仍可选择会话；aria-label 标识分组语义。
    <div
      role="group"
      tabIndex={0}
      aria-label={thread.title}
      data-id={thread.id}
      data-state={thread.archived ? 'archived' : 'recent'}
      data-folder={thread.metadata.folder ?? undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDownItem}
      className={cn(
        // P0 修复：
        //   - 加 cursor-pointer（App.css 全局 * { cursor:default } 覆盖了原型 cursor:pointer）
        //   - transition 时长 duration-200 改为 duration-[180ms]（对齐原型 0.18s）
        //   - 加 data-folder pl-[26px]（对齐原型 .thread-item[data-folder] { padding-left:26px }）
        //     原 Sidebar.tsx 外层 ml-4(16px) 已删除并改为 thread-item 自身偏移，
        //     这样 hover 背景可以延伸到行最左端，与原型一致
        //   - 移除 thread.archived && 'opacity-80'（原型仅 .ti-title 颜色变，整体不变淡）
        'group/thread relative flex cursor-pointer flex-wrap items-start gap-2 rounded-[7px] border border-transparent px-2.5 py-2 mb-0.5 transition-[background,transform,border-color] duration-[180ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]',
        thread.metadata.folder && 'pl-[26px]',
        'hover:bg-[var(--bg-elev-2)] hover:translate-x-0.5',
        active &&
          'bg-gradient-to-r from-[var(--bg-elev-2)] to-[var(--bg-elev)] shadow-[inset_2px_0_0_var(--accent),0_0_16px_rgba(0,229,199,0.06),0_0_0_1px_var(--accent-glow)]',
        // I-S-001: 搜索防抖后匹配项添加临时高亮环（2 秒后由 Sidebar 清除）
        highlighted && 'ring-1 ring-[var(--accent)]/40',
        // P0 修复：menu-open 时提升 z-index（对齐原型 .thread-item.menu-open { z-index:var(--z-context-menu) }）
        // 避免悬浮菜单被相邻 thread-item 遮挡
        menuOpen && 'z-[var(--z-context-menu)]'
      )}
    >
      <div className="flex w-full items-start gap-2">
        <span
          className={cn(
            'mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--text-faint)] transition-colors',
            active && 'bg-[var(--accent)] shadow-[0_0_6px_var(--accent)]'
          )}
        />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <input
              // key 随 thread.title 变化，确保外部触发重命名时 input 重新挂载、defaultValue 同步最新标题
              key={`rename-input-${thread.title}`}
              ref={inputRef}
              defaultValue={thread.title}
              onKeyDown={handleKeyDown}
              onBlur={commitRename}
              className="w-full rounded border border-[var(--accent)] bg-[var(--bg-elev-2)] px-1.5 py-0.5 font-[inherit] text-[var(--text)] outline-none shadow-[0_0_0_2px_var(--accent-glow)]"
            />
          ) : (
            <div
              className={cn(
                'line-clamp-2 text-[12.5px] leading-[1.35] text-[var(--text)]',
                thread.archived && 'text-[var(--text-dim)]'
              )}
            >
              {thread.title}
            </div>
          )}
          <div className="mt-[3px] font-mono text-[10px] text-[var(--text-faint)] tabular-nums">
            {metaText}
          </div>
        </div>

        {/* Hover actions — only for non-archived threads */}
        {!thread.archived && !renaming && (
          <div
            className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/thread:opacity-100 group-focus-visible/thread:opacity-100 data-[active=true]:opacity-100"
            data-active={active}
          >
            <button
              type="button"
              title="查看目录"
              aria-label="查看目录"
              onClick={e => {
                e.stopPropagation()
                onShowFiles(thread.id)
              }}
              className="flex h-[22px] w-[22px] items-center justify-center rounded text-[var(--text-faint)] transition-colors duration-[120ms] cursor-pointer hover:bg-[var(--bg-elev-3)] hover:text-[var(--text)]"
            >
              <FolderOpen width={13} height={13} />
            </button>
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                title="更多操作"
                aria-label="更多操作"
                onClick={e => {
                  e.stopPropagation()
                  setMenuOpen(v => !v)
                }}
                className="flex h-[22px] w-[22px] items-center justify-center rounded text-[var(--text-faint)] transition-colors duration-[120ms] cursor-pointer hover:bg-[var(--bg-elev-3)] hover:text-[var(--text)]"
              >
                <MoreHorizontal width={13} height={13} />
              </button>
              {menuOpen && (
                // 原型差异已确认：前端将归档操作统一到右键菜单，悬浮菜单保留高频操作
                // P0 修复：补 animate-[fadein_0.12s_ease]（对齐原型 .ti-menu.show { animation:fadein 0.12s ease }）
                <div className="absolute right-0 top-full z-[var(--z-toast)] min-w-[160px] rounded-[7px] border border-[var(--border-strong)] bg-[var(--bg-elev)] p-1 shadow-[var(--shadow-modal)] animate-[fadein_0.12s_ease]">
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation()
                      setMenuOpen(false)
                      setInternalRenaming(true)
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] text-[var(--text)] hover:bg-[var(--bg-elev-2)]"
                  >
                    <Pencil width={13} height={13} /> 重命名
                  </button>
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation()
                      setMenuOpen(false)
                      onArchive(thread.id)
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] text-[var(--text)] hover:bg-[var(--bg-elev-2)]"
                  >
                    归档
                  </button>
                  {/* T-B-003: 对齐原型 .ti-menu-sep margin: 4px 2px（上下 my-1 + 左右 mx-0.5） */}
                  <div className="my-1 mx-0.5 h-px bg-[var(--border)]" />
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation()
                      setMenuOpen(false)
                      onDelete(thread.id)
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] text-[var(--error)] hover:bg-[rgba(255,107,107,0.1)]"
                  >
                    <Trash2 width={13} height={13} /> 删除会话
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 恢复按钮 — 仅对归档会话显示 */}
        {thread.archived && (
          <button
            type="button"
            title="恢复"
            aria-label="恢复会话"
            onClick={e => {
              e.stopPropagation()
              onRestore(thread.id)
            }}
            className="shrink-0 rounded border border-[rgba(0,229,199,0.3)] bg-transparent px-1.5 py-0.5 font-mono text-[10px] text-[var(--accent)] opacity-0 transition-opacity duration-[120ms] cursor-pointer hover:bg-[rgba(0,229,199,0.1)] group-hover/thread:opacity-100"
          >
            恢复
          </button>
        )}
      </div>
    </div>
  )
}

// 使用 memo 包裹：列表项仅在自身 props 变化时重渲染，
// 避免 Sidebar 父组件 state（dropdownOpen / ctxMenu / renamingThreadId 等）
// 变更时全量重渲染所有 ThreadItem
export const ThreadItem = memo(ThreadItemComponent)
