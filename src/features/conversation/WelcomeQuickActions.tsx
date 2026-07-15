/**
 * WelcomeQuickActions — Welcome 快捷入口
 *
 * 对应 prototype.html 的 `.welcome-quick-actions`（第 1815-1846 行）。
 *
 * 功能职责：
 *   显示 4 个 pill 按钮，点击后将对应的 prompt 文本填入输入框。
 *   1. 应用开发（LayoutGrid 图标）→ "帮我开发一个应用"
 *   2. 项目理解（Search 图标）→ "帮我理解这个项目的结构和代码"
 *   3. 游戏创意（Star 图标）→ "给我一些游戏创意"
 *   4. 工具知识（Wrench 图标）→ "介绍一些实用的开发工具"
 *
 * 设计说明：
 *   组件为纯展示组件（presentational），不直接操作 store 或 API。
 *   点击 pill 后通过 onPickPrompt 回调将 prompt 文本传递给父组件，
 *   由父组件决定如何使用（如创建新会话并填入草稿）。
 *   这样保持低耦合：本组件可在任意上下文复用。
 *
 * 参考样式：prototype.html 第 1815-1846 行
 *   - 容器：flex、wrap、center 对齐、8px 间距
 *   - pill：transparent 背景、border 边框、20px 圆角、12px 字号
 *   - hover：border-strong 边框、bg-elev-2 背景、text 文字色
 *   - 图标：13x13、0.7 透明度
 */

// P0 修复：3 个图标语义对齐原型 SVG
//   - app-dev: 原型用 4 个 <rect> 方格 → LayoutGrid（原 Code 与原型不符）
//   - project-understand: 原型用 circle+path 放大镜 → Search（原 FolderSearch 与原型不符）
//   - game-idea: 原型用 polygon 五角星 → Star（原 Gamepad2 与原型不符）
import { LayoutGrid, Search, Star, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface WelcomeQuickActionsProps {
  /** 点击 pill 回调，参数为对应的 prompt 文本 */
  onPickPrompt: (prompt: string) => void
}

/** 快捷入口配置项 */
interface QuickAction {
  /** 唯一标识（对应原型 data-welcome-action） */
  id: string
  /** 显示文案 */
  label: string
  /** lucide-react 图标组件 */
  icon: LucideIcon
  /** 点击后填入输入框的 prompt 文本 */
  prompt: string
}

/**
 * 4 个快捷入口配置（对应原型 .welcome-pill 列表）。
 * 图标使用 lucide-react，语义对齐原型 SVG。
 */
const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    id: 'app-dev',
    label: '应用开发',
    icon: LayoutGrid,
    prompt: '帮我开发一个应用',
  },
  {
    id: 'project-understand',
    label: '项目理解',
    icon: Search,
    prompt: '帮我理解这个项目的结构和代码',
  },
  {
    id: 'game-idea',
    label: '游戏创意',
    icon: Star,
    prompt: '给我一些游戏创意',
  },
  {
    id: 'tool-knowledge',
    label: '工具知识',
    icon: Wrench,
    prompt: '介绍一些实用的开发工具',
  },
]

/**
 * WelcomeQuickActions 组件 —— Welcome 屏快捷入口列表。
 *
 * 纯展示组件，渲染 4 个 pill 按钮，点击后通过 onPickPrompt 回调
 * 将对应 prompt 文本传递给父组件，由父组件决定后续操作（如创建新会话）。
 *
 * @param onPickPrompt —— 点击 pill 时触发，参数为对应的 prompt 文本
 */
export function WelcomeQuickActions({
  onPickPrompt,
}: WelcomeQuickActionsProps) {
  return (
    // 容器（参考 .welcome-quick-actions）：flex、wrap、center、8px 间距
    // M-B-003: welcome-mode 下 padding 归零（对齐原型 prototype.html 第 1895 行
    //   .view-chat.welcome-mode .welcome-quick-actions { padding:0 }）
    //   本组件仅在欢迎屏使用，故直接置零；如未来复用于非欢迎屏，应改为通过 prop 控制。
    // P0 修复：删除冗余 pb-0（与 py-0 中的 bottom 重复）
    <div className="flex flex-wrap justify-center gap-2 py-0">
      {QUICK_ACTIONS.map(action => {
        // 动态获取图标组件（lucide-react 模式）
        const Icon = action.icon
        return (
          <button
            key={action.id}
            type="button"
            onClick={() => onPickPrompt(action.prompt)}
            // pill 样式（参考 .welcome-pill）
            // M-B-007: padding 改为 7px 16px（对齐原型 prototype.html 第 1826 行 .welcome-pill { padding:7px 16px }）
            // P0 修复：transition-all 改为精确属性（对齐原型 background-color,border-color,color,box-shadow 0.15s）
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[20px] border border-[var(--border)] bg-transparent px-4 py-[7px] text-xs text-[var(--text-dim)] cursor-pointer transition-[background-color,border-color,color,box-shadow] duration-150 hover:border-[var(--border-strong)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]"
          >
            {/* 图标（参考 .welcome-pill svg：13x13、0.7 透明度） */}
            <Icon className="size-[13px] opacity-70" />
            {action.label}
          </button>
        )
      })}
    </div>
  )
}
