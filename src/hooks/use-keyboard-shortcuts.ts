import { useEffect } from 'react'
import type { CommandContext } from '@/lib/commands/types'
import { executeCommand } from '@/lib/commands/registry'
import { useDialogStore } from '@/store/dialog-store'
import { useViewStore } from '@/store/view-store'
import { logger } from '@/lib/logger'

/**
 * 判断当前焦点是否在输入框或文本域中。
 *
 * 用于阻止 ? 等字符快捷键在用户输入时意外触发。
 */
function isInputFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  // isContentEditable 是 HTMLElement 的属性，需要类型断言
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable
}

/**
 * 处理应用全局键盘快捷键。
 *
 * 所有快捷键统一通过中央命令系统的 `executeCommand()` 派发，
 * 从而保证快捷键、命令面板、菜单三者的行为完全一致。
 *
 * 当前覆盖的快捷键清单：
 * - Cmd/Ctrl+P : 切换命令面板（与 ⌘K 等价，对齐帮助面板声明）
 * - Cmd/Ctrl+K : 切换命令面板
 * - Cmd/Ctrl+, : 打开偏好设置
 * - Cmd/Ctrl+N : 新建会话（路由到 codex.newThread 命令）
 * - Cmd/Ctrl+F : 打开文件模糊搜索弹窗（仅当 composer 未聚焦时触发，对齐原型 ⌘F）
 * - Cmd/Ctrl+1 : 切换左侧栏
 * - Cmd/Ctrl+2 : 切换右侧栏
 * - Cmd/Ctrl+B : 切换左侧栏（与 ⌘1 等价，常见 IDE 习惯）
 * - Cmd/Ctrl+J : 切换右侧栏（与 ⌘2 等价，常见 IDE 习惯）
 * - Cmd/Ctrl+\ : 切换左侧栏（备选，与 ⌘B/⌘1 等价）
 * - Alt+1      : 切换到 chat 视图（对齐原型 switchView）
 * - Alt+2      : 切换到 config 视图
 * - Alt+3      : 切换到 remote 视图
 * - Alt+←      : 后退到上一个视图（对齐原型 backBtn）
 * - ? / F1     : 打开快捷键帮助
 */
export function useKeyboardShortcuts(commandContext: CommandContext) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 弹窗打开时，除 Esc（由各弹窗自行处理）外不触发应用快捷键。
      // inert 属性仅阻止背景的鼠标 / 焦点交互，不影响 document 级 keydown 监听器，
      // 因此必须在此显式检查弹窗状态，防止快捷键在弹窗打开时穿透触发。
      const d = useDialogStore.getState()
      const anyDialogOpen = d.commandPaletteOpen || d.preferencesOpen || d.loginOpen ||
        d.accountOpen || d.aboutOpen || d.shortcutHelpOpen ||
        d.fuzzySearchOpen || d.feedbackOpen || d.updateOpen
      if (anyDialogOpen) return

      // ===== Alt 修饰键快捷键（视图切换 + 后退）=====
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        // 输入框中 Alt+数字可能用于输入特殊字符，不触发视图切换
        if (isInputFocused()) return
        const viewStore = useViewStore.getState()
        switch (e.key) {
          // Alt+1 — 切换到 chat 视图
          case '1':
            e.preventDefault()
            viewStore.switchView('chat', true)
            return
          // Alt+2 — 切换到 config 视图
          case '2':
            e.preventDefault()
            viewStore.switchView('config', true)
            return
          // Alt+3 — 切换到 remote 视图
          case '3':
            e.preventDefault()
            viewStore.switchView('remote', true)
            return
          // Alt+← — 后退到上一个视图（对齐原型 backBtn）
          case 'ArrowLeft':
            e.preventDefault()
            viewStore.goBack()
            return
        }
        return
      }

      // ===== 修饰键快捷键（Cmd/Ctrl + 字母/符号） =====
      if (e.metaKey || e.ctrlKey) {
        let commandId: string | null = null

        switch (e.key.toLowerCase()) {
          // ⌘K / ⌘P — 打开命令面板（两个快捷键等价，对齐帮助面板声明）
          case 'k':
          case 'p':
            commandId = 'toggle-command-palette'
            break
          case ',':
            commandId = 'open-preferences'
            break
          // ⌘N — 新建会话（路由到 codex.newThread 命令，复用命令系统的创建逻辑）
          case 'n':
            commandId = 'codex.newThread'
            break
          // ⌘F — 打开文件模糊搜索弹窗（仅当 composer 未聚焦时触发，对齐原型 ⌘F）
          // 注意：当输入框聚焦时，⌘F 交给浏览器原生搜索或对话内搜索（ConversationArea 的 Ctrl+F）
          case 'f':
            if (!isInputFocused()) {
              e.preventDefault()
              useDialogStore.getState().setFuzzySearchOpen(true)
            }
            return
          // ⌘1 / ⌘B / ⌘\ — 切换左侧栏（三个快捷键等价，⌘B/⌘\ 为常见 IDE 习惯）
          case '1':
          case 'b':
          case '\\':
            commandId = 'toggle-left-sidebar'
            break
          // ⌘2 / ⌘J — 切换右侧栏（两个快捷键等价，⌘J 为常见 IDE 习惯）
          case '2':
          case 'j':
            commandId = 'toggle-right-sidebar'
            break
        }

        if (commandId) {
          e.preventDefault()
          executeCommand(commandId, commandContext).then(result => {
            if (!result.success && result.error) {
              logger.warn('Keyboard shortcut command failed', {
                commandId,
                error: result.error,
              })
            }
          })
        }
        return
      }

      // ===== 无修饰键快捷键 =====

      // ? 键 — 打开快捷键帮助（在输入框中不触发，避免影响打字）
      if (e.key === '?' && !isInputFocused()) {
        e.preventDefault()
        useDialogStore.getState().setShortcutHelpOpen(true)
        return
      }

      // F1 键 — 打开快捷键帮助（浏览器默认帮助页被阻止）
      if (e.key === 'F1') {
        e.preventDefault()
        useDialogStore.getState().setShortcutHelpOpen(true)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [commandContext])
}
