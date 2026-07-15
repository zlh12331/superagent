import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useCommandContext } from './use-command-context'
import { useKeyboardShortcuts } from './use-keyboard-shortcuts'
import { useUIStore } from '@/store/ui-store'
import { logger } from '@/lib/logger'

/**
 * 主窗口事件监听器 —— 处理全局键盘快捷键和跨窗口事件。
 *
 * 本 hook 组合了针对不同事件类型的专用 hook：
 * - useKeyboardShortcuts：全局键盘快捷键（Cmd+, Cmd+1, Cmd+2）
 * - Quick pane submit 监听器：来自 quick pane 的跨窗口通信
 *
 * 采用 isMounted 守卫模式：
 * 若监听器注册完成前组件已卸载，立即调用 unlisten 释放资源，
 * 避免 StrictMode 双挂载下的监听器泄漏。
 *
 * 副作用：
 *  - 注册 Tauri 事件监听器（quick-pane-submit）
 *  - 卸载时调用 unlisten 释放资源
 *
 * 使用场景：仅在根组件（App.tsx）顶层调用一次，统一管理主窗口事件。
 *
 * @see src/hooks/use-keyboard-shortcuts.ts — 键盘快捷键子 hook
 * @see src/hooks/use-command-context.ts — 命令上下文获取
 * @see src/store/ui-store.ts — setLastQuickPaneEntry 写入的 store
 */
export function useMainWindowEventListeners() {
  const commandContext = useCommandContext()

  useKeyboardShortcuts(commandContext)

  // 监听 quick pane 提交（跨窗口事件）
  useEffect(() => {
    let isMounted = true
    let unlisten: (() => void) | null = null

    listen<{ text: string }>('quick-pane-submit', event => {
      logger.debug('Quick pane submit event received', {
        text: event.payload.text,
      })
      const { setLastQuickPaneEntry } = useUIStore.getState()
      setLastQuickPaneEntry(event.payload.text)
    })
      .then(unlistenFn => {
        if (!isMounted) {
          unlistenFn()
        } else {
          unlisten = unlistenFn
        }
      })
      .catch(error => {
        logger.error('Failed to setup quick-pane-submit listener', { error })
      })

    return () => {
      isMounted = false
      if (unlisten) {
        unlisten()
      }
    }
  }, [])
}
