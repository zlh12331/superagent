/**
 * @file 移动端检测 hook。
 *
 * 职责：根据视口宽度判断应用是否运行在移动端（窄屏）布局，
 *   供 UI 组件按需切换桌面/移动端交互（如 Sidebar 折叠、Toolbar 简化）。
 *
 * 设计要点：
 *  - 使用 window.matchMedia 而非 resize 事件，避免频繁触发回调；
 *  - 惰性初始化 state，SSR 安全（typeof window 检查）；
 *  - effect 中订阅媒体查询的 change 事件，仅在断点跨越时通知，性能更优。
 */

import * as React from 'react'

/**
 * 移动端断点（px）。
 * 视口宽度 < 768 时判定为移动端，与 Tailwind 默认 md 断点（768px）对齐。
 */
const MOBILE_BREAKPOINT = 768

/**
 * 检测当前视口是否为移动端宽度。
 *
 * 实现：
 *  1. 惰性初始化：基于 `window.innerWidth` 与 `MOBILE_BREAKPOINT` 比较，
 *     避免 SSR 环境（无 window）下抛错；
 *  2. 通过 `window.matchMedia('(max-width: 767px)')` 订阅断点变化，
 *     仅在跨越 768px 时触发回调，性能优于监听 resize 事件。
 *
 * @returns boolean —— true 表示当前视口为移动端宽度
 *
 * @example
 * const isMobile = useIsMobile()
 * return isMobile ? <MobileLayout /> : <DesktopLayout />
 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT
  )

  React.useEffect(() => {
    // matchMedia 在视口跨越断点时才触发回调，
    // 比 resize 事件高效（resize 每像素变化都会触发）。
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(mql.matches)
    }
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
