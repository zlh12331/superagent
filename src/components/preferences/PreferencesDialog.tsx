/**
 * PreferencesDialog — 设置抽屉
 *
 * 参照 prototype.html `.drawer` (行 5881-6391) 实现：
 * - 右侧滑出抽屉（Sheet side="right"），宽度可拖拽调整（360-800px）
 * - 左侧导航 160px + 右侧内容区
 * - 17 个分区按 4 组分类（模型与权限 / 扩展能力 / 视图与外观 / 账户与应用）
 * - 导航项带图标，active 状态有左侧 accent 条
 * - drawer-resizer 拖拽条位于抽屉左边缘，hover 时高亮 accent 色
 *
 * 状态管理：useDialogStore.preferencesOpen 控制开关。
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useViewStore } from '@/store/view-store'
import {
  Settings as SettingsIcon,
  Palette,
  KeyRound,
  Code2,
  Keyboard,
  Server,
  Zap,
  User,
  Info,
  X,
  Shield,
  FlaskConical,
  Star,
  AlertTriangle,
  Terminal,
  Users,
  SlidersHorizontal,
  LayoutGrid,
  ShoppingCart,
  Globe,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { useDialogStore, type DialogState } from '@/store/dialog-store'
import {
  GeneralSettingsPane,
  AppearanceSettingsPane,
  ApiConfigSettingsPane,
  EditorSettingsPane,
  ShortcutsSettingsPane,
  McpSettingsPane,
  AdvancedSettingsPane,
  AccountSettingsPane,
  AboutSettingsPane,
  PermissionSettingsPane,
  ExperimentalSettingsPane,
  SkillsSettingsPane,
  HooksSettingsPane,
  EnvironmentSettingsPane,
  CollaborationSettingsPane,
  AppsSettingsPane,
  MarketplaceSettingsPane,
} from './panes/SettingsPanes'

// ─── 导航配置 ──────────────────────────────────────────

/** 设置分区 ID — 包含全部 17 个分区 + 远程控制视图 */
type SectionId =
  // 原有 9 个
  | 'general'
  | 'appearance'
  | 'api-config'
  | 'editor'
  | 'shortcuts'
  | 'mcp'
  | 'advanced'
  | 'account'
  | 'about'
  // 新增 8 个
  | 'permission'
  | 'experimental'
  | 'skills'
  | 'hooks'
  | 'environment'
  | 'collaboration'
  | 'apps'
  | 'marketplace'
  // 视图切换项（非分区，对应原型 data-view="remote"）
  | 'remote'

interface NavItem {
  /** 分区 ID */
  id: SectionId
  /** 导航项显示文字 */
  label: string
  /** 行首图标（lucide-react 组件） */
  icon: LucideIcon
  /** 可选的 badge 数字（如钩子告警数） */
  badge?: number
  /** badge 类型：warn 为黄色告警 */
  badgeKind?: 'warn'
  /**
   * 是否为视图切换项（而非分区切换项）。
   *
   * 原型中 `data-view="remote"` 的"远程控制"使用此标识：
   * 点击时不切换右侧分区内容，而是触发视图切换
   * （通过 useViewStore.switchView 切换到对应视图）。
   */
  isView?: boolean
  /**
   * 该项前是否渲染分隔符（对应原型 `.drawer-nav-sep`）。
   * 用于在分组内部分隔不同性质的导航项，如"视图与外观"组中的远程控制。
   */
  precededBySeparator?: boolean
}

interface NavGroup {
  /** 分组标题（如「模型与权限」） */
  label: string
  /** 该组下的所有导航项 */
  items: NavItem[]
}

/**
 * 导航分组 — 对齐 prototype.html 第 5896-5961 行的 4 组结构。
 * 原型中不存在的 pane（外观/编辑器/快捷键/高级/关于）按语义就近归组。
 */
