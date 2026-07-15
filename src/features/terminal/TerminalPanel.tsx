/**
 * Terminal feature — 主面板组件
 *
 * 组合 TerminalTabs + TerminalView。
 * 渲染所有 session 的 TerminalView，用 display:none 隐藏非 active 终端，
 * 保持 xterm 实例存活。
 */

import { useTerminalStore } from './terminal-store'
import { TerminalTabs } from './TerminalTabs'
import { TerminalView } from './TerminalView'
import { cn } from '@/lib/utils'

/**
 * TerminalPanel 组件 —— 终端面板主组件。
 *
 * 渲染逻辑：
 *  - 顶部：TerminalTabs（标签栏 + 新建按钮）
 *  - 主体：所有 session 的 TerminalView 同时挂载，用 hidden 类切换可见性
 *
 * 状态依赖：
 *  - 从 useTerminalStore 读取 sessions / activeId
 *  - 从 store 获取 createSession / closeSession / setActive 方法
 *
 * 设计决策：
 *  - 所有 TerminalView 同时挂载（非销毁），仅用 CSS `hidden` 切换可见性
 *  - 这样可以保持 xterm 实例存活，切换 Tab 时无需重建终端、保留历史输出
 *  - 浏览器内存占用与 Tab 数量成正比，但桌面应用场景下 Tab 数量通常较少
 *
 * @example
 * // 通常作为底部面板嵌入主布局
 * <TerminalPanel />
 */
export function TerminalPanel() {
  const sessions = useTerminalStore(s => s.sessions)
  const activeId = useTerminalStore(s => s.activeId)
  const createSession = useTerminalStore(s => s.createSession)
  const closeSession = useTerminalStore(s => s.closeSession)
  const setActive = useTerminalStore(s => s.setActive)

  return (
    <div className="flex h-full flex-col">
      <TerminalTabs
        sessions={sessions}
        activeId={activeId}
        onSelect={setActive}
        onClose={closeSession}
        onAdd={() => {
          createSession()
        }}
      />
      {sessions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center font-mono text-xs text-[var(--text-faint)]">
          暂无终端会话
        </div>
      ) : (
        <div className="min-h-0 min-w-0 flex-1">
          {sessions.map(session => (
            <div
              key={session.id}
              className={cn(
                'h-full',
                session.id === activeId ? 'block' : 'hidden'
              )}
            >
              <TerminalView session={session} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
