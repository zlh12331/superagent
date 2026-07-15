import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable'
import { motion } from 'motion/react'
import { TitleBar } from '@/components/titlebar/TitleBar'
import { Sidebar } from '@/features/sidebar'
import { ContextPanel } from '@/features/context-panel'
import { ConversationArea } from '@/features/conversation'
// 远程控制视图 — 对齐原型 §2.17 Remote 视图（data-view="remote"）
// 低频视图改懒加载，减小首屏 bundle 体积（RemoteView 与 ConversationArea 互斥渲染）
const RemoteView = lazy(() =>
  import('@/features/remote').then(m => ({ default: m.RemoteView }))
)
// 低频弹窗改懒加载，减小首屏 bundle 体积
// useAccountListener 是 hook，必须静态导入
import { useAccountListener } from '@/features/account'
const CommandPalette = lazy(() =>
  import('@/components/command-palette/CommandPalette').then(m => ({ default: m.CommandPalette }))
)
const PreferencesDialog = lazy(() =>
  import('@/components/preferences/PreferencesDialog').then(m => ({ default: m.PreferencesDialog }))
)
const ShortcutHelpDialog = lazy(() =>
  import('@/components/shortcut-help/ShortcutHelpDialog').then(m => ({ default: m.ShortcutHelpDialog }))
)
const CrashReportDialog = lazy(() =>
  import('@/components/crash-report/CrashReportDialog').then(m => ({ default: m.CrashReportDialog }))
)
const LoginDialog = lazy(() =>
  import('@/features/account').then(m => ({ default: m.LoginDialog }))
)
const AccountDialog = lazy(() =>
  import('@/features/account').then(m => ({ default: m.AccountDialog }))
)
const AboutDialog = lazy(() =>
  import('@/features/account').then(m => ({ default: m.AboutDialog }))
)
const UpdateDialog = lazy(() =>
  import('@/features/account').then(m => ({ default: m.UpdateDialog }))
)
// 模糊搜索 / 反馈 / Demo 面板 — 对齐原型 ⌘F / openFeedback / Demo 下拉
const FuzzySearchDialog = lazy(() =>
  import('@/features/file-tree/FuzzySearchDialog').then(m => ({ default: m.FuzzySearchDialog }))
)
const FeedbackDialog = lazy(() =>
  import('@/features/feedback').then(m => ({ default: m.FeedbackDialog }))
)
// 命令式确认/输入对话框宿主 — 对齐原型 showConfirmDialog / showPromptDialog
import { DialogHost } from '@/features/dialog'
import { Toaster, toast } from 'sonner'
import { useTheme } from '@/hooks/use-theme'
import { useApprovalListener } from '@/hooks/useApprovalListener'
// 监听后端 API 弃用通知 — 对齐原型 §3.4 DeprecationNotice Toast
import { useDeprecationNotice } from '@/hooks/useDeprecationNotice'
import { useSidebarStore, type SidebarState } from '@/store/sidebar-store'
import { useDialogStore, type DialogState } from '@/store/dialog-store'
// 视图切换 store — 对齐原型 switchView（chat/config/remote 三视图）
import { useViewStore } from '@/store/view-store'
import { useMainWindowEventListeners } from '@/hooks/useMainWindowEventListeners'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import {
  slideRightVariants,
  slideLeftVariants,
  springTransition,
} from '@/lib/animations'

/**
 * 可伸缩面板的布局尺寸配置。
 * 所有数值均为窗口总宽度的百分比。
 * 左右栏默认宽度 + 主区域默认宽度之和必须等于 100。
 */
const LAYOUT = {
  // 左侧栏默认 17%（对齐原型 clamp(200px,17vw,280px)）
  // min 12% / max 20%：在 1440px 视口下约 172~288px，更接近原型 200~280px 约束
  leftSidebar: { default: 17, min: 12, max: 20 },
  // 右侧栏默认 22%（对齐原型 clamp(260px,22vw,360px)）
  // min 18% / max 25%：在 1440px 视口下约 259~360px，接近原型 260~360px 约束
  rightSidebar: { default: 22, min: 18, max: 25 },
  main: { min: 30 },
} as const

// 主区域默认宽度由计算得出，保证三栏默认宽度之和为 100%
const MAIN_CONTENT_DEFAULT =
  100 - LAYOUT.leftSidebar.default - LAYOUT.rightSidebar.default

/**
 * 响应式断点状态。
 * 对齐 prototype.html 行 4967-5039 的 4 档断点策略。
 */
