import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { usePlatform, type AppPlatform } from '@/hooks/use-platform'
import { useSidebarStore, type SidebarState } from '@/store/sidebar-store'
import { MacOSWindowControls } from './MacOSWindowControls'
import { WindowsWindowControls } from './WindowsWindowControls'
import { LinuxTitleBar } from './LinuxTitleBar'
import {
  useDialogStore,
  type DialogState,
} from '@/store/dialog-store'
// I1: BackButton 接线 view-store，使用 canGoBack/goBack 实现视图后退导航
import { useViewStore } from '@/store/view-store'
import {
  ArrowLeft,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
} from 'lucide-react'
// DemoPanel — 开发演示下拉菜单（仅开发模式渲染），替代旧版 DevDemoButton 占位实现
import { DemoPanel } from '@/features/demo'

/** 版本遥测文本 — 对齐 prototype.html 中的 brand-telemetry */
const BRAND_TELEMETRY = 'v1.4.0 · main'

interface TitleBarProps {
  className?: string
  title?: string
  /**
   * 强制指定平台（用于开发 / 测试）。
   * 仅在开发构建中生效。
   */
  forcePlatform?: AppPlatform
}

/**
 * 品牌标识区 — 对齐 prototype.html 中的 .brand 结构（第 241-259 行）
 *
 * 由以下部分组成：
 *   1. brand-mark — 20×20 圆角方块，渐变背景 + 发光阴影 + 内部 L 形边框（div + 伪元素实现）
 *   2. brand-name — "codex" 文本，serif 斜体字体，14px
 *   3. brand-telemetry — 版本遥测文本，mono 字体，10px，左侧竖线分隔
 *   4. model-select — 当前模型名，mono 字体，可点击切换
 */
function BrandArea() {
  return (
    <div className="flex items-center gap-2.5">
      {/* 品牌图标 — 20×20 div，渐变背景 + 发光阴影，内部 L 形边框（对齐原型 .brand-mark） */}
      <div
        className="relative h-5 w-5 rounded-[5px]"
        style={{
          background:
            'linear-gradient(135deg, var(--accent), var(--accent-dim))',
          boxShadow:
            '0 0 16px var(--accent-glow), inset 0 1px 0 rgba(255,255,255,0.2)',
        }}
        aria-hidden="true"
      >
        {/* 内部 L 形边框 — 对齐原型 .brand-mark::after */}
        <span
          className="absolute"
          style={{
            inset: '5px',
            borderTop: '1.5px solid var(--bg)',
            borderLeft: '1.5px solid var(--bg)',
            borderRadius: '2px',
            borderRight: 'none',
            borderBottom: 'none',
          }}
        />
      </div>
      {/* 品牌名称 — codexdesktop，对齐原型 .brand-name */}
      {/* data-slot="brand-name"：供 App.css 中 .is-minimal [data-slot='brand-name'] { font-size:12px } 规则匹配 */}
      <div data-slot="brand-name" className="text-[14px] font-[var(--font-serif)] italic font-normal leading-none tracking-[0.01em]">
        codex
        <span className="ml-1 font-mono text-[11px] not-italic font-normal text-[var(--text-faint)]">
          desktop
        </span>
      </div>
      {/* 版本遥测 — 对齐 prototype.html .brand-telemetry，左侧竖线 + mono 字体 */}
      {/* data-slot="brand-telemetry"：供 App.css 中 .is-mobile [data-slot='brand-telemetry'] { display: none; } 规则匹配，在窄屏下隐藏版本遥测文本 */}
      <span data-slot="brand-telemetry" className="border-l border-[var(--border)] pl-3 ml-1 font-mono text-[10px] tracking-[0.05em] text-[var(--text-faint)] leading-none">
        {BRAND_TELEMETRY}
      </span>
      {/* 注：模型选择器仅存在于 composer-project-bar（见 ChatInput.tsx），
          原型顶栏 .brand 区域不含模型入口，故此处不再渲染模型按钮。 */}
    </div>
  )
}

/**
 * 窄屏侧栏抽屉触发按钮 — 对齐 prototype.html 中的 .sidebar-toggle-btn
 *
 * 默认 hidden（宽屏下不显示），在窄屏（max-width:900px）下由 App.css
 * 媒体查询将其 display 切换为 flex。响应式断点切换由 MainWindow.tsx 负责，
 * 此按钮仅负责调用 toggleLeftSidebar 触发抽屉显隐。
 */
function SidebarDrawerToggle() {
  const { t } = useTranslation()
  const toggleLeftSidebar = useSidebarStore(
    (state: SidebarState) => state.toggleLeftSidebar
  )
  const label = t('titlebar.showLeftSidebar')
  return (
    <button
      type="button"
      onClick={toggleLeftSidebar}
      // sidebar-drawer-toggle：App.css 媒体查询控制显隐的钩子类
      className="sidebar-drawer-toggle hidden cursor-pointer rounded-md p-1.5 text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-elev-2)]"
      title={label}
      aria-label={label}
    >
      <Menu className="h-4 w-4" />
    </button>
  )
}

