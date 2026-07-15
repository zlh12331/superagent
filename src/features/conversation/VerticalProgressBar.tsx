/**
 * VerticalProgressBar — 垂直进度条
 *
 * 对应 prototype.html 的 `.msg-nav-rail` 导航栏。
 * 功能：
 * - 显示当前 thread 的进度圆点（I-M-010: 优先代表用户消息位置，回退代表轮次）
 * - 活跃圆点高亮（accent 色 + 发光）
 * - hover 圆点时显示 tooltip，提示对应位置信息
 * - I-M-011: 滚动联动 active 状态（activeMessageIndex 控制高亮圆点）
 * - I-M-012: 圆点数量限制（超过 MAX_DOTS 时按比例映射）
 *
 * 数据源优先级（I-M-010）：
 *   1. userMessages（圆点代表用户消息位置，与进度条滚动联动配合）
 *   2. turns（向后兼容：父组件未传入 userMessages 时使用，圆点代表轮次）
 *
 * 关键设计约束（来自项目记忆）：
 *   tooltip 背景必须使用不透明色 --bg-elev-3
 *   （dark: #1A2130, light: #E0E4EC），禁止使用半透明色。
 *
 * 参考样式：prototype.html 第 620-699 行
 */

import { useMemo } from 'react'
import type { Turn, TurnStatus } from '@/lib/codex/types'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * I-M-012: 圆点数量上限。
 * 当数据源条目数超过此值时，按比例映射为 MAX_DOTS 个圆点，
 * 避免圆点过多导致导航栏溢出。
 */
const MAX_DOTS = 10

/** 轮次状态对应的中文标签（用于 tooltip 显示，向后兼容 turns 模式） */
const TURN_STATUS_LABEL: Record<TurnStatus, string> = {
  pending: '等待中',
  running: '进行中',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
}

/**
 * 用户消息位置信息（I-M-010 进度条数据源）。
 * - id: 消息 ID（用于点击时定位滚动）
 * - index: 用户消息序号（0-based，与 MessageList 的 data-user-index 对应）
 */
export interface UserMessageDot {
  id: string
  index: number
}

export interface VerticalProgressBarProps {
  /**
   * 轮次历史列表（向后兼容数据源）。
   * 当未传入 userMessages 时使用，圆点代表轮次。
   */
  turns: Turn[]
  /** 当前活跃轮次 ID（高亮对应的圆点，向后兼容 turns 模式） */
  activeTurnId: string | null
  /**
   * I-M-010: 用户消息列表（优先数据源，圆点代表用户消息位置）。
   * 传入后优先于 turns 使用，圆点代表用户消息而非轮次。
   */
  userMessages?: UserMessageDot[]
  /**
   * I-M-011: 当前活跃用户消息索引（滚动联动高亮）。
   * 与 MessageList 的 onScrollActiveIndex 回调配合使用。
   * null 表示无活跃用户消息（初始化或无用户消息时）。
   * 使用 number | null 而非可选属性，兼容 exactOptionalPropertyTypes。
   */
  activeMessageIndex?: number | null
  /**
   * 点击圆点回调。
   * index 为圆点对应的数据源索引（userMessages 模式下为用户消息序号），
   * 父组件据此滚动到对应消息位置。
   */
  onDotClick?: (index: number) => void
  className?: string
}

/** 圆点渲染数据（内部类型） */
interface DotData {
  /** React key（避免重复 key 警告） */
  key: string
  /** 圆点序号（0-based，用于 aria-label） */
  dotIndex: number
  /** 数据源中的原始索引（onDotClick 传此值） */
  sourceIndex: number
  /** 是否为当前活跃圆点 */
  isActive: boolean
  /** tooltip 显示文本 */
  label: string
}