interface LayoutBreakpoint {
  /** <1200px：右栏自动隐藏，可通过浮层抽屉唤出 */
  isCompact: boolean
  /** <900px：侧栏自动隐藏，可通过浮层抽屉唤出 */
  isNarrow: boolean
  /** <600px：简化顶栏与对话区间距 */
  isMobile: boolean
  /** <480px：极简模式 */
  isMinimal: boolean
}

/**
 * 布局断点 hook — 监听 4 档响应式断点。
 *
 * 实现要点：
 *   - 使用 window.matchMedia 监听（性能优于 resize 事件，浏览器节流）
 *   - 惰性初始化（useState lazy initializer）同步读取当前断点，避免首屏闪烁
 *   - 组件卸载时自动清理 matchMedia 监听器
 *   - SSR 安全防御（typeof window 检查，Tauri 应用无 SSR 但保持健壮性）
 */
function useLayoutBreakpoint(): LayoutBreakpoint {
  const [breakpoint, setBreakpoint] = useState<LayoutBreakpoint>(() => {
    // 惰性初始化：首次渲染即同步读取断点，避免宽窄屏闪烁
    if (typeof window === 'undefined' || !window.matchMedia) {
      return { isCompact: false, isNarrow: false, isMobile: false, isMinimal: false }
    }
    return {
      isCompact: window.matchMedia('(max-width: 1200px)').matches,
      isNarrow: window.matchMedia('(max-width: 900px)').matches,
      isMobile: window.matchMedia('(max-width: 600px)').matches,
      isMinimal: window.matchMedia('(max-width: 480px)').matches,
    }
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return

    // 4 档断点的 MediaQueryList 与对应状态键
    const mqls = [
      { mq: window.matchMedia('(max-width: 1200px)'), key: 'isCompact' as const },
      { mq: window.matchMedia('(max-width: 900px)'), key: 'isNarrow' as const },
      { mq: window.matchMedia('(max-width: 600px)'), key: 'isMobile' as const },
      { mq: window.matchMedia('(max-width: 480px)'), key: 'isMinimal' as const },
    ]

    // 监听每档断点变化，仅更新对应键（避免全量 re-render）
    const handlers = mqls.map(({ mq, key }) => {
      const handler = (e: MediaQueryListEvent) => {
        setBreakpoint(prev => ({ ...prev, [key]: e.matches }))
      }
      mq.addEventListener('change', handler)
      return { mq, handler }
    })

    // 卸载时清理所有监听器，防止内存泄漏
    return () => {
      handlers.forEach(({ mq, handler }) => mq.removeEventListener('change', handler))
    }
  }, [])

  return breakpoint
}

/**
 * 面板级错误降级 UI。
 *
 * 用途:三大面板(Sidebar / ConversationArea / ContextPanel)各自的局部
 * ErrorBoundary 在面板内抛错时,渲染该组件作为占位 UI,避免整个应用
 * 被顶层 ErrorBoundary 兜底成全屏崩溃页。
 *
 * 设计要点:
 * - 仅显示错误标题、说明与"重试"按钮,布局紧凑以适配面板宽度
 * - 通过 onReset 调用 ErrorBoundary 暴露的重置方法,触发子树重新渲染
 * - 开发模式下额外展示错误详情,方便定位问题
 */
function PanelFallback({
  error,
  onReset,
}: {
  error: Error
  onReset: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-background p-4">
      <div className="w-full max-w-xs text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
          <svg
            className="h-5 w-5 text-destructive"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.082 16.5c-.77.833.192 2.5 1.732 2.5z"
            />
          </svg>
        </div>
        <h2 className="mb-1 text-base font-semibold text-foreground">
          {t('errorBoundary.panel.title')}
        </h2>
        <p className="mb-4 text-xs text-muted-foreground">
          {t('errorBoundary.panel.description')}
        </p>
        <button
          type="button"
          onClick={onReset}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('errorBoundary.panel.retry')}
        </button>
        {import.meta.env.DEV && (
          <details className="mt-3 text-left">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              {t('errorBoundary.errorDetails')}
            </summary>
            <pre className="mt-1 overflow-auto rounded bg-muted p-2 text-[10px] font-mono text-muted-foreground whitespace-pre-wrap">
              {error.name}: {error.message}
            </pre>
          </details>
        )}
      </div>
    </div>
  )
}