/**
 * 左侧栏开关按钮
 *
 * 从 sidebar-store 读取 leftSidebarVisible 状态，
 * 点击切换侧栏可见性。
 * 可见时显示 PanelLeftClose，隐藏时显示 PanelLeftOpen。
 */
function LeftSidebarToggle() {
  const { t } = useTranslation()
  const leftSidebarVisible = useSidebarStore(
    (state: SidebarState) => state.leftSidebarVisible
  )
  const toggleLeftSidebar = useSidebarStore(
    (state: SidebarState) => state.toggleLeftSidebar
  )

  const label = t(
    leftSidebarVisible
      ? 'titlebar.hideLeftSidebar'
      : 'titlebar.showLeftSidebar'
  )

  return (
    <button
      type="button"
      onClick={toggleLeftSidebar}
      className="hidden min-[901px]:flex cursor-pointer rounded-md p-1.5 text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-elev-2)]"
      title={label}
      aria-label={label}
    >
      {leftSidebarVisible ? (
        <PanelLeftClose className="h-4 w-4" />
      ) : (
        <PanelLeftOpen className="h-4 w-4" />
      )}
    </button>
  )
}

/**
 * 右侧栏开关按钮
 *
 * 从 sidebar-store 读取 rightSidebarVisible 状态，
 * 点击切换右栏可见性。
 * 可见时显示 PanelRightClose，隐藏时显示 PanelRightOpen。
 */
function RightSidebarToggle() {
  const { t } = useTranslation()
  const rightSidebarVisible = useSidebarStore(
    (state: SidebarState) => state.rightSidebarVisible
  )
  const toggleRightSidebar = useSidebarStore(
    (state: SidebarState) => state.toggleRightSidebar
  )

  const label = t(
    rightSidebarVisible
      ? 'titlebar.hideRightSidebar'
      : 'titlebar.showRightSidebar'
  )

  return (
    <button
      type="button"
      onClick={toggleRightSidebar}
      className="hidden max-[1200px]:flex cursor-pointer rounded-md p-1.5 text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-elev-2)]"
      title={label}
      aria-label={label}
    >
      {rightSidebarVisible ? (
        <PanelRightClose className="h-4 w-4" />
      ) : (
        <PanelRightOpen className="h-4 w-4" />
      )}
    </button>
  )
}

/**
 * 返回会话按钮 — 对齐 prototype.html 中的 .back-btn
 *
 * I1: 接线 view-store 实现实际后退导航。
 * - canGoBack（boolean 派生字段）：历史栈长度 > 1 时为 true，控制按钮显隐
 * - goBack()：弹出当前视图，回到上一个视图（如 config → chat）
 *
 * 原型中默认隐藏（canGoBack=false），切换到非 chat 视图后显示。
 * 快捷键：Alt + ←
 */
function BackButton() {
  const { t } = useTranslation()
  // canGoBack 是 boolean 派生字段（非函数），直接读取即可
  const canGoBack = useViewStore(s => s.canGoBack)
  const goBack = useViewStore(s => s.goBack)

  return (
    <button
      type="button"
      onClick={goBack}
      // canGoBack 为 false 时隐藏按钮（无历史可后退）
      className={cn(
        'cursor-pointer rounded-md p-1.5 text-[var(--text-faint)] transition-all hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)] active:scale-95',
        !canGoBack && 'hidden'
      )}
      title={`${t('titlebar.backToConversation')} (Alt+←)`}
      aria-label={t('titlebar.backToConversation')}
      aria-disabled={!canGoBack}
    >
      <ArrowLeft className="h-4 w-4" />
    </button>
  )
}

/**
 * 命令面板图标按钮 — 对齐 prototype.html 中的 #paletteBtn
 *
 * 点击打开命令面板，快捷键 ⌘P / Ctrl+P。
 * 仅显示搜索图标，是命令面板的精简入口。
 */
function CommandPaletteButton() {
  const { t } = useTranslation()
  // I-T-004: 读取当前开合状态以支持 toggle（store 的 setter 仅接受布尔值）
  const commandPaletteOpen = useDialogStore(
    (state: DialogState) => state.commandPaletteOpen
  )
  const setCommandPaletteOpen = useDialogStore(
    (state: DialogState) => state.setCommandPaletteOpen
  )

  return (
    <button
      type="button"
      onClick={() => setCommandPaletteOpen(!commandPaletteOpen)}
      className="cursor-pointer rounded-md p-1.5 text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]"
      title={`${t('titlebar.commandPalette')} (⌘P)`}
      aria-label={t('titlebar.commandPalette')}
      aria-expanded={commandPaletteOpen}
    >
      <Search className="h-4 w-4" />
    </button>
  )
}

/**
 * 命令面板显性入口按钮 — 对齐 prototype.html 中的 .palette-entry-btn
 *
 * 带文字 "命令面板" + 快捷键 kbd 的按钮，提供更明显的入口。
 * 与 paletteBtn 功能相同，只是视觉形式不同。
 */
