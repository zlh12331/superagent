/**
 * ContextPanel — 右侧上下文面板（5 个 tab）
 *
 * 对应 prototype.html `<aside class="chat-right-panel">` 内的 `.crp-tabs` +
 * `.crp-pane` 结构。
 *
 * Tab 列表：信息(info) / Diff(diff) / 文件(files) / 终端(terminal) / 浏览器(browser)
 *
 * 参考样式: prototype.html `.crp-tabs`/`.crp-tab`/`.crp-pane`
 */

import { lazy, Suspense, useEffect, useState } from 'react'
import { useThreadStore } from '@/store/thread-store'
import { cn } from '@/lib/utils'
import { InfoPane } from './InfoPane'
import { DiffPane } from './DiffPane'
import { FilesPane } from './FilesPane'
import { BrowserPane } from './BrowserPane'

// 终端面板懒加载 — xterm vendor chunk（~200KB）仅在用户切换到终端 tab 时加载
const TerminalPanel = lazy(() =>
  import('@/features/terminal').then(m => ({ default: m.TerminalPanel }))
)

/**
 * 自定义事件名 —— FileTree 点击文件时派发，用于跨组件协调 ContextPanel 切 tab。
 *
 * 由于 file-tree-store 与 context-panel 分属不同 feature，
 * 为避免在 file-tree-store 中塞入 context-panel 的 UI 状态（高耦合），
 * 采用 window CustomEvent 解耦：FileTree 派发，ContextPanel 监听。
 */
export const CONTEXT_PANEL_SWITCH_TAB_EVENT = 'context-panel-switch-tab'

/**
 * 右侧面板可用的 tab 类型。
 * - `info`：会话详情（目标 / 计划 / 引用文件）
 * - `diff`：本轮文件变更 diff
 * - `files`：文件预览
 * - `terminal`：内嵌终端
 * - `browser`：浏览器预览
 */
export type CrpTab = 'info' | 'diff' | 'files' | 'terminal' | 'browser'

/**
 * 切换 tab 事件的 detail 载荷。
 * - `tab` 省略时默认切换到 `info`（保持向后兼容）
 * - FileTree 点击文件时派发无 detail 事件（切到 info）
 * - FileTree 右键「打开」时派发 `{ tab: 'files' }`（切到文件预览）
 */
export interface ContextPanelSwitchTabDetail {
  /** 要切换到的 tab，未指定时默认 'info' */
  tab?: CrpTab
}

/** Tab 定义项：id 与显示文案的映射。 */
interface CrpTabDef {
  id: CrpTab
  label: string
}

/**
 * 5 个 tab 配置，顺序对齐原型展示顺序。
 */
const TABS: CrpTabDef[] = [
  { id: 'info', label: '会话详情' },
  { id: 'diff', label: 'Diff' },
  { id: 'files', label: '文件' },
  { id: 'terminal', label: '终端' },
  { id: 'browser', label: '浏览器' },
]

/**
 * ContextPanel 组件 —— 右侧上下文面板。
 *
 * 职责：管理 5 个 tab 的切换，并按需渲染对应面板（InfoPane / DiffPane /
 *   FilesPane / TerminalPanel / BrowserPane）。
 *
 * 状态依赖：
 *  - 内部 useState：当前激活 tab（默认 `info`，与原型一致）
 *  - useThreadStore：订阅 activeThreadId，切换线程时子面板内容跟随切换
 *  - window 事件：监听 FileTree 派发的切换 tab 事件
 *
 * 设计要点：
 *  - 通过 tab 数组驱动渲染，避免 if/else 链；
 *  - 每个面板使用 `role="tabpanel"` + `aria-labelledby` 满足无障碍；
 *  - TerminalPanel 与其他 pane 通过惰性渲染切换，未挂载时自动卸载释放资源；
 *  - activeThreadId 透传给 InfoPane / DiffPane / FilesPane，使其能按线程派生数据。
 *
 * @see src/features/context-panel/InfoPane.tsx
 * @see src/features/context-panel/DiffPane.tsx
 * @see src/features/context-panel/FilesPane.tsx
 * @see src/features/context-panel/BrowserPane.tsx
 * @see src/features/terminal/TerminalPanel.tsx
 */
/** localStorage 持久化 ContextPanel tab 的 key（对齐原型 codex-rp-tab） */
const CRP_TAB_STORAGE_KEY = 'codex-rp-tab'

/**
 * 从 localStorage 加载上次选中的 tab（对齐原型 lsGet('codex-rp-tab')）。
 * 解析失败或值非法时回退到 'info'（默认 tab）。
 */