export function MainWindow() {
  const { theme } = useTheme()
  // i18n — 复用 titlebar.hideRightSidebar / showRightSidebar 文案给桌面端折叠/展开按钮
  const { t } = useTranslation()
  const leftSidebarVisible = useSidebarStore(
    (state: SidebarState) => state.leftSidebarVisible
  )
  const rightSidebarVisible = useSidebarStore(
    (state: SidebarState) => state.rightSidebarVisible
  )
  // 右面板折叠/展开按钮调用 — 切换 rightSidebarVisible（与 ⌘2 / ⌘J 快捷键同源）
  const toggleRightSidebar = useSidebarStore(s => s.toggleRightSidebar)
  // 面板显隐 setter — 用于断点切换时自动隐藏 / 恢复
  const setLeftSidebarVisible = useSidebarStore(s => s.setLeftSidebarVisible)
  const setRightSidebarVisible = useSidebarStore(s => s.setRightSidebarVisible)

  // 响应式断点状态
  // 注意：此处的 isMobile 基于 600px 断点，与 src/hooks/use-mobile.ts（shadcn 内置，
  // 768px 断点）是两套独立的移动端检测系统，用途不同、互不冲突：
  //   - use-mobile.ts 的 useIsMobile：供 shadcn 组件（如 sidebar.tsx 的 Sheet 适配）使用
  //   - useLayoutBreakpoint：供本组件的 4 档布局适配（1200/900/600/480px）使用
  // 两者不合并，各司其职。
  const { isCompact, isNarrow, isMobile, isMinimal } = useLayoutBreakpoint()

  // 浮层抽屉开关状态 — 窄屏下通过顶栏按钮唤出
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false)
  const [rightPanelDrawerOpen, setRightPanelDrawerOpen] = useState(false)

  // 快捷键帮助弹窗状态 — 由 ? / F1 快捷键触发
  const shortcutHelpOpen = useDialogStore(
    (state: DialogState) => state.shortcutHelpOpen
  )
  const setShortcutHelpOpen = useDialogStore(
    (state: DialogState) => state.setShortcutHelpOpen
  )
  // 侧栏账户菜单回调所需的 dialog actions
  // 账户信息 → AccountDialog；设置 → PreferencesDialog；退出登录 → LoginDialog
  // 关于 → AboutDialog（独立弹窗，非设置抽屉分区）
  const setAccountOpen = useDialogStore(s => s.setAccountOpen)
  const setPreferencesOpen = useDialogStore(s => s.setPreferencesOpen)
  const setLoginOpen = useDialogStore(s => s.setLoginOpen)
  const setAboutOpen = useDialogStore(s => s.setAboutOpen)

  // ----- 弹窗状态订阅（用于 inert 属性判定）-----
  // 订阅所有弹窗的 open 状态，任意一个打开时主内容区需设为 inert
  const commandPaletteOpen = useDialogStore(s => s.commandPaletteOpen)
  const preferencesOpen = useDialogStore(s => s.preferencesOpen)
  const loginOpen = useDialogStore(s => s.loginOpen)
  const accountOpen = useDialogStore(s => s.accountOpen)
  const aboutOpen = useDialogStore(s => s.aboutOpen)
  // 模糊搜索 / 反馈弹窗状态订阅（对齐原型 ⌘F / openFeedback）
  const fuzzySearchOpen = useDialogStore(s => s.fuzzySearchOpen)
  const feedbackOpen = useDialogStore(s => s.feedbackOpen)
  const setFuzzySearchOpen = useDialogStore(s => s.setFuzzySearchOpen)
  const setFeedbackOpen = useDialogStore(s => s.setFeedbackOpen)

  // 当前激活的视图（chat/config/remote）— 对齐原型 switchView
  // 决定主内容区渲染 ConversationArea 还是 RemoteView
  const activeView = useViewStore(s => s.activeView)

  // 主内容区 ref — 弹窗打开时设置 inert 属性，禁止背景交互
  const mainContentRef = useRef<HTMLDivElement>(null)

  // 任意弹窗或抽屉打开时，主内容区需设为 inert（不可交互）
  // 注意：侧边栏与标题栏不加 inert，保持可交互（它们不属于弹窗背景）
  const anyDialogOpen =
    commandPaletteOpen ||
    preferencesOpen ||
    loginOpen ||
    accountOpen ||
    aboutOpen ||
    shortcutHelpOpen ||
    fuzzySearchOpen ||
    feedbackOpen ||
    sidebarDrawerOpen ||
    rightPanelDrawerOpen

  // 弹窗打开时给主内容区设置 inert 属性，阻止背景交互（含 Tab 焦点陷入）
  // 使用 ref + DOM 操作而非 JSX 属性，兼容 React 18/19 的 inert 类型差异
  useEffect(() => {
    const el = mainContentRef.current
    if (!el) return
    if (anyDialogOpen) {
      el.setAttribute('inert', '')
    } else {
      el.removeAttribute('inert')
    }
  }, [anyDialogOpen])

  // 注册全局事件监听器（键盘快捷键等）
  useMainWindowEventListeners()
  // 监听 codex-rs 审批请求事件，触发审批弹窗
  useApprovalListener()
  // 监听账户登录完成与状态变化事件，更新 account store
  useAccountListener()
  // 监听后端 API 弃用通知，显示紫色主题 DeprecationNotice Toast
  useDeprecationNotice()

  // ----- 自动隐藏 / 恢复：断点切换时自动管理面板显隐与抽屉关闭 -----
  // 说明：抽屉关闭逻辑合并到此 effect 中，避免单独 effect 中同步调用
  //       setState 触发 react-hooks/set-state-in-effect 警告（级联渲染风险）。
  //       此处通过 prevBreakpoint.current（ref）参与条件判断，使 setState
  //       调用被判定为有条件执行，而非纯依赖驱动的无条件调用。
  // 记录断点进入前面板的可见状态，退出时恢复（避免覆盖用户手动隐藏的意图）
  const leftVisibleBeforeNarrow = useRef(leftSidebarVisible)
  const rightVisibleBeforeCompact = useRef(rightSidebarVisible)
  // 上一轮断点状态（用于检测进入 / 退出）
  const prevBreakpoint = useRef({ isCompact, isNarrow })

  useEffect(() => {
    const store = useSidebarStore.getState()
    const prev = prevBreakpoint.current

    // 右栏：进入 compact 自动隐藏，退出恢复
    if (isCompact && !prev.isCompact) {
      // 进入紧凑屏：若右栏可见则记录并隐藏
      rightVisibleBeforeCompact.current = store.rightSidebarVisible
      store.setRightSidebarVisible(false)
    } else if (!isCompact && prev.isCompact) {
      // 退出紧凑屏：若进入前可见则恢复
      if (rightVisibleBeforeCompact.current) {
        store.setRightSidebarVisible(true)
      }
      // 同时关闭右面板抽屉（避免非紧凑屏下抽屉状态残留）
      setRightPanelDrawerOpen(false)
    }

    // 左栏：进入 narrow 自动隐藏，退出恢复
    if (isNarrow && !prev.isNarrow) {
      leftVisibleBeforeNarrow.current = store.leftSidebarVisible
      store.setLeftSidebarVisible(false)
    } else if (!isNarrow && prev.isNarrow) {
      if (leftVisibleBeforeNarrow.current) {
        store.setLeftSidebarVisible(true)
      }
      // 同时关闭侧栏抽屉（避免非窄屏下抽屉状态残留）
      setSidebarDrawerOpen(false)
    }

    prevBreakpoint.current = { isCompact, isNarrow }
  }, [isCompact, isNarrow])

  // ----- 抽屉拦截：窄屏下将面板 toggle 转为抽屉 toggle -----
  // 原理：窄屏下面板始终 hidden（由 isNarrow 条件控制），store 中的
  //       visible 标志被"借用"为抽屉开关信号。当用户点击顶栏 toggle
  //       按钮使 visible 变为 true 时，立即重置为 false 并切换抽屉。
  //
  // 前端增强：抽屉 toggle 行为（点击已打开的抽屉按钮关闭），
  // 原型为"先关所有再开目标"（点击任意抽屉按钮先关另一个再开当前）。
  // 前端的 toggle 语义更符合用户预期，保留此实现（I-G-008）。
  const prevLeftVisible = useRef(leftSidebarVisible)
  const prevRightVisible = useRef(rightSidebarVisible)

  useEffect(() => {
    // 非窄屏：仅同步 prev，不拦截
    if (!isNarrow) {
      prevLeftVisible.current = leftSidebarVisible
      return
    }
    // 检测 leftSidebarVisible 从 false → true（用户点击了 toggle）
    if (!prevLeftVisible.current && leftSidebarVisible) {
      setLeftSidebarVisible(false)
      setSidebarDrawerOpen(prev => !prev)
      // 互斥：打开侧栏抽屉时关闭右面板抽屉
      setRightPanelDrawerOpen(false)
    }
    prevLeftVisible.current = leftSidebarVisible
  }, [leftSidebarVisible, isNarrow, setLeftSidebarVisible])

  useEffect(() => {
    if (!isCompact) {
      prevRightVisible.current = rightSidebarVisible
      return
    }
    if (!prevRightVisible.current && rightSidebarVisible) {
      setRightSidebarVisible(false)
      setRightPanelDrawerOpen(prev => !prev)
      // 互斥：打开右面板抽屉时关闭侧栏抽屉
      setSidebarDrawerOpen(false)
    }
    prevRightVisible.current = rightSidebarVisible
  }, [rightSidebarVisible, isCompact, setRightSidebarVisible])

  // ----- 顶栏 .sidebar-drawer-toggle 按钮事件桥接 -----
  // 该按钮由另一子代理在 TitleBar 中添加（窄屏下显示）。
  // 事件约定：codex:toggle-sidebar-drawer / codex:toggle-right-panel-drawer
  // 按钮点击后通过 store toggle 触发上方拦截逻辑，实现抽屉开关。
  useEffect(() => {
    const handleSidebarToggle = () => {
      useSidebarStore.getState().toggleLeftSidebar()
    }
    const handleRightPanelToggle = () => {
      useSidebarStore.getState().toggleRightSidebar()
    }
    window.addEventListener('codex:toggle-sidebar-drawer', handleSidebarToggle)
    window.addEventListener(
      'codex:toggle-right-panel-drawer',
      handleRightPanelToggle
    )
    return () => {
      window.removeEventListener(
        'codex:toggle-sidebar-drawer',
        handleSidebarToggle
      )
      window.removeEventListener(
        'codex:toggle-right-panel-drawer',
        handleRightPanelToggle
      )
    }
  }, [])

  // ----- 全局 Esc 协调器（I-G-004 + I-G-007 合并，集中式优先级链）-----
  // 按优先级关闭第一个打开的弹窗/抽屉（每次只关一个，保证优先级链）：
  //   commandPalette → preferences → login → account → about → shortcutHelp
  //   → fuzzySearch → feedback → sidebarDrawer → rightPanelDrawer
  //
  // 设计说明：
  //   1. 使用捕获阶段（capture: true）监听，确保在 Radix Dialog 等库的
  //      冒泡阶段监听器之前处理 Esc，实现集中式优先级控制。
  //   2. 命中弹窗后调用 stopImmediatePropagation() 阻止其他 Esc 监听器触发
  //      （如 Radix Dialog 内置 Esc 处理、ConversationArea 搜索栏 Esc 处理），
  //      确保单次 Esc 只关闭优先级最高的弹窗，不会连带关闭其他弹窗。
  //   3. 抽屉（sidebarDrawer / rightPanelDrawer）非 Radix 弹窗，
  //      由本协调器主动关闭（I-G-007）。
  //   4. convSearch 由 ConversationArea 本地 Esc 处理器关闭，优先级最低。
  //      此处不重复处理，避免与 ConversationArea 本地状态耦合。
  //      当无弹窗打开时，不调用 stopImmediatePropagation，让事件继续传播到
  //      ConversationArea 的本地处理器。
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const d = useDialogStore.getState()
      // 按优先级依次检查并关闭第一个打开的弹窗
      if (d.commandPaletteOpen) {
        e.preventDefault()
        e.stopImmediatePropagation()
        d.setCommandPaletteOpen(false)
        return
      }
      if (d.preferencesOpen) {
        e.preventDefault()
        e.stopImmediatePropagation()
        d.setPreferencesOpen(false)
        return
      }
      if (d.loginOpen) {
        e.preventDefault()
        e.stopImmediatePropagation()
        d.setLoginOpen(false)
        return
      }
      if (d.accountOpen) {
        e.preventDefault()
        e.stopImmediatePropagation()
        d.setAccountOpen(false)
        return
      }
      if (d.aboutOpen) {
        e.preventDefault()
        e.stopImmediatePropagation()
        d.setAboutOpen(false)
        return
      }
      if (d.shortcutHelpOpen) {
        e.preventDefault()
        e.stopImmediatePropagation()
        d.setShortcutHelpOpen(false)
        return
      }
      // 模糊搜索 / 反馈弹窗（对齐原型 Esc 优先级链）
      if (d.fuzzySearchOpen) {
        e.preventDefault()
        e.stopImmediatePropagation()
        d.setFuzzySearchOpen(false)
        return
      }
      if (d.feedbackOpen) {
        e.preventDefault()
        e.stopImmediatePropagation()
        d.setFeedbackOpen(false)
        return
      }
      // 抽屉（I-G-007）：非 Radix 弹窗，需此协调器主动关闭
      if (sidebarDrawerOpen) {
        e.preventDefault()
        e.stopImmediatePropagation()
        setSidebarDrawerOpen(false)
        return
      }
      if (rightPanelDrawerOpen) {
        e.preventDefault()
        e.stopImmediatePropagation()
        setRightPanelDrawerOpen(false)
        return
      }
      // convSearch 由 ConversationArea 本地处理器关闭（优先级最低）
    }
    // 捕获阶段监听：在 Radix 等库的冒泡阶段监听器之前拦截 Esc
    document.addEventListener('keydown', handleEsc, true)
    return () => document.removeEventListener('keydown', handleEsc, true)
  }, [sidebarDrawerOpen, rightPanelDrawerOpen])

  // 面板级 ErrorBoundary 的降级渲染函数:
  // 注入错误对象与重置回调到 PanelFallback。
  // 使用 inline 布局让降级 UI 填满面板容器而非全屏。
  const renderPanelFallback = ({ error, reset }: {
    error: Error
    reset: () => void
  }) => <PanelFallback error={error} onReset={reset} />

  // 渲染侧栏内容（在 ResizablePanel 或浮层抽屉中复用，避免重复代码）
  const renderSidebarContent = () => (
    <motion.div
      variants={slideRightVariants}
      initial="initial"
      animate="animate"
      transition={springTransition}
      className="h-full"
    >
      {/* 局部 ErrorBoundary:Sidebar 崩溃时仅降级左侧栏,不影响其他面板 */}
      <ErrorBoundary inline fallback={renderPanelFallback}>
        <Sidebar
          // 账户信息 → 打开 AccountDialog
          onOpenAccount={() => setAccountOpen(true)}
          // 设置 → 打开 PreferencesDialog
          onOpenSettings={() => setPreferencesOpen(true)}
          // 反馈 → 打开 FeedbackDialog（对齐原型 openFeedback）
          onOpenFeedback={() => setFeedbackOpen(true)}
          // 关于 → 打开 AboutDialog（独立弹窗，#21 接线）
          onOpenAbout={() => setAboutOpen(true)}
          // 退出登录 → 打开 LoginDialog
          onLogout={() => setLoginOpen(true)}
        />
      </ErrorBoundary>
    </motion.div>
  )

  // 渲染右面板内容（在 ResizablePanel 或浮层抽屉中复用）
  const renderRightPanelContent = () => (
    <motion.div
      variants={slideLeftVariants}
      initial="initial"
      animate="animate"
      transition={springTransition}
      className="h-full min-w-0"
    >
      {/* overflow-hidden + min-w-0 裁剪 xterm 等内部内容的溢出。
          右侧 ResizablePanel 设置了 overflow:visible（为折叠按钮溢出 left:-20px），
          若此处不裁剪，xterm canvas 渲染超出容器宽度时会撑大父容器，
          触发 ResizeObserver → fitAddon.fit() → 重渲染 → 再撑大的无限循环，
          表现为右侧面板持续向左挪动。
          min-w-0 确保 flex 子项可收缩到 0（覆盖默认 min-width:auto），
          防止 xterm 内容的最小宽度约束父容器。折叠按钮在 ResizablePanel 层级，不受影响。 */}
      <div className="flex h-full min-w-0 flex-col overflow-hidden border-l bg-background">
        {/* 局部 ErrorBoundary:上下文面板崩溃时仅降级右侧栏,不影响其他面板 */}
        <ErrorBoundary inline fallback={renderPanelFallback}>
          <ContextPanel />
        </ErrorBoundary>
      </div>
    </motion.div>
  )

  return (
    <div
      className={cn(
        'flex h-screen w-full flex-col overflow-hidden rounded-[var(--app-corner-radius)]',
        // 响应式断点类名：供 App.css 媒体查询精确控制 600px/480px 组件级调整
        // （对齐 prototype.html 行 5019-5039 的 600px/480px 断点策略）
        isMobile && 'is-mobile',
        isMinimal && 'is-minimal'
      )}
    >
      <TitleBar />

      {/* relative 为桌面端右面板折叠/展开按钮提供定位上下文 */}
      <div className="relative flex flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel
            defaultSize={LAYOUT.leftSidebar.default}
            minSize={LAYOUT.leftSidebar.min}
            maxSize={LAYOUT.leftSidebar.max}
            // 窄屏下面板始终隐藏（由 isNarrow 控制），用户手动隐藏由 visible 控制
            className={cn((!leftSidebarVisible || isNarrow) && 'hidden')}
          >
            {/* 非窄屏时渲染侧栏内容；窄屏时侧栏改由浮层抽屉渲染 */}
            {!isNarrow && renderSidebarContent()}
          </ResizablePanel>

          <ResizableHandle
            className={cn(
              (!leftSidebarVisible || isNarrow) && 'hidden',
              // 正常态 hit area 加宽至 6px（after:w-1.5），对齐原型 var(--resizer-w): 6px。
              // 覆盖 resizable.tsx 基础样式 after:w-1（4px），twMerge 自动去重保留后者。
              // hover / active 态的 accent 高亮已由 resizable.tsx 基础样式提供。
              'after:w-1.5 data-[resize-handle-active]:after:w-1.5'
            )}
          />

          <ResizablePanel
            defaultSize={MAIN_CONTENT_DEFAULT}
            minSize={LAYOUT.main.min}
          >
            {/* 主区背景：对齐 prototype.html 行 607-609 的 radial-gradient 光晕 */}
            {/* ref={mainContentRef}：弹窗打开时通过 inert 属性禁止背景交互 */}
            <div
              ref={mainContentRef}
              className="flex h-full flex-col bg-background"
              style={{
                backgroundImage:
                  'radial-gradient(circle at 20% 0%, var(--accent-glow), transparent 40%), radial-gradient(circle at 80% 100%, var(--accent-soft), transparent 40%)',
              }}
            >
              {/* 局部 ErrorBoundary:对话区崩溃时仅降级中间面板,保留两侧栏可用 */}
              {/* resetKey=activeView: 切换视图时自动清除错误状态，避免前一视图错误残留 */}
              <ErrorBoundary inline fallback={renderPanelFallback} resetKey={activeView}>
                {/* 视图切换 — 对齐原型 switchView（chat/config/remote） */}
                {/* RemoteView 为懒加载，用 Suspense 包裹提供 fallback */}
                {activeView === 'remote' ? (
                  <Suspense fallback={null}>
                    <RemoteView />
                  </Suspense>
                ) : (
                  <ConversationArea />
                )}
              </ErrorBoundary>
            </div>
          </ResizablePanel>

          <ResizableHandle
            className={cn(
              (!rightSidebarVisible || isCompact) && 'hidden',
              // 正常态 hit area 加宽至 6px（after:w-1.5），对齐原型 var(--resizer-w): 6px。
              // hover / active 态的 accent 高亮已由 resizable.tsx 基础样式提供。
              'after:w-1.5 data-[resize-handle-active]:after:w-1.5'
            )}
          />

          <ResizablePanel
            defaultSize={LAYOUT.rightSidebar.default}
            minSize={LAYOUT.rightSidebar.min}
            maxSize={LAYOUT.rightSidebar.max}
            // overflow:visible 覆盖 react-resizable-panels 内联的 overflow:hidden，
            // 允许折叠按钮溢出到面板左边缘外部（left:-20px，对齐原型 .crp-collapse-btn）。
            // 库的 style 合并机制为 { ...libraryStyle, ...userStyle }，用户 style 覆盖库 style。
            style={{ overflow: 'visible' }}
            // relative 为折叠按钮提供定位上下文；hidden 仍由断点 / 显隐控制
            // min-w-0 覆盖 flex 默认 min-width:auto，防止 xterm canvas 渲染时
            // 内容固有宽度撑大面板（导致面板持续向左挪动的 bug）。折叠按钮是 absolute 定位，不受影响。
            className={cn(
              (!rightSidebarVisible || isCompact) && 'hidden',
              'relative min-w-0'
            )}
          >
            {/* 非紧凑屏时渲染右面板；紧凑屏时改由浮层抽屉渲染 */}
            {!isCompact && renderRightPanelContent()}
            {/* 桌面端右面板折叠按钮 — 位于面板左边缘外部（left:-20px），点击折叠右面板。
                仅在桌面端（!isCompact，即 >1200px）且右面板可见时显示。
                对齐原型 .crp-collapse-btn：
                  - 位置：absolute, left:-20px, top:50%（外左中）
                  - 尺寸：20×28（w-5 h-7）
                  - 配色：中性色（var(--bg-elev-2) + var(--border) + var(--text-faint)）
                  - 形状：左侧圆角 rounded-l-[6px]，右侧无边框 border-r-0
                  - 图标：ChevronRight（展开按钮通过 rotate-180 翻转图标方向）
                按钮 z-30 高于面板内容与 ResizableHandle（z-10），与 handle 不重叠。 */}
            {!isCompact && rightSidebarVisible && (
              <button
                type="button"
                onClick={toggleRightSidebar}
                aria-label={t('titlebar.hideRightSidebar')}
                title={t('titlebar.hideRightSidebar')}
                className="absolute left-[-20px] top-1/2 z-30 flex h-7 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-l-[6px] border border-r-0 border-[var(--border)] bg-[var(--bg-elev-2)] text-[var(--text-faint)] transition-colors hover:text-[var(--text)]"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>

        {/* 桌面端右面板展开按钮 — 右面板折叠后显示，点击恢复。
            仅在桌面端（!isCompact，即 >1200px）且右面板隐藏时显示。
            定位在外层 relative 容器的右边缘中间：右面板隐藏后主区扩展至右侧，
            按钮自然贴右边缘。
            与折叠按钮使用同一图标 ChevronRight，通过 rotate-180 翻转方向
            （对齐原型 .crp-collapse-btn { transform: rotate(180deg) } 旋转语义），
            形成"折叠后图标翻转"的视觉反馈。
            样式与折叠按钮一致：中性色 + 20×28 + 左侧圆角。 */}
        {!isCompact && !rightSidebarVisible && (
          <button
            type="button"
            onClick={toggleRightSidebar}
            aria-label={t('titlebar.showRightSidebar')}
            title={t('titlebar.showRightSidebar')}
            className="absolute right-0 top-1/2 z-30 flex h-7 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-l-[6px] border border-r-0 border-[var(--border)] bg-[var(--bg-elev-2)] text-[var(--text-faint)] transition-colors hover:text-[var(--text)]"
          >
            <ChevronRight className="h-3.5 w-3.5 rotate-180" />
          </button>
        )}
      </div>

      {/* ===== 浮层抽屉 — 窄屏下面板以浮层方式滑出 ===== */}

      {/* 侧栏浮层抽屉（窄屏 <900px 下显示） */}
      {isNarrow && sidebarDrawerOpen && (
        <>
          {/* 遮罩层 — 点击关闭抽屉 */}
          <div
            className="drawer-backdrop"
            onClick={() => setSidebarDrawerOpen(false)}
            aria-hidden="true"
          />
          <div
            className="sidebar-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="侧栏"
          >
            {renderSidebarContent()}
          </div>
        </>
      )}

      {/* 右面板浮层抽屉（紧凑屏 <1200px 下显示） */}
      {isCompact && rightPanelDrawerOpen && (
        <>
          {/* 遮罩层 — 点击关闭抽屉 */}
          <div
            className="drawer-backdrop"
            onClick={() => setRightPanelDrawerOpen(false)}
            aria-hidden="true"
          />
          <div
            className="right-panel-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="上下文面板"
          >
            {renderRightPanelContent()}
          </div>
        </>
      )}

      {/* Global UI Components (hidden until triggered) */}
      {/* 低频弹窗使用 React.lazy 懒加载 + Suspense 包裹，
          首屏不加载这些组件的代码，仅在用户触发时按需加载 */}
      <Suspense fallback={null}>
        <CommandPalette />
        <PreferencesDialog />
        <ShortcutHelpDialog
          open={shortcutHelpOpen}
          onClose={() => setShortcutHelpOpen(false)}
        />
        <CrashReportDialog />
        <LoginDialog />
        <AccountDialog />
        <AboutDialog />
        {/* 检查更新弹窗（设置抽屉/菜单触发，对齐原型 openUpdater） */}
        <UpdateDialog />
      </Suspense>
      {/* 命令式确认/输入对话框宿主 — 由 confirm()/prompt() 函数触发 */}
      <DialogHost />
      {/* 文件模糊搜索弹窗（⌘F 触发，对齐原型 fuzzy search overlay） */}
      <Suspense fallback={null}>
        <FuzzySearchDialog
          open={fuzzySearchOpen}
          onClose={() => setFuzzySearchOpen(false)}
          onSelect={path => {
            // 选中文件后关闭弹窗，并 toast 提示选中路径（后续可接入文件打开逻辑）
            setFuzzySearchOpen(false)
            toast.success('已选择文件', { description: path })
          }}
        />
      </Suspense>
      {/* 反馈弹窗（Sidebar 下拉菜单触发，对齐原型 openFeedback） */}
      <Suspense fallback={null}>
        <FeedbackDialog
          open={feedbackOpen}
          onOpenChange={setFeedbackOpen}
        />
      </Suspense>
      <Toaster
        position="bottom-right"
        theme={
          theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'system'
        }
        // richColors：启用 sonner 内置的成功/警告/错误/信息四色样式，
        //   与项目 toast.success/error/warning/info 调用一一对应，提升视觉辨识度
        // closeButton：为每个 toast 添加显式关闭按钮，避免长描述 toast 无法手动关闭
        // duration：5000ms（默认 4000ms 略短，错误提示需要更长阅读时间）
        richColors
        closeButton
        duration={5000}
        className="toaster group"
        toastOptions={{
          classNames: {
            toast:
              'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
            description: 'group-[.toast]:text-muted-foreground',
            actionButton:
              'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
            cancelButton:
              'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          },
        }}
      />
    </div>
  )
}