function CommandPaletteEntryButton() {
  const { t } = useTranslation()
  const setCommandPaletteOpen = useDialogStore(
    (state: DialogState) => state.setCommandPaletteOpen
  )

  return (
    <button
      type="button"
      onClick={() => setCommandPaletteOpen(true)}
      className="inline-flex cursor-pointer items-center gap-[5px] rounded-[5px] border border-[var(--border)] bg-[var(--bg-elev-2)] px-2 py-[3px] text-[10px] text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-elev)] hover:text-[var(--text)]"
      title={`${t('titlebar.commandPalette')} (⌘P)`}
      aria-label={t('titlebar.openCommandPalette')}
    >
      {/* 搜索图标 — 与 paletteBtn 保持一致 */}
      <Search className="h-3 w-3" />
      {/* 按钮文字 */}
      <span>{t('titlebar.commandPalette')}</span>
      {/* 快捷键 kbd — mono 字体 + 原型指定样式 */}
      <kbd className="rounded-[3px] border border-[var(--border)] bg-[var(--bg)] px-1 py-px font-mono text-[9px]">
        ⌘P
      </kbd>
    </button>
  )
}

/**
 * 跨平台标题栏组件。
 *
 * 按平台渲染对应的标题栏：
 * - **macOS**：自定义标题栏，交通灯按钮位于左侧
 * - **Windows**：自定义标题栏，控制按钮位于右侧
 * - **Linux**：仅渲染工具栏（窗口控制由原生装饰提供）
 *
 * 顶栏布局（对齐 prototype.html）：
 *   [窗口控制] [侧栏开关] [品牌标识] —— 弹性间隔 —— [右栏开关] [设置] [窗口控制]
 *
 * 底部通过 .topbar-glow::after 伪元素绘制 accent 渐变线。
 *
 * 开发环境下可使用 `forcePlatform` 属性测试其他平台布局。
 */
export function TitleBar({ className, title, forcePlatform }: TitleBarProps) {
  const { t } = useTranslation()
  const displayTitle = title ?? t('titlebar.default')
  const detectedPlatform = usePlatform()

  // 开发环境下允许强制指定平台，便于测试
  const platform =
    import.meta.env.DEV && forcePlatform ? forcePlatform : detectedPlatform

  // Linux 使用原生窗口装饰，仅渲染工具栏
  if (platform === 'linux') {
    return <LinuxTitleBar className={className} title={displayTitle} />
  }

  // Windows: 窗口控制按钮在右侧
  if (platform === 'windows') {
    return (
      <div
        data-tauri-drag-region
        className={cn(
          'topbar-glow relative flex h-[52px] w-full shrink-0 items-center gap-3.5 border-b bg-gradient-to-b from-[var(--bg-elev)] to-[var(--bg)] px-[18px]',
          className
        )}
      >
        {/* 窄屏侧栏抽屉触发按钮 — 默认隐藏，窄屏由 App.css 媒体查询显示 */}
        <SidebarDrawerToggle />
        {/* 侧栏开关按钮 — 最左侧 */}
        <LeftSidebarToggle />
        {/* 品牌标识区 — 侧栏开关之后 */}
        <BrandArea />
        {/* 返回会话按钮 — 品牌区之后 */}
        <BackButton />
        {/* 弹性间隔 — 保留为拖拽区域 */}
        <div className="flex-1" data-tauri-drag-region />
        {/* 右侧栏开关 */}
        <RightSidebarToggle />
        {/* 命令面板图标按钮 */}
        <CommandPaletteButton />
        {/* 命令面板显性入口 */}
        <CommandPaletteEntryButton />
        {/* 开发演示按钮 — 对齐原型 #abDev，使用完整 DemoPanel（4分组+注入逻辑） */}
        <DemoPanel />
        {/* Windows 窗口控制按钮 */}
        <WindowsWindowControls />
      </div>
    )
  }

  // macOS（默认）：交通灯按钮在左侧
  return (
    <div
      data-tauri-drag-region
      className={cn(
        'topbar-glow relative flex h-[52px] w-full shrink-0 items-center gap-3.5 border-b bg-gradient-to-b from-[var(--bg-elev)] to-[var(--bg)] px-[18px]',
        className
      )}
    >
      {/* macOS 交通灯按钮 — 最左侧 */}
      <MacOSWindowControls />
      {/* 窄屏侧栏抽屉触发按钮 — 默认隐藏，窄屏由 App.css 媒体查询显示 */}
      <SidebarDrawerToggle />
      {/* 侧栏开关按钮 */}
      <LeftSidebarToggle />
      {/* 品牌标识区 */}
      <BrandArea />
      {/* 返回会话按钮 */}
      <BackButton />
      {/* 弹性间隔 — 保留为拖拽区域 */}
      <div className="flex-1" data-tauri-drag-region />
      {/* 右侧栏开关 */}
      <RightSidebarToggle />
      {/* 命令面板图标按钮 */}
      <CommandPaletteButton />
      {/* 命令面板显性入口 */}
      <CommandPaletteEntryButton />
      {/* 开发演示按钮 — 对齐原型 #abDev（macOS 分支与 Windows 一致），使用完整 DemoPanel */}
      <DemoPanel />
    </div>
  )
}