const NAV_GROUPS: NavGroup[] = [
  {
    label: '模型与权限',
    items: [
      { id: 'api-config', label: '模型配置', icon: KeyRound },
      { id: 'permission', label: '权限配置', icon: Shield },
    ],
  },
  {
    label: '扩展能力',
    items: [
      { id: 'experimental', label: '实验功能', icon: FlaskConical },
      { id: 'mcp', label: 'MCP 服务器', icon: Server },
      { id: 'skills', label: '技能', icon: Star },
      { id: 'hooks', label: '钩子', icon: AlertTriangle, badge: 2, badgeKind: 'warn' },
      { id: 'environment', label: '环境', icon: Terminal },
      { id: 'advanced', label: '高级', icon: Zap },
    ],
  },
  {
    label: '视图与外观',
    items: [
      { id: 'collaboration', label: '协作模式', icon: Users },
      { id: 'general', label: '通用', icon: SlidersHorizontal },
      { id: 'appearance', label: '外观', icon: Palette },
      { id: 'editor', label: '编辑器', icon: Code2 },
      { id: 'shortcuts', label: '快捷键', icon: Keyboard },
      // 远程控制 — 对应原型 data-view="remote"（行 5941-5945）。
      // precededBySeparator: true 渲染分组内分隔符 .drawer-nav-sep。
      // isView: true 表示点击时触发视图切换而非分区切换。
      {
        id: 'remote',
        label: '远程控制',
        icon: Globe,
        isView: true,
        precededBySeparator: true,
      },
    ],
  },
  {
    label: '账户与应用',
    items: [
      { id: 'account', label: '账户', icon: User },
      { id: 'apps', label: '应用', icon: LayoutGrid },
      { id: 'marketplace', label: '插件市场', icon: ShoppingCart },
      { id: 'about', label: '关于', icon: Info },
    ],
  },
]

// ─── 分区渲染器 ───────────────────────────────────────────

/**
 * 根据 activeSection 渲染对应的设置分区组件。
 *
 * 集中分发函数，避免在 JSX 中堆叠 17 个条件分支。
 *
 * @param section — 当前激活的分区 ID
 * @returns 对应的 SettingsPane 组件
 */
function renderSection(section: SectionId) {
  switch (section) {
    case 'general':
      return <GeneralSettingsPane />
    case 'appearance':
      return <AppearanceSettingsPane />
    case 'api-config':
      return <ApiConfigSettingsPane />
    case 'editor':
      return <EditorSettingsPane />
    case 'shortcuts':
      return <ShortcutsSettingsPane />
    case 'mcp':
      return <McpSettingsPane />
    case 'advanced':
      return <AdvancedSettingsPane />
    case 'account':
      return <AccountSettingsPane />
    case 'about':
      return <AboutSettingsPane />
    case 'permission':
      return <PermissionSettingsPane />
    case 'experimental':
      return <ExperimentalSettingsPane />
    case 'skills':
      return <SkillsSettingsPane />
    case 'hooks':
      return <HooksSettingsPane />
    case 'environment':
      return <EnvironmentSettingsPane />
    case 'collaboration':
      return <CollaborationSettingsPane />
    case 'apps':
      return <AppsSettingsPane />
    case 'marketplace':
      return <MarketplaceSettingsPane />
    case 'remote':
      // 远程控制是视图切换项（isView=true），不会进入 renderSection。
      // 此处仅作类型穷尽性兜底，正常流程不会执行。
      return null
  }
}

// ─── 抽屉宽度调整 hook ────────────────────────────────────────

/** 抽屉宽度范围 */
const DRAWER_MIN_WIDTH = 360
const DRAWER_DEFAULT_WIDTH = 540

/**
 * useDrawerResize — 管理抽屉拖拽调整宽度的逻辑。
 *
 * 实现思路（使用 Pointer Events，统一支持鼠标 / 触摸 / 触控笔）：
 * - pointerdown 记录起始 X 和起始宽度，并动态计算当前最大宽度（视口宽度的 92%）
 * - pointermove 实时计算新宽度 = 起始宽度 + (起始 X - 当前 X)
 *   （抽屉在右侧，鼠标左移 → 宽度增大）
 * - pointerup / pointercancel 结束拖拽，移除所有监听
 *
 * 相比旧的 mouse 事件方案：
 * - pointer 事件天然支持触摸与触控笔，无需额外 touchstart/touchmove 适配
 * - pointercancel 可捕获系统中断（如滚动干预），避免监听泄漏
 *
 * 返回：宽度、是否拖拽中、resizer 的 pointerdown 处理函数
 */