/**
 * 垂直进度条组件。
 *
 * 当数据源为空时不渲染（opacity-0 隐藏）。
 * 圆点纵向排列，中间有一条竖线连接。
 *
 * I-M-012: 当圆点数超过 MAX_DOTS（10）时，按比例映射选取 MAX_DOTS 个圆点，
 * 公式：sourceIndex = Math.floor(dotIdx * items.length / MAX_DOTS)。
 */
export function VerticalProgressBar({
  turns,
  activeTurnId,
  userMessages,
  activeMessageIndex,
  onDotClick,
  className,
}: VerticalProgressBarProps) {
  // 预计算圆点数据，避免渲染时重复计算
  const dots = useMemo<DotData[]>(() => {
    // I-M-010: 判断数据源模式（优先 userMessages，回退 turns）
    const isUserMode = userMessages !== undefined

    // 构建统一格式的圆点数据源
    const items: {
      id: string
      index: number
      isActive: boolean
      label: string
    }[] = isUserMode
      ? (userMessages ?? []).map(m => ({
          id: m.id,
          index: m.index,
          // I-M-011: 用户消息模式下按 activeMessageIndex 高亮
          isActive: m.index === activeMessageIndex,
          label: `用户消息 ${m.index + 1}`,
        }))
      : turns.map((t, i) => ({
          id: t.id,
          index: i,
          // 向后兼容：轮次模式下按 activeTurnId 高亮
          isActive: t.id === activeTurnId,
          label: `轮次 ${i + 1} · ${TURN_STATUS_LABEL[t.status] ?? '未知'}`,
        }))

    if (items.length === 0) return []

    // I-M-012: 圆点数量限制
    // 未超过 MAX_DOTS 时直接使用全部；超过时按比例映射 MAX_DOTS 个圆点
    if (items.length <= MAX_DOTS) {
      return items.map((item, dotIdx) => ({
        key: `${item.id}-${dotIdx}`,
        dotIndex: dotIdx,
        sourceIndex: dotIdx,
        isActive: item.isActive,
        label: item.label,
      }))
    }

    // 超过 MAX_DOTS：按比例映射，均匀选取 MAX_DOTS 个圆点
    // 公式：sourceIndex = Math.floor(dotIdx * items.length / MAX_DOTS)
    // 并限制在 [0, items.length - 1] 范围内（防止 Math.floor 溢出）
    return Array.from({ length: MAX_DOTS }, (_, dotIdx) => {
      const srcIdx = Math.min(
        Math.floor((dotIdx * items.length) / MAX_DOTS),
        items.length - 1
      )
      const item = items[srcIdx]
      // P1-4: 超过 MAX_DOTS 时 active 判断需用区间映射
      // userMessages 模式下，映射后的圆点 sourceIndex 不等于 activeMessageIndex，
      // 需判断 activeMessageIndex 是否落在 [srcIdx, nextSrcIdx) 区间内；
      // turns 模式保留原 item.isActive 判断（基于 activeTurnId）
      const nextSrcIdx = Math.min(
        Math.floor(((dotIdx + 1) * items.length) / MAX_DOTS),
        items.length - 1
      )
      const isActive = isUserMode
        ? activeMessageIndex != null &&
          srcIdx <= activeMessageIndex &&
          (dotIdx === MAX_DOTS - 1 || nextSrcIdx > activeMessageIndex)
        : (item?.isActive ?? false)
      return {
        key: `${item?.id ?? ''}-${dotIdx}`,
        dotIndex: dotIdx,
        sourceIndex: srcIdx,
        isActive,
        label: item?.label ?? '',
      }
    })
  }, [userMessages, turns, activeMessageIndex, activeTurnId])

  // 对齐原型 updateMsgNavRail() L9594：只在 2 条及以上用户消息时显示进度条
  // 少于 2 条时隐藏（避免单消息场景下显示孤立圆点，无导航意义）
  const visible = dots.length >= 2

  return (
    // 对齐原型 .msg-nav-rail（prototype.html L620-697）：
    // 外层 sticky 锚点，w-0 h-0 不占布局空间，仅作定位参考
    <div
      className={cn(
        // M-A-012: z-5 改为 z-[5]（Tailwind v4 默认无 z-5 档位，任意值语法才生效）
        // M-A-008: 600px 断点下隐藏导航栏（对齐原型 .msg-nav-rail { display:none }）
        // H2: 定位改为 sticky（原 absolute），跟随消息列表滚动并保持可见
        // w-0 h-0 overflow-visible: 对齐原型 .msg-nav-rail { width:0; height:0 }，锚点不占空间
        // P0 修复：删除外层 left-1.5（原型外层无 left 偏移，仅内层 left:6px）
        //   原先外层+内层各偏移 6px，导致圆点实际位于锚点右侧 12px 处，定位错误
        'pointer-events-none sticky top-1/2 z-[5] h-0 w-0 overflow-visible max-[600px]:hidden',
        'transition-opacity duration-300',
        visible ? 'pointer-events-auto opacity-100' : 'opacity-0',
        className
      )}
      aria-hidden={!visible}
    >
      {/* 内层容器 — 对齐原型 .nav-rail-inner（absolute top:0 left:6px translateY(-50%)） */}
      {/* 从锚点向右偏移 6px，垂直居中，包含竖线和圆点 */}
      <div className="absolute left-1.5 top-0 flex -translate-y-1/2 flex-col items-center gap-2.5 px-1 py-1.5">
        {/* 竖线连接所有圆点 — 对齐原型 .nav-rail-line（absolute top:6px bottom:6px left:50% width:1.5px border-radius:1px） */}
        {visible && (
          // H1: 竖线宽度从 1px 改为 1.5px，提升视觉清晰度
          // P0 修复：border-radius 从 rounded-full 改为 rounded-[1px]（对齐原型 1px 圆角）
          <div className="absolute bottom-1.5 left-1/2 top-1.5 w-[1.5px] -translate-x-1/2 rounded-[1px] bg-[var(--border)]" />
        )}

        {/* 圆点列表 */}
        {dots.map(({ key, sourceIndex, isActive, label }) => (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                // I-M-010: 点击时传出数据源索引，父组件据此滚动到对应消息
                onClick={() => onDotClick?.(sourceIndex)}
                className={cn(
                  // P0 修复：对齐原型 .nav-dot
                  //   - cursor:pointer 显式声明（App.css 全局 * { cursor:default } 会覆盖）
                  //   - z-index:1（对齐原型，原 z-10 数值过大）
                  //   - transition 精确属性范围（对齐原型 background-color,border-color,color,box-shadow 0.2s）
                  'relative z-[1] flex cursor-pointer items-center justify-center rounded-full p-0',
                  'border-none transition-[background-color,border-color,color,box-shadow] duration-200',
                  // P0 修复：active 圆点发光色从 --accent-glow 改为 --accent-2
                  //   原型用蓝色 --accent-2 形成对比色发光，前端误用 --accent-glow 导致
                  //   发光颜色与圆点本体同色且过于微弱
                  isActive
                    ? 'size-2 bg-[var(--accent)] shadow-[0_0_6px_var(--accent-2)]'
                    : 'size-1.5 bg-[var(--text-faint)] opacity-40 hover:opacity-70 hover:scale-[1.2]'
                )}
                aria-label={label}
              />
            </TooltipTrigger>
            {/* tooltip 背景必须使用不透明色 --bg-elev-3（项目硬性约束） */}
            {/* P0 修复：补 max-w-[280px] truncate 与 leading-6（对齐原型 L685-687, L683） */}
            <TooltipContent
              side="right"
              className={cn(
                'max-w-[280px] border border-[var(--border)] bg-[var(--bg-elev-3)] text-[var(--text)]',
                'px-2.5 py-1.5 text-xs leading-6 shadow-[0_2px_8px_rgba(0,0,0,0.2)]'
              )}
            >
              <span className="block truncate">{label}</span>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}