function loadSavedTab(): CrpTab {
  try {
    const saved = localStorage.getItem(CRP_TAB_STORAGE_KEY)
    if (saved === 'info' || saved === 'diff' || saved === 'files' ||
        saved === 'terminal' || saved === 'browser') {
      return saved
    }
  } catch {
    // localStorage 不可用（隐私模式等）—— 静默降级
  }
  return 'info'
}

export function ContextPanel() {
  // 默认激活上次选中的 tab（对齐原型 lsGet('codex-rp-tab')，无记录时回退 'info'）
  const [activeTab, setActiveTabState] = useState<CrpTab>(loadSavedTab)

  // 切换 tab 时同时持久化到 localStorage（对齐原型 lsSet('codex-rp-tab', pane)）
  const setActiveTab = (tab: CrpTab) => {
    setActiveTabState(tab)
    try {
      localStorage.setItem(CRP_TAB_STORAGE_KEY, tab)
    } catch {
      // localStorage 写入失败 —— 静默降级，不阻塞 UI
    }
  }

  // 订阅活跃线程 ID —— 切换线程时子面板内容跟随切换
  const activeThreadId = useThreadStore(s => s.activeThreadId)

  // 监听 FileTree 派发的 "切换 tab" 事件。
  // - 点击文件时无 detail，默认切到 info tab（显示会话详情）
  // - 右键「打开」时携带 { tab: 'files' }，切到文件预览 tab
  useEffect(() => {
    const handleSwitchTab = (e: Event) => {
      const detail = (e as CustomEvent<ContextPanelSwitchTabDetail>).detail
      setActiveTab(detail?.tab ?? 'info')
    }
    window.addEventListener(
      CONTEXT_PANEL_SWITCH_TAB_EVENT,
      handleSwitchTab
    )
    return () =>
      window.removeEventListener(
        CONTEXT_PANEL_SWITCH_TAB_EVENT,
        handleSwitchTab
      )
  }, [])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* tab 栏 — 对应原型 .crp-tabs */}
      <div
        className="flex flex-shrink-0 border-b border-[var(--border)]"
        role="tablist"
        aria-label="上下文面板"
      >
        {TABS.map(tab => {
          const active = tab.id === activeTab
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`crp-pane-${tab.id}`}
              id={`crp-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                // P0 修复（对齐原型 .crp-tab）：
                //   - 补 cursor-pointer（原型 cursor:pointer）
                //   - transition duration-150 → duration-[120ms]（原型 transition:color 0.12s ease, border-color 0.12s ease）
                //   - transition-colors → transition-[color,border-color]（精确属性）
                'flex-1 cursor-pointer border-b-2 border-transparent bg-transparent px-2.5 py-2 font-mono text-[11px] text-[var(--text-faint)] transition-[color,border-color] duration-[120ms]',
                'hover:text-[var(--text)]',
                active && 'border-b-[var(--accent)] text-[var(--accent)]'
              )}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* 面板内容 — 对应原型 .crp-pane */}
      {/* P0 修复：补 flex flex-col（对齐原型 .crp-pane.active.flex-pane { display:flex; flex-direction:column }） */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* info tab：会话详情（目标 / 计划 / 引用文件） */}
        {activeTab === 'info' && (
          <div
            id="crp-pane-info"
            role="tabpanel"
            aria-labelledby="crp-tab-info"
            className="h-full"
          >
            <InfoPane activeThreadId={activeThreadId} />
          </div>
        )}

        {/* diff tab：本轮文件变更 */}
        {activeTab === 'diff' && (
          <div
            id="crp-pane-diff"
            role="tabpanel"
            aria-labelledby="crp-tab-diff"
            className="h-full"
          >
            <DiffPane activeThreadId={activeThreadId} />
          </div>
        )}

        {/* files tab：文件预览 */}
        {activeTab === 'files' && (
          <div
            id="crp-pane-files"
            role="tabpanel"
            aria-labelledby="crp-tab-files"
            className="h-full"
          >
            <FilesPane activeThreadId={activeThreadId} />
          </div>
        )}

        {/* terminal tab：接入 TerminalPanel（懒加载，首次切换时加载 xterm chunk） */}
        {activeTab === 'terminal' && (
          <div
            id="crp-pane-terminal"
            role="tabpanel"
            aria-labelledby="crp-tab-terminal"
            className="h-full"
          >
            <Suspense fallback={null}>
              <TerminalPanel />
            </Suspense>
          </div>
        )}

        {/* browser tab：浏览器预览 */}
        {activeTab === 'browser' && (
          <div
            id="crp-pane-browser"
            role="tabpanel"
            aria-labelledby="crp-tab-browser"
            className="h-full"
          >
            <BrowserPane />
          </div>
        )}
      </div>
    </div>
  )
}
