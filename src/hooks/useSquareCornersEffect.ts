import { useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useUIStore, type UIState } from '@/store/ui-store'
import { usePlatform } from './use-platform'
import { isTauri } from '@/lib/env'

/**
 * 根据平台和全屏状态管理方角/圆角。
 *
 * 规则：
 * - macOS：始终圆角（由 OS 处理窗口圆角）
 * - Windows：全屏时方角（屏幕边缘无需圆角）
 * - Linux：全屏时方角
 *
 * 架构：本 hook 更新 Zustand store 中的 `squareCorners` 布尔值（纯状态）。
 * 下方独立的 effect 订阅该状态并同步到 DOM，保持 store 无副作用。
 *
 * 浏览器环境兼容：getCurrentWindow() 依赖 window.__TAURI_INTERNALS__.metadata，
 * 在非 Tauri 环境下该内部对象为 undefined，直接调用会抛
 * "Cannot read properties of undefined (reading 'metadata')" 导致整个 React 树崩溃。
 * 因此浏览器开发模式下直接保持圆角（false），跳过 Tauri API 调用。
 *
 * 副作用：
 *  - 订阅窗口 onResized 事件
 *  - 切换 document.documentElement 的 'square-corners' CSS class
 *
 * @see src/store/ui-store.ts — squareCorners 状态存放处
 * @see src/hooks/use-platform.ts — 平台检测
 * @see @tauri-apps/api/window — getCurrentWindow / onResized API
 */
export function useSquareCornersEffect() {
  const platform = usePlatform()
  const setSquareCorners = useUIStore(
    (state: UIState) => state.setSquareCorners
  )

  // 根据平台/全屏状态变化更新 store 状态。
  useEffect(() => {
    // macOS 通过 windowEffects 始终保持圆角
    if (platform === 'macos') {
      setSquareCorners(false)
      return
    }

    // 浏览器环境（非 Tauri）：getCurrentWindow() 会崩溃，保持圆角即可
    if (!isTauri()) {
      setSquareCorners(false)
      return
    }

    let cancelled = false
    const window = getCurrentWindow()

    const updateCorners = async () => {
      const isFullscreen = await window.isFullscreen()
      if (cancelled) return
      // Windows/Linux：仅在全屏时启用方角
      setSquareCorners(isFullscreen)
    }

    // 检查初始状态
    void updateCorners()

    // 监听窗口状态变化
    const unlisten = window.onResized(() => {
      if (cancelled) return
      void updateCorners()
    })

    return () => {
      cancelled = true
      void unlisten.then(fn => fn())
    }
  }, [platform, setSquareCorners])

  // 将 `squareCorners` store 状态同步到 DOM。
  // 这样保持 store 纯净（setter 中不做 DOM 操作）。
  const squareCorners = useUIStore((state: UIState) => state.squareCorners)
  useEffect(() => {
    document.documentElement.classList.toggle('square-corners', squareCorners)
  }, [squareCorners])
}