function useDrawerResize() {
  const [width, setWidth] = useState(DRAWER_DEFAULT_WIDTH)
  const [isDragging, setIsDragging] = useState(false)
  // 用 ref 存储拖拽过程中的起始值与动态计算的最大宽度，避免闭包陷阱
  const dragState = useRef({
    startX: 0,
    startWidth: DRAWER_DEFAULT_WIDTH,
    // 拖拽开始时动态计算的最大宽度（视口宽度的 92%），替代旧的固定 800px 常量
    maxW: 0,
  })
  // 抽屉内容容器的 ref — 拖拽时直接操作 DOM 实现即时视觉反馈，
  // 避免每像素 pointermove 都触发 React 重渲染（性能优化）
  const sheetRef = useRef<HTMLDivElement>(null)
  // RAF 节流：将多次 pointermove 的 setWidth 合并为一次 React 状态更新
  const rafIdRef = useRef<number | null>(null)
  // 暂存的待提交宽度值，RAF 回调中读取并清空
  const pendingWidthRef = useRef<number | null>(null)

  // 拖拽时禁用 body 文本选中，避免拖拽过程中选中导航文字
  // 用 useEffect 响应 isDragging 状态变更，符合 React 副作用管理规范
  useEffect(() => {
    if (isDragging) {
      document.body.style.userSelect = 'none'
    }
    return () => {
      document.body.style.userSelect = ''
    }
  }, [isDragging])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    // 拖拽开始时动态计算最大宽度：视口宽度的 92%，确保抽屉不会超出可视区域
    // 旧的固定 800px 在窄屏下会溢出，宽屏下又限制了可用空间
    const maxW = Math.round(window.innerWidth * 0.92)
    dragState.current = {
      startX: e.clientX,
      startWidth: width,
      maxW,
    }
    setIsDragging(true)

    // 拖拽过程中实时更新宽度
    const handlePointerMove = (ev: PointerEvent) => {
      // 抽屉在右侧：鼠标左移 → clientX 减小 → 宽度增大
      const delta = dragState.current.startX - ev.clientX
      const newWidth = Math.min(
        dragState.current.maxW,
        Math.max(DRAWER_MIN_WIDTH, dragState.current.startWidth + delta)
      )
      // 直接操作 DOM 实现即时视觉反馈，避免每像素触发 React 重渲染
      const sheet = sheetRef.current
      if (sheet) sheet.style.width = `${newWidth}px`
      // setWidth 推迟到 RAF，合并多次 pointermove 为一次 React 状态更新
      pendingWidthRef.current = newWidth
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null
          if (pendingWidthRef.current !== null) {
            setWidth(pendingWidthRef.current)
            pendingWidthRef.current = null
          }
        })
      }
    }

    // 拖拽结束（pointerup 或 pointercancel），移除所有事件监听
    // pointercancel 在系统干预拖拽（如浏览器滚动捕获）时触发，
    // 必须监听以避免监听器残留导致后续 pointer 事件泄漏
    const handlePointerEnd = () => {
      // 取消未执行的 RAF，并将暂存宽度立即提交到 React 状态，
      // 确保拖拽结束时 DOM 宽度与 React 状态完全同步
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      if (pendingWidthRef.current !== null) {
        setWidth(pendingWidthRef.current)
        pendingWidthRef.current = null
      }
      setIsDragging(false)
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerEnd)
      document.removeEventListener('pointercancel', handlePointerEnd)
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerEnd)
    document.addEventListener('pointercancel', handlePointerEnd)
  }, [width])

  return { width, isDragging, handlePointerDown, sheetRef, setWidth }
}

// ─── 主组件 ─────────────────────────────────────────────

/**
 * PreferencesDialog 组件 —— 设置抽屉。
 *
 * 渲染逻辑：
 *  - Sheet（shadcn/ui）从右侧滑出，宽度可拖拽调整（360-800px，默认 540px）
 *  - 主体为 grid 布局：左侧 160px 导航 + 右侧内容区
 *  - 导航按 4 组分类（模型与权限 / 扩展能力 / 视图与外观 / 账户与应用）
 *  - 内容区根据 activeSection 渲染对应 SettingsPane
 *
 * 状态依赖：
 *  - useDialogStore 读写 preferencesOpen
 *  - 本地 useState 管理 activeSection（默认 'api-config'）
 *  - useDrawerResize hook 管理抽屉宽度
 *
 * 副作用：
 *  - 注册 ⌘/Ctrl + , 全局快捷键打开抽屉
 *  - 拖拽 resizer 时禁用 body 文本选中
 *
 * 设计决策：
 *  - 17 个分区按业务语义分 4 组，便于用户快速定位
 *  - 拖拽调整宽度使用 mousedown + document mousemove/up 监听，避免 React 闭包陷阱
 *  - SheetTitle / SheetDescription 设为 sr-only，保留可访问性但不显示文字
 *
 * @see src/components/preferences/panes/SettingsPanes.tsx — 各分区组件
 */
