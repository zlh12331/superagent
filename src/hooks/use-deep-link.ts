import { useEffect } from 'react'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { useDialogStore } from '@/store/dialog-store'
import { logger } from '@/lib/logger'

/** 支持的 deep link 路由，映射到 UI action。 */
type DeepLinkRoute = 'preferences' | 'command-palette'

/**
 * 解析 deep link URL 并提取路由。
 *
 * 像 `tauri-app://preferences` 这样的自定义 URL scheme 将路由放在
 * hostname 而非 pathname，因此先剥离 scheme 前缀，再提取第一段 path
 * 作为路由，以保证健壮性。
 *
 * @returns 匹配到的路由；若 URL 未识别则返回 null。
 *
 * @example
 * parseDeepLinkUrl('tauri-app://preferences')      // → 'preferences'
 * parseDeepLinkUrl('tauri-app://preferences/')     // → 'preferences'
 * parseDeepLinkUrl('tauri-app://command-palette')  // → 'command-palette'
 * parseDeepLinkUrl('tauri-app://unknown')          // → null
 */
function parseDeepLinkUrl(url: string): DeepLinkRoute | null {
  // 剥离 scheme 前缀（例如 "tauri-app://preferences/" → "preferences/"）
  const withoutScheme = url.replace(/^[^:]+:\/\/?/, '')
  // 提取第一段 path（例如 "preferences/" → "preferences"）
  const route = withoutScheme.split('/')[0]
  if (route === 'preferences' || route === 'command-palette') {
    return route
  }
  if (route) {
    logger.warn('Unknown deep link route', { url, route })
  }
  return null
}

/**
 * 通过更新 dialog store 跳转到指定路由。
 *
 * 使用 useDialogStore.getState() 直接读取 store 而非订阅，
 * 适用于事件回调中的一次性命令式调用（非 React 渲染周期）。
 *
 * @param route - 解析得到的路由标识
 */
function navigateToRoute(route: DeepLinkRoute): void {
  const { setPreferencesOpen, setCommandPaletteOpen } =
    useDialogStore.getState()
  switch (route) {
    case 'preferences':
      setPreferencesOpen(true)
      break
    case 'command-palette':
      setCommandPaletteOpen(true)
      break
  }
}

/**
 * Deep link hook —— 监听 `tauri-app://` URL 并据此导航。
 *
 * 挂载时：
 * 1. 检查应用是否通过 deep link 启动（`getCurrent`）
 * 2. 注册 `onOpenUrl` 监听器以接收后续 deep link 事件
 *
 * Rust 后端负责显示/聚焦主窗口；本 hook 负责前端侧导航，
 * 通过更新 Zustand dialog store 实现。
 *
 * 支持的路由：
 * - `tauri-app://preferences` → 打开偏好设置对话框
 * - `tauri-app://command-palette` → 打开命令面板
 *
 * 副作用：
 *  - 注册 deep link 监听器（onOpenUrl）
 *  - 组件卸载时调用 unlisten 释放资源
 *
 * @see @tauri-apps/plugin-deep-link — Tauri deep link 插件
 * @see src/store/dialog-store.ts — 通过 setPreferencesOpen/setCommandPaletteOpen 导航
 */
export function useDeepLink(): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined
    // cancelled flag：防止 async 监听器注册未完成时组件已卸载导致 unlisten 泄漏
    // - 若 onOpenUrl 在组件卸载后才 resolve，此时 cancelled=true，
    //   立即调用返回的 unlisten 释放刚注册的监听器
    let cancelled = false

    void (async () => {
      // 检查应用是否通过 deep link 启动
      try {
        const startUrls = await getCurrent()
        // 组件卸载后不再处理 —— 避免对已卸载组件触发状态更新
        if (cancelled) return
        const firstUrl = startUrls?.[0]
        if (firstUrl) {
          const route = parseDeepLinkUrl(firstUrl)
          if (route) {
            navigateToRoute(route)
          }
        }
      } catch (error) {
        logger.warn('Failed to get initial deep link', { error })
      }

      // 监听后续的 deep link 事件
      try {
        const unlistenFn = await onOpenUrl(urls => {
          for (const url of urls) {
            const route = parseDeepLinkUrl(url)
            if (route) {
              navigateToRoute(route)
            }
          }
        })
        if (cancelled) {
          // 组件已卸载 —— 立即释放刚注册的监听器，避免泄漏
          unlistenFn()
        } else {
          unlisten = unlistenFn
        }
      } catch (error) {
        logger.warn('Failed to register deep link listener', { error })
      }
    })()

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
}
