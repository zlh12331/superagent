/**
 * RateLimitBanner — 速率限制提示
 *
 * 对应 prototype.html 的 `.tsb-rate`（第 3353-3375 行）。
 *
 * 功能职责：
 *   1. 当达到速率限制时显示 pill 样式提示 "5h 速率限制 · 剩余 HH:MM:SS"
 *   2. 带倒计时（每秒递减，归零后自动隐藏）
 *   3. 可通过 × 按钮手动关闭
 *
 * 触发机制（D1）：
 *   组件默认隐藏，监听 window 上的 'codex:rate-limit' 自定义事件。
 *   事件 detail 可携带剩余秒数（number），未提供时使用默认初始值。
 *   收到事件后 setVisible(true) 并重置倒计时。
 *   生产环境可由后端通过 Tauri 事件桥接到此自定义事件。
 *
 * 布局说明：
 *   原型中 .tsb-rate 是 thread-status-bar 右槽的 inline-flex pill。
 *   本组件自包含渲染整行状态栏（右侧对齐），关闭后返回 null
 *   避免空行占位，符合原型 .tsb-rate { display: none } 的语义。
 *
 * Mock 说明：
 *   默认初始剩余时间硬编码为 4h 23m 15s（15795 秒），每秒递减。
 *   事件可通过 detail.resetSeconds 覆盖此值。
 *
 * 参考样式：prototype.html 第 3353-3375 行
 *   - pill：bg-elev-2 背景、border 边框、warn 文字、10px 圆角
 *   - 关闭按钮：16x16、透明背景、hover 时半透明 warn 背景
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'

// P0 修复：Mock 初始剩余秒数对齐原型 HTML 中 <strong id="rateResetsIn">02:34:12</strong>
//   2*3600 + 34*60 + 12 = 7200 + 2040 + 12 = 9252 秒
const INITIAL_REMAINING_SECONDS = 2 * 3600 + 34 * 60 + 12

/**
 * 'codex:rate-limit' 自定义事件的 detail 结构。
 * 后端或 Demo 面板通过 window.dispatchEvent 派发此事件触发横幅显示。
 */
export interface RateLimitEventDetail {
  /** 剩余秒数（可选，未提供时使用默认值） */
  resetSeconds?: number
}

/**
 * 将剩余秒数格式化为 HH:MM:SS 字符串。
 *
 * @param totalSeconds - 剩余总秒数
 * @returns 形如 "04:23:15" 的字符串
 */
function formatCountdown(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  // padStart 确保每段至少 2 位（如 "04" 而非 "4"）
  return [hours, minutes, seconds]
    .map(n => String(n).padStart(2, '0'))
    .join(':')
}

/**
 * RateLimitBanner 组件 —— 速率限制提示横幅。
 *
 * 渲染逻辑：
 *  - 默认隐藏，收到 'codex:rate-limit' 事件后显示
 *  - 倒计时每秒递减，归零后自动隐藏（返回 null）
 *  - 用户可点击 × 按钮手动关闭（visible 设为 false）
 *
 * 副作用：
 *  - 挂载 setInterval(1s) 递减剩余秒数
 *  - 挂载 window 'codex:rate-limit' 事件监听器
 *  - 卸载时自动 clearInterval + removeEventListener
 */
export function RateLimitBanner() {
  // D1: 默认隐藏，监听 'codex:rate-limit' 事件后显示
  const [visible, setVisible] = useState(false)
  // 剩余秒数（每秒递减，mock 倒计时）
  const [remaining, setRemaining] = useState(INITIAL_REMAINING_SECONDS)

  // 倒计时定时器：每秒递减 1 秒，归零后自动清除（仅可见时计时）
  useEffect(() => {
    if (!visible) return
    const timer = setInterval(() => {
      setRemaining(prev => Math.max(0, prev - 1))
    }, 1000)
    return () => clearInterval(timer)
  }, [visible])

  // D1: 监听 'codex:rate-limit' 自定义事件，收到时显示横幅并重置倒计时
  useEffect(() => {
    const handleRateLimit = (e: Event) => {
      const detail = (e as CustomEvent<RateLimitEventDetail>).detail
      // 事件携带 resetSeconds 时使用，否则保持当前 remaining（或回退到默认值）
      if (detail?.resetSeconds !== undefined && detail.resetSeconds > 0) {
        setRemaining(detail.resetSeconds)
      } else if (remaining === 0) {
        setRemaining(INITIAL_REMAINING_SECONDS)
      }
      setVisible(true)
    }
    window.addEventListener('codex:rate-limit', handleRateLimit as EventListener)
    return () => {
      window.removeEventListener(
        'codex:rate-limit',
        handleRateLimit as EventListener
      )
    }
  }, [remaining])

  // 关闭后或倒计时归零时不渲染（避免空行占位）
  if (!visible || remaining === 0) return null

  return (
    // P0 修复（对齐原型 .thread-status-bar）：
    //   - padding 12px 4px → 24px 7px（px-6 py-[7px]）
    //   - 背景 bg-elev → linear-gradient(180deg, bg-elev 0%, bg 100%)
    //   - 补 font-mono text-[11px] text-[var(--text-faint)]（原型 font-family/size/color）
    <div className="flex justify-end border-b border-[var(--border)] bg-[linear-gradient(180deg,var(--bg-elev)_0%,var(--bg)_100%)] px-6 py-[7px] font-mono text-[11px] text-[var(--text-faint)]">
      {/* 速率限制 pill（参考 .tsb-rate） */}
      {/* P0 修复（对齐原型 .tsb-rate）：
           - padding 10px 2px → 9px 2px（px-[9px] py-0.5）
           - 补 flex-shrink-0（原型 flex-shrink:0） */}
      <div className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-[10px] border border-[var(--border)] bg-[var(--bg-elev-2)] px-[9px] py-0.5 text-[11px] text-[var(--warn)]">
        {/* 警告图标（参考原型 SVG：14x14 三角形感叹号，stroke-width 2） */}
        <AlertTriangle className="size-3.5 flex-shrink-0" strokeWidth={2} />
        {/* 提示文案 + 倒计时（参考 .rate-banner-text） */}
        {/* P0 修复：文案补"已达到"前缀 + "重置"后缀（对齐原型 HTML 文案） */}
        {/* P0 修复：倒计时用 <strong> 包裹（对齐原型 <strong id="rateResetsIn">） */}
        <span>
          已达到 5h 速率限制 · 剩余{' '}
          <strong className="font-bold text-[var(--warn)]">
            {formatCountdown(remaining)}
          </strong>{' '}
          重置
        </span>
        {/* 关闭按钮（参考 .rate-banner-close） */}
        {/* P0 修复：X 图标 stroke-width 2 → 2.5（对齐原型 SVG stroke-width="2.5"） */}
        <button
          type="button"
          onClick={() => setVisible(false)}
          aria-label="关闭速率限制提示"
          title="关闭提示"
          className="flex size-4 flex-shrink-0 items-center justify-center rounded border-none bg-transparent text-[var(--warn)] cursor-pointer transition-colors hover:bg-[rgba(255,180,84,0.15)]"
        >
          <X className="size-3" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  )
}