export function PreferencesDialog() {
  const [activeSection, setActiveSection] = useState<SectionId>('api-config')
  const preferencesOpen = useDialogStore(
    (state: DialogState) => state.preferencesOpen
  )
  const setPreferencesOpen = useDialogStore(
    (state: DialogState) => state.setPreferencesOpen
  )

  // D1 修复：remote 入口切换到 remote 视图（替代原 toast 占位）
  const switchView = useViewStore(s => s.switchView)

  // 抽屉拖拽调整宽度
  const { width, isDragging, handlePointerDown, sheetRef, setWidth } = useDrawerResize()

  // ⌘/Ctrl + , 打开设置：已由 use-keyboard-shortcuts.ts 统一注册
  // （经 'open-preferences' 命令路由），此处不再重复监听，避免与全局
  // 快捷键系统产生双重触发。详见 use-keyboard-shortcuts.ts 第 45-47 行。

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setPreferencesOpen(open)
    },
    [setPreferencesOpen]
  )

  return (
    <Sheet open={preferencesOpen} onOpenChange={handleOpenChange}>
      <SheetContent
        ref={sheetRef}
        side="right"
        style={{ width: `${width}px` }}
        className="flex max-w-[92vw] flex-col gap-0 border-l border-[var(--border-strong)] bg-[var(--bg-elev)] p-0 sm:max-w-[92vw]"
      >
        <SheetTitle className="sr-only">设置</SheetTitle>
        <SheetDescription className="sr-only">
          应用程序设置面板
        </SheetDescription>

        {/* ─── Drawer Resizer ───────────────────────────────────
            参照 prototype.html 第 2630-2661 行：
            - 位于抽屉左边缘，4px 宽的拖拽条
            - hover 时显示 accent 色把手
            - dragging 时背景加深 */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="设置面板宽度调整"
          aria-valuenow={width}
          aria-valuemin={DRAWER_MIN_WIDTH}
          aria-valuemax={Math.round(window.innerWidth * 0.92)}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onKeyDown={(e) => {
            // 方向键调整面板宽度：左箭头增宽、右箭头减宽
            // 每次 20px，对齐常见 separator 控件的步进量
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              setWidth(w => Math.min(Math.round(window.innerWidth * 0.92), w + 20))
            } else if (e.key === 'ArrowRight') {
              e.preventDefault()
              setWidth(w => Math.max(DRAWER_MIN_WIDTH, w - 20))
            }
          }}
          title="拖拽调整设置面板宽度"
          className={cn(
            'absolute top-0 bottom-0 left-[-4px] z-[5] flex w-[8px] touch-none cursor-col-resize items-center justify-center transition-colors',
            isDragging
              ? 'bg-[rgba(0,229,199,0.15)]'
              : 'bg-transparent hover:bg-[rgba(0,229,199,0.08)]'
          )}
        >
          {/* 拖拽把手竖线 — hover/dragging 时变粗变亮 */}
          <span
            className={cn(
              'h-full w-px rounded-[1px] transition-all',
              isDragging
                ? 'w-[2px] bg-[var(--accent)] shadow-[0_0_8px_rgba(0,229,199,0.5)]'
                : 'bg-[var(--border)] hover:w-[2px] hover:bg-[var(--accent)] hover:shadow-[0_0_8px_rgba(0,229,199,0.5)]'
            )}
          />
        </div>

        {/* 头部 */}
        <div className="flex shrink-0 items-center gap-2.5 border-b border-[var(--border)] bg-[var(--bg-elev-2)] px-[18px] py-3.5">
          <SettingsIcon
            width={16}
            height={16}
            className="text-[var(--accent)]"
          />
          <span className="text-[14px] font-semibold text-[var(--text)]">
            设置
          </span>
          <span className="font-mono text-[11px] text-[var(--text-faint)]">
            Settings
          </span>
          <button
            type="button"
            onClick={() => setPreferencesOpen(false)}
            className="ml-auto flex h-[26px] w-[26px] items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]"
            aria-label="关闭设置抽屉"
          >
            <X width={16} height={16} />
          </button>
        </div>

        {/* 主体：导航 + 内容 */}
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[160px_1fr] overflow-hidden">
          {/* 导航 */}
          <nav
            className="overflow-y-auto overflow-x-hidden border-r border-[var(--border)] bg-[var(--bg-elev-2)] px-2 py-3"
            role="tablist"
            aria-label="设置分区"
            onKeyDown={e => {
              // 仅处理上下方向键，其他按键交由浏览器默认行为
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
              e.preventDefault()
              // 获取所有可导航按钮（跳过分隔符与分组标签）
              const buttons = Array.from(
                e.currentTarget.querySelectorAll<HTMLButtonElement>(
                  'button[data-nav-item="true"]'
                )
              )
              if (buttons.length === 0) return
              // 找到当前获得焦点的按钮在列表中的位置
              const activeEl = document.activeElement as HTMLElement | null
              const currentIndex = buttons.findIndex(
                btn => btn === activeEl
              )
              let nextIndex: number
              if (e.key === 'ArrowDown') {
                // 向下：到末尾循环到第一个
                nextIndex =
                  currentIndex === -1 || currentIndex === buttons.length - 1
                    ? 0
                    : currentIndex + 1
              } else {
                // 向上：到开头循环到最后一个
                nextIndex =
                  currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1
              }
              buttons[nextIndex]?.focus()
            }}
          >
            {NAV_GROUPS.map(group => (
              <div key={group.label} className="mb-1">
                {/* 分组标签 — 统一 pt-2（对应原型 .drawer-nav-label 的 8px 上间距） */}
                {/* drawer-nav-label — pb 4px 对齐原型 padding:8px 12px 4px（D-A-010 修复） */}
                <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-faint)]">
                  {group.label}
                </div>
                {group.items.map(item => {
                  const isActive = activeSection === item.id
                  const Icon = item.icon
                  return (
                    <div key={item.id}>
                      {/* 分组内分隔符 — 对应原型 .drawer-nav-sep（行 2738-2742） */}
                      {item.precededBySeparator && (
                        <div className="my-1.5 mx-1 h-px bg-[var(--border)]" />
                      )}
                      <button
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        data-nav-item="true"
                        onClick={() => {
                          // D1 修复：视图切换项（如远程控制）不切换分区，
                          // 而是触发实际的视图切换：调用 switchView('remote')
                          // 切换到远程控制视图，并关闭设置抽屉。
                          if (item.isView) {
                            switchView('remote')
                            setPreferencesOpen(false)
                            return
                          }
                          setActiveSection(item.id)
                        }}
                        className={cn(
                          'mb-0.5 flex w-full items-center gap-[9px] rounded-[7px] px-2.5 py-2 text-left text-[12.5px] transition-colors',
                          isActive
                            ? 'bg-[var(--bg-elev)] text-[var(--accent)] shadow-[inset_2px_0_0_var(--accent)]'
                            : 'text-[var(--text-dim)] hover:bg-[var(--bg-elev)] hover:text-[var(--text)]'
                        )}
                      >
                        <Icon width={14} height={14} className="shrink-0" />
                        <span className="truncate">{item.label}</span>
                        {/* 告警 badge（如钩子的 warn 数字） */}
                        {item.badge !== undefined && (
                          <span
                            className={cn(
                              'ml-auto shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9px] font-bold leading-none',
                              item.badgeKind === 'warn'
                                ? 'bg-[var(--info-amber)] text-[var(--warn)]'
                                : 'bg-[var(--info-blue)] text-[var(--accent)]'
                            )}
                          >
                            {item.badge}
                          </span>
                        )}
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
          </nav>

          {/* 内容 */}
          <div className="overflow-y-auto overflow-x-hidden px-5 py-[18px]">
            {renderSection(activeSection)}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
